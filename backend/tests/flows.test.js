// 流程端到端：嵌入式 PG + 种子 + 真实 HTTP，覆盖
// 串行 / 条件分支 / 会签 / 或签 / 退回重提留痕 / 触发条件 / 换流程（在途按旧版走完）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';

process.env.JIMU_PG_PORT = '54403';
process.env.JIMU_PG_DB = 'jimu_flow_e2e';
process.env.DATABASE_URL = `postgres://jimu:jimu@127.0.0.1:${process.env.JIMU_PG_PORT}/${process.env.JIMU_PG_DB}`;
process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), 'jimu-flow-up-'));
process.env.CACHE_TTL = '0';

const { startTestPg } = await import('./helpers/embedded-pg.js');
const pg = await startTestPg();
const { pool } = await import('../src/db.js');
await pool.query('SELECT 1');
const { runSeed } = await import('../src/seed.js');
await runSeed();
const { createApp, prepareStorage } = await import('../src/app.js');
await prepareStorage();
const server = createApp().listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const BASE = `http://127.0.0.1:${server.address().port}/api`;

async function call(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

let appId;
let formA; // 串行+分支+会签；formB 或签；formC 触发条件
let formB;
let formC;

const flowA = (threshold = 10000) => ({
  name: '报销审批流',
  trigger_rule: null,
  definition: { nodes: [
    { key: 'start', type: 'start', next: 'c_amt' },
    { key: 'c_amt', type: 'condition', name: '金额分支', branches: [
      { label: `金额超过 ${threshold / 10000} 万`, logic: 'and',
        conditions: [{ field: 'f_amount', op: 'gt', value: threshold }], next: 'n_boss' },
    ], defaultNext: 'n_fin' },
    { key: 'n_boss', type: 'approval', name: '总监审批', mode: 'all',
      approvers: [{ type: 'user', value: 'u_sun' }], next: 'n_fin' },
    { key: 'n_fin', type: 'approval', name: '财务会签', mode: 'all',
      approvers: [{ type: 'user', value: 'u_zhou' }, { type: 'user', value: 'u_wudi' }], next: 'end' },
    { key: 'end', type: 'end' },
  ] },
});

async function createForm(name) {
  const r = await call('POST', '/forms', {
    app_id: appId, name,
    field_schema: [
      { key: 'f_amount', type: 'number', label: '金额', required: true, unit: '元', min: 0, max: 99999999, validateMessage: '' },
      { key: 'f_note', type: 'textarea', label: '说明', required: false, maxLength: 500, validateMessage: '' },
    ],
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
}

async function publishFlowFor(formId, payload) {
  const draft = await call('PUT', `/flows/form/${formId}/draft`, payload);
  assert.equal(draft.status, 200, JSON.stringify(draft.json));
  const pub = await call('POST', `/flows/${draft.json.id}/publish`);
  assert.equal(pub.status, 200, JSON.stringify(pub.json));
  return pub.json;
}

async function taskOf(instanceId, assignee) {
  const d = await call('GET', `/instances/${instanceId}`);
  return d.json.pending_tasks.find((t) => t.assignee === assignee) || null;
}

before(async () => {
  const apps = await call('GET', '/apps');
  appId = apps.json[0].id;
  formA = await createForm('流程测试-会签单');
  formB = await createForm('流程测试-或签单');
  formC = await createForm('流程测试-触发单');
  await publishFlowFor(formA.id, flowA());
  await publishFlowFor(formB.id, {
    name: '或签流', trigger_rule: null,
    definition: { nodes: [
      { key: 'start', type: 'start', next: 'n1' },
      { key: 'n1', type: 'approval', name: '主管或签', mode: 'any',
        approvers: [{ type: 'user', value: 'u_wang' }, { type: 'user', value: 'u_zhao' }], next: 'end' },
      { key: 'end', type: 'end' },
    ] },
  });
  await publishFlowFor(formC.id, {
    name: '条件触发流', trigger_rule: { field: 'f_amount', op: 'gt', value: 100 },
    definition: { nodes: [
      { key: 'start', type: 'start', next: 'n1' },
      { key: 'n1', type: 'approval', name: '主管审批', mode: 'all',
        approvers: [{ type: 'user', value: 'u_wang' }], next: 'end' },
      { key: 'end', type: 'end' },
    ] },
  });
});

after(async () => {
  server.close();
  await pool.end();
  await pg.stop();
});

test('同表单一生效一草稿：列表约束与非法定义拦截', async () => {
  const list = await call('GET', `/flows?formId=${formA.id}`);
  assert.equal(list.json.filter((f) => f.status === 'published').length, 1);
  // 非法定义（审批节点没人）保存草稿 400
  const bad = await call('PUT', `/flows/form/${formA.id}/draft`, {
    name: '坏流程', definition: { nodes: [
      { key: 'start', type: 'start', next: 'n1' },
      { key: 'n1', type: 'approval', name: '空节点', approvers: [], next: 'end' },
      { key: 'end', type: 'end' },
    ] },
  });
  assert.equal(bad.status, 400);
  assert.ok(/审批人/.test(bad.json.message));
});

test('小额：不经总监，财务两人会签全部通过才结束', async () => {
  const sub = await call('POST', '/submissions', { form_id: formA.id, created_by: 'u_chen', data: { f_amount: 5000, f_note: '小额报销' } });
  assert.equal(sub.status, 201);
  const iid = sub.json.instance_id;
  assert.ok(iid);

  let detail = await call('GET', `/instances/${iid}`);
  assert.equal(detail.json.current_node_name, '财务会签');
  assert.deepEqual(detail.json.pending_tasks.map((t) => t.assignee).sort(), ['u_wudi', 'u_zhou']);
  assert.ok(detail.json.waiting_seconds >= 0);

  // 待办列表
  const todo = await call('GET', '/instances/tasks/todo?assignee=u_zhou');
  assert.ok(todo.json.some((t) => t.instance_id === iid));

  const t1 = await taskOf(iid, 'u_zhou');
  const a1 = await call('POST', `/instances/tasks/${t1.id}/approve`, { actor: 'u_zhou', comment: '出纳通过' });
  assert.equal(a1.status, 200);
  // 一人签完仍停在会签节点
  detail = await call('GET', `/instances/${iid}`);
  assert.equal(detail.json.status, 'running');
  assert.deepEqual(detail.json.pending_tasks.map((t) => t.assignee), ['u_wudi']);
  // 重复处理同一条待办 → 409
  const again = await call('POST', `/instances/tasks/${t1.id}/approve`, { actor: 'u_zhou' });
  assert.equal(again.status, 409);

  const t2 = await taskOf(iid, 'u_wudi');
  await call('POST', `/instances/tasks/${t2.id}/approve`, { actor: 'u_wudi', comment: '复核通过' });
  detail = await call('GET', `/instances/${iid}`);
  assert.equal(detail.json.status, 'approved');
  assert.ok(detail.json.events.some((e) => e.action === 'route' && /默认/.test(e.comment)));
});

test('大额→退回发起人→改完重提从头走，修改逐字段留痕（改前改后都在）', async () => {
  const sub = await call('POST', '/submissions', { form_id: formA.id, created_by: 'u_han', data: { f_amount: 20000, f_note: '初版说明' } });
  const iid = sub.json.instance_id;
  assert.equal((await call('GET', `/instances/${iid}`)).json.current_node_name, '总监审批');

  const boss = await taskOf(iid, 'u_sun');
  await call('POST', `/instances/tasks/${boss.id}/approve`, { actor: 'u_sun' });
  const fin = await taskOf(iid, 'u_zhou');
  // 退回必须允许带意见；无意见也允许（接口层不强制），这里给明确意见
  const ret = await call('POST', `/instances/tasks/${fin.id}/return`, { actor: 'u_zhou', comment: '说明不清，请补充' });
  assert.equal(ret.status, 200);
  let detail = await call('GET', `/instances/${iid}`);
  assert.equal(detail.json.status, 'returned');
  assert.equal(detail.json.return_comment, '说明不清，请补充');
  assert.equal(detail.json.pending_tasks.length, 0);
  // 已取消的待办不能再审批
  const stale = await call('POST', `/instances/tasks/${fin.id}/approve`, { actor: 'u_zhou' });
  assert.equal(stale.status, 409);

  // 原封不动重提 → 400
  const noChange = await call('PUT', `/submissions/${sub.json.id}/resubmit`, { created_by: 'u_han', data: { f_amount: 20000, f_note: '初版说明' } });
  assert.equal(noChange.status, 400);

  // 改说明后重提：从第一个节点重新走（总监，因为金额仍 >1 万），轮次 +1
  const rs = await call('PUT', `/submissions/${sub.json.id}/resubmit`, { created_by: 'u_han', data: { f_amount: 20000, f_note: '补充后的详细说明' } });
  assert.equal(rs.status, 200, JSON.stringify(rs.json));
  assert.equal(rs.json.round, 2);
  assert.equal(rs.json.changes.length, 1);
  assert.equal(rs.json.changes[0].label, '说明');

  detail = await call('GET', `/instances/${iid}`);
  assert.equal(detail.json.status, 'running');
  assert.equal(detail.json.round, 2);
  assert.equal(detail.json.current_node_name, '总监审批');
  assert.equal(detail.json.revisions.length, 1);
  const rv = detail.json.revisions[0];
  assert.equal(rv.changes[0].before, '初版说明');
  assert.equal(rv.changes[0].after, '补充后的详细说明');
  assert.deepEqual(rv.before_data.f_note, '初版说明');   // 改前完整快照
  assert.deepEqual(rv.after_data.f_note, '补充后的详细说明'); // 改后完整快照

  // 第 2 轮走完
  const boss2 = await taskOf(iid, 'u_sun');
  await call('POST', `/instances/tasks/${boss2.id}/approve`, { actor: 'u_sun' });
  for (const who of ['u_zhou', 'u_wudi']) {
    const t = await taskOf(iid, who);
    const r = await call('POST', `/instances/tasks/${t.id}/approve`, { actor: who });
    assert.equal(r.status, 200);
  }
  detail = await call('GET', `/instances/${iid}`);
  assert.equal(detail.json.status, 'approved');
  // 第 1 轮退回记录仍保留在时间线
  assert.ok(detail.json.events.some((e) => e.action === 'return'));
  assert.ok(detail.json.events.filter((e) => e.action === 'approve').length >= 4);
});

test('或签：任一人通过即推进，其余待办失效', async () => {
  const sub = await call('POST', '/submissions', { form_id: formB.id, created_by: 'u_lilei', data: { f_amount: 1, f_note: '' } });
  const iid = sub.json.instance_id;
  const wang = await taskOf(iid, 'u_wang');
  await call('POST', `/instances/tasks/${wang.id}/approve`, { actor: 'u_wang' });
  const detail = await call('GET', `/instances/${iid}`);
  assert.equal(detail.json.status, 'approved');
  const zhao = detail.json.tasks.find((t) => t.assignee === 'u_zhao');
  assert.equal(zhao.status, 'cancelled');
});

test('触发条件：不满足不发起流程，满足才发起', async () => {
  const small = await call('POST', '/submissions', { form_id: formC.id, created_by: 'u_chen', data: { f_amount: 50, f_note: '' } });
  assert.equal(small.status, 201);
  assert.equal(small.json.instance_id, null);
  assert.equal(small.json.status, 'submitted');
  const big = await call('POST', '/submissions', { form_id: formC.id, created_by: 'u_chen', data: { f_amount: 500, f_note: '' } });
  assert.ok(big.json.instance_id);
});

test('换流程：重新发布后在途单据按旧版走完，新提交走新版', async () => {
  // 旧版（阈值 1 万，含财务会签）下发起一单大额，总监审完停在财务会签
  const old = await call('POST', '/submissions', { form_id: formA.id, created_by: 'u_wang', data: { f_amount: 30000, f_note: '换流程前的在途单' } });
  const oldIid = old.json.instance_id;
  await call('POST', `/instances/tasks/${(await taskOf(oldIid, 'u_sun')).id}/approve`, { actor: 'u_sun' });
  let d = await call('GET', `/instances/${oldIid}`);
  assert.equal(d.json.current_node_name, '财务会签');
  const oldVersion = d.json.flow_version;

  // 发布新版：阈值提到 5 万、只留总监
  const newFlow = {
    name: '报销审批流 v2', trigger_rule: null,
    definition: { nodes: [
      { key: 'start', type: 'start', next: 'c_amt' },
      { key: 'c_amt', type: 'condition', name: '金额分支', branches: [
        { label: '金额超过 5 万', logic: 'and',
          conditions: [{ field: 'f_amount', op: 'gt', value: 50000 }], next: 'n_boss' },
      ], defaultNext: 'end' },
      { key: 'n_boss', type: 'approval', name: '总监审批', mode: 'all',
        approvers: [{ type: 'user', value: 'u_sun' }], next: 'end' },
      { key: 'end', type: 'end' },
    ] },
  };
  await publishFlowFor(formA.id, newFlow);

  // 同表单仍只有一条生效流程
  const list = await call('GET', `/flows?formId=${formA.id}`);
  assert.equal(list.json.filter((f) => f.status === 'published').length, 1);
  assert.equal(list.json.find((f) => f.status === 'published').version, oldVersion + 1);

  // 在途单仍挂旧版快照：财务会签待办可正常处理并走完全程
  d = await call('GET', `/instances/${oldIid}`);
  assert.equal(d.json.flow_version, oldVersion);
  assert.equal(d.json.current_node_name, '财务会签');
  for (const who of ['u_zhou', 'u_wudi']) {
    const t = await taskOf(oldIid, who);
    assert.ok(t, '旧版会签待办应保留');
    await call('POST', `/instances/tasks/${t.id}/approve`, { actor: who });
  }
  d = await call('GET', `/instances/${oldIid}`);
  assert.equal(d.json.status, 'approved');

  // 新版：3 万不超过 5 万 → 无审批节点，直接通过
  const mid = await call('POST', '/submissions', { form_id: formA.id, created_by: 'u_chen', data: { f_amount: 30000, f_note: '新版小额' } });
  d = await call('GET', `/instances/${mid.json.instance_id}`);
  assert.equal(d.json.flow_version, oldVersion + 1);
  assert.equal(d.json.status, 'approved');
  assert.ok(d.json.events.some((e) => e.action === 'route' && /默认/.test(e.comment)));

  // 新版：6 万 → 总监
  const huge = await call('POST', '/submissions', { form_id: formA.id, created_by: 'u_chen', data: { f_amount: 60000, f_note: '新版大额' } });
  d = await call('GET', `/instances/${huge.json.instance_id}`);
  assert.equal(d.json.current_node_name, '总监审批');
  await call('POST', `/instances/tasks/${(await taskOf(huge.json.instance_id, 'u_sun')).id}/approve`, { actor: 'u_sun' });
  d = await call('GET', `/instances/${huge.json.instance_id}`);
  assert.equal(d.json.status, 'approved');
});

test('实例列表：状态/当前节点/待办人/停留时长齐全', async () => {
  const r = await call('GET', `/instances?formId=${formB.id}`);
  assert.equal(r.status, 200);
  assert.ok(r.json.length >= 1);
  for (const x of r.json) {
    assert.ok(['running', 'approved', 'returned'].includes(x.status));
    if (x.status === 'running') {
      assert.ok(x.current_node_name);
      assert.ok(x.pending_tasks.length >= 1);
      assert.equal(typeof x.waiting_seconds, 'number');
    }
  }
});
