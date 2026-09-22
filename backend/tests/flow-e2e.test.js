// 审批流端到端：嵌入式 PG + 真实 HTTP，覆盖串行/分支/会签/两种退回/改单重提/换版本/权限
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
const { runSeed } = await import('../src/seed.js');
const seed = await runSeed();
const { createApp, prepareStorage } = await import('../src/app.js');
await prepareStorage();
const server = createApp().listen(0);
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}/api`;

const LEAVE = seed.formIds[0];
const MATERIAL = seed.formIds[4];

async function call(method, url, body, actor) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (actor) headers['X-Actor'] = actor;
  const res = await fetch(BASE + url, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

const node = (id, name, extra = {}) => ({
  id, name, mode: 'serial', approver_type: 'fixed', approvers: [], field: null, ...extra,
});

// 主管 →（天数>3：总监 → HR/财务会签）/ 默认无节点
const leaveFlowV1 = [
  { kind: 'approval', node: node('n_mgr', '直属主管', { approvers: ['u10'] }) },
  { kind: 'branch', branches: [
    { label: '超过 3 天', when: { field: 'f_days', op: 'gt', value: 3 }, nodes: [
      node('n_dir', '总监', { approvers: ['u11'] }),
      node('n_cs', 'HR与财务会签', { mode: 'countersign', approvers: ['u12', 'u13'] }),
    ] },
    { label: '3 天以内', when: null, nodes: [] },
  ] },
];
// v2：门槛提高到 100 天（测试中任何单据都走默认分支）
const leaveFlowV2 = [
  { kind: 'approval', node: node('n2_mgr', '直属主管', { approvers: ['u10'] }) },
  { kind: 'branch', branches: [
    { label: '超 100 天', when: { field: 'f_days', op: 'gt', value: 100 }, nodes: [
      node('n2_boss', '老板', { approvers: ['u14'] }),
    ] },
    { label: '其他', when: null, nodes: [] },
  ] },
];

function leavePayload(over = {}) {
  return {
    f_emp_no: '55500001', f_name: '流程测试员', f_dept: 'tech', f_leave_type: 'annual',
    f_days: 2, f_start_date: '2026-09-20', f_end_date: '2026-09-21',
    f_reason: 'e2e 测试', f_cert: [], f_handover: [], ...over,
  };
}
let empSeq = 1;
async function submitLeave(over = {}, actor = 'u20') {
  const p = leavePayload({ ...over, f_emp_no: `555${String(empSeq++).padStart(5, '0')}` });
  const r = await call('POST', '/submissions', { form_id: LEAVE, data: p }, actor);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
}
const detail = (sid) => call('GET', `/instances/by-submission/${sid}`);
const currentTaskId = async (sid) => (await detail(sid)).json.current.task_ids[0];
const currentNode = async (sid) => (await detail(sid)).json.current.label;
const approve = (tid, actor = 'u10', comment = '同意') => call('POST', `/instances/tasks/${tid}/approve`, { comment }, actor);

after(async () => {
  server.close();
  await pool.end();
  await pg.stop();
});

test('准备：无流程时新单据直接收数（status=submitted）', async () => {
  // 物料表单没有挂流程
  const r = await call('POST', '/submissions', {
    form_id: MATERIAL,
    data: {
      f_applicant: '王五', f_m_dept: 'hr', f_apply_month: '2026-09', f_expect_date: null, f_remark: '',
      f_items: [{ f_material_name: '电脑', f_m_qty: 1, f_usage: '' }],
    },
  }, 'u20');
  assert.equal(r.status, 201);
  assert.equal(r.json.has_flow, false);
  assert.equal(r.json.status, 'submitted');
});

let v1FlowId = null;
test('流程定义：草稿 → 发布；同表单只有一条 active', async () => {
  const c = await call('POST', '/flows', { form_id: LEAVE, name: '请假审批流', definition: leaveFlowV1 });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  const flowId = c.json.id;
  v1FlowId = flowId;
  const p = await call('POST', `/flows/${flowId}/publish`);
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.equal(p.json.flow.status, 'active');

  // 种子里请假表的 active 流程已被顶掉归档：同表单 active 仅 1 条
  const { rows } = await pool.query(`SELECT count(*)::int c FROM flows WHERE form_id=$1 AND status='active'`, [LEAVE]);
  assert.equal(rows[0].c, 1);

  // 生效流程不可编辑
  const bad = await call('PUT', `/flows/${flowId}`, { definition: [] });
  assert.equal(bad.status, 409);

  // 半成品定义可存草稿（宽松校验），但发布时被严格校验拦下
  const c2 = await call('POST', '/flows', {
    form_id: LEAVE, name: '坏流程草稿',
    definition: [{ kind: 'approval', node: node('x', '空节点', { approvers: [] }) }],
  });
  assert.equal(c2.status, 201, JSON.stringify(c2.json));
  const pubBad = await call('POST', `/flows/${c2.json.id}/publish`);
  assert.equal(pubBad.status, 400);
  assert.ok(pubBad.json.message.includes('未指定审批人'));

  // 结构性错误（阶段类型非法）连草稿也存不了
  const c3 = await call('POST', '/flows', { form_id: LEAVE, name: '结构错', definition: [{ kind: 'weird' }] });
  assert.equal(c3.status, 400);
});

test('串行+默认分支：短假主管通过即终审', async () => {
  const s = await submitLeave({ f_days: 1 });
  assert.equal(s.has_flow, true);
  let d = (await detail(s.id)).json;
  assert.equal(d.submission.status, 'in_approval');
  assert.equal(d.current.label, '直属主管');
  assert.deepEqual(d.current.assignees, ['u10']);
  assert.ok(d.current.since, '应返回节点进入时间用于计算停留时长');

  const tid = await currentTaskId(s.id);
  const ap = await approve(tid);
  assert.equal(ap.status, 200);
  d = (await detail(s.id)).json;
  assert.equal(d.submission.status, 'approved');
  assert.equal(d.instance.status, 'approved');
});

test('条件分支+并行会签：长假走到会签，全员通过才终审', async () => {
  const s = await submitLeave({ f_days: 5 });
  await approve(await currentTaskId(s.id), 'u10');           // 主管
  assert.equal(await currentNode(s.id), '总监');
  await approve(await currentTaskId(s.id), 'u11');           // 总监
  let d = (await detail(s.id)).json;
  assert.equal(d.current.label, 'HR与财务会签');
  assert.deepEqual(d.current.assignees.sort(), ['u12', 'u13']);

  // 只有 HR 通过：仍在会签
  const hrTask = d.current.task_ids[d.current.assignees.indexOf('u12')];
  await approve(hrTask, 'u12', 'HR 同意');
  d = (await detail(s.id)).json;
  assert.equal(d.submission.status, 'in_approval');
  assert.deepEqual(d.current.assignees, ['u13']);

  // 财务通过：终审
  await approve(await currentTaskId(s.id), 'u13', '财务同意');
  d = (await detail(s.id)).json;
  assert.equal(d.submission.status, 'approved');
});

test('退回发起人：改单重提从头走，diff 留痕、历史版本可见', async () => {
  const s = await submitLeave({ f_days: 10, f_reason: '想休长假' });
  await approve(await currentTaskId(s.id), 'u10');
  // 总监退回发起人
  const dirTask = await currentTaskId(s.id);
  const ret = await call('POST', `/instances/tasks/${dirTask}/return`,
    { target: 'initiator', comment: '太长，缩短' }, 'u11');
  assert.equal(ret.status, 200);
  let d = (await detail(s.id)).json;
  assert.equal(d.submission.status, 'returned');
  assert.equal(d.current.phase, 'returned');

  // 发起人待办里能看到这条「待改单重提」
  const todo = await call('GET', '/instances/todo?assignee=u20');
  assert.ok(todo.json.some((t) => t.submission_id === s.id && t.todo_kind === 'resubmit'),
    '退回单应出现在发起人待办');

  // 非发起人不能改单重提（发起人 u20；用 u21 尝试 → 403）
  const forbidden = await call('PUT', `/submissions/${s.id}/resubmit`, { data: s2data(s, { f_days: 2 }) }, 'u21');
  assert.equal(forbidden.status, 403);

  // 非 returned 状态不能重提：对另一张在审批中的单据重提 → 409
  const other = await submitLeave({ f_days: 5 });
  const conflict = await call('PUT', `/submissions/${other.id}/resubmit`,
    { data: leavePayload({ f_days: 2 }) }, 'u20');
  assert.equal(conflict.status, 409);

  // 发起人改单重提（10 → 2，事由改）
  const ok = await call('PUT', `/submissions/${s.id}/resubmit`, {
    data: s2data(s, { f_days: 2, f_reason: '想休长假（已缩短为 2 天）' }),
  }, 'u20');
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  d = (await detail(s.id)).json;
  assert.equal(d.submission.status, 'in_approval');
  assert.equal(d.current.label, '直属主管', '重提后应从头开始');
  assert.equal(d.revisions.length, 2, '应有两个内容版本');
  const changed = d.revisions[1].change_summary.map((c) => c.path);
  assert.ok(changed.includes('f_days'));
  assert.ok(changed.includes('f_reason'));
  const daysChange = d.revisions[1].change_summary.find((c) => c.path === 'f_days');
  assert.equal(daysChange.before, '10');
  assert.equal(daysChange.after, '2');
  // 时间线里能看到退回与重提
  const actions = d.timeline.filter((t) => t.kind === 'action').map((t) => t.action);
  assert.ok(actions.includes('return_initiator'));
  assert.ok(d.timeline.some((t) => t.kind === 'revision' && t.revision === 2));

  // 主管通过 → 2 天走默认分支 → 终审
  await approve(await currentTaskId(s.id), 'u10');
  d = (await detail(s.id)).json;
  assert.equal(d.submission.status, 'approved');
});

test('退回上一节点：总监退回后主管重新审批，通过后再次到总监', async () => {
  const s = await submitLeave({ f_days: 8 });
  await approve(await currentTaskId(s.id), 'u10');
  assert.equal(await currentNode(s.id), '总监');
  const dirTask = await currentTaskId(s.id);
  const r = await call('POST', `/instances/tasks/${dirTask}/return`,
    { target: 'previous', comment: '请主管复核交接' }, 'u11');
  assert.equal(r.status, 200);
  assert.equal(await currentNode(s.id), '直属主管');
  // 原总监任务已作废，不能再操作
  const stale = await approve(dirTask, 'u11');
  assert.equal(stale.status, 409);
  // 主管再审通过 → 又到总监
  await approve(await currentTaskId(s.id), 'u10', '复核通过');
  assert.equal(await currentNode(s.id), '总监');
});

test('第一个节点不能退回上一节点（400）；非待处理人无权操作（403）；驳回为终态', async () => {
  const s = await submitLeave({ f_days: 5 });
  const tid = await currentTaskId(s.id);
  const noPrev = await call('POST', `/instances/tasks/${tid}/return`, { target: 'previous' }, 'u10');
  assert.equal(noPrev.status, 400);
  const noAuth = await approve(tid, 'u99');
  assert.equal(noAuth.status, 403);
  const rj = await call('POST', `/instances/tasks/${tid}/reject`, { comment: '不行' }, 'u10');
  assert.equal(rj.status, 200);
  const d = (await detail(s.id)).json;
  assert.equal(d.submission.status, 'rejected');
  // 终态后任务不可再操作
  const gone = await approve(tid, 'u10');
  assert.equal(gone.status, 409);
});

test('换流程：v2 发布后新单走 v2；在跑旧单仍按 v1 走（含会签）', async () => {
  // 一张长假单停在总监（v1）
  const old = await submitLeave({ f_days: 9 });
  await approve(await currentTaskId(old.id), 'u10');
  assert.equal(await currentNode(old.id), '总监');

  // 发布新版本
  const c = await call('POST', '/flows', { form_id: LEAVE, name: '请假审批流', definition: leaveFlowV2 });
  const v2FlowId = c.json.id;
  const pub = await call('POST', `/flows/${v2FlowId}/publish`);
  assert.equal(pub.status, 200);

  // 旧单详情标注所依版本已归档但仍在跑
  let d = (await detail(old.id)).json;
  assert.equal(d.flow.id, v1FlowId);
  assert.equal(d.flow.status, 'archived');
  // 旧单继续 v1：总监通过后进入会签（v2 在此数据下无会签）
  await approve(await currentTaskId(old.id), 'u11');
  assert.equal(await currentNode(old.id), 'HR与财务会签');
  await approve(await currentTaskId(old.id), 'u12');
  await approve(await currentTaskId(old.id), 'u13');
  d = (await detail(old.id)).json;
  assert.equal(d.submission.status, 'approved');

  // 新单（5 天）在新版本下主管通过即终审（5 < 100 走默认分支）
  const fresh = await submitLeave({ f_days: 5 });
  d = (await detail(fresh.id)).json;
  assert.equal(d.flow.id, v2FlowId);
  await approve(await currentTaskId(fresh.id), 'u10');
  d = (await detail(fresh.id)).json;
  assert.equal(d.submission.status, 'approved');
});

test('引用拦截：流程条件字段 f_days 不能删除', async () => {
  const r = await call('POST', `/forms/${LEAVE}/fields/remove`, { path: 'f_days' });
  assert.equal(r.status, 409);
  assert.ok(r.json.references.some((x) => x.kind === '流程' && /分支条件/.test(x.reason)));
});

// 取已提交单据当前数据并覆盖字段
function s2data(submission, over) {
  return { ...submission.data, ...over };
}
