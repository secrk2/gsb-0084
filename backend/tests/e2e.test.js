// 端到端：嵌入式 PostgreSQL + 种子 + 真实 HTTP 接口
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';

process.env.JIMU_PG_PORT = '54401';
process.env.JIMU_PG_DB = 'jimu_e2e';
process.env.DATABASE_URL = `postgres://jimu:jimu@127.0.0.1:${process.env.JIMU_PG_PORT}/${process.env.JIMU_PG_DB}`;
process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), 'jimu-up-'));
process.env.CACHE_TTL = '0'; // 不依赖 Redis

const { startTestPg } = await import('./helpers/embedded-pg.js');
const pg = await startTestPg();

// 建库后再导入应用模块（Pool 在连接时才实际握手）
const { pool } = await import('../src/db.js');
await pool.query('SELECT 1'); // 确认目标库存在（embedded createDatabase 已建）

const { runSeed } = await import('../src/seed.js');
const seedResult = await runSeed();
const { createApp, prepareStorage } = await import('../src/app.js');
await prepareStorage();

const server = createApp().listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const port = server.address().port;
const BASE = `http://127.0.0.1:${port}/api`;

async function call(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

after(async () => {
  server.close();
  await pool.end();
  await pg.stop();
});

test('种子：3 应用 / 5 表单 / 30 提交', () => {
  assert.equal(seedResult.appIds.length, 3);
  assert.equal(seedResult.formIds.length, 5);
  assert.equal(seedResult.totalSubmissions, 30);
});

test('应用动态：KPI 与校验失败热点', async () => {
  const { status, json } = await call('GET', '/activity/overview');
  assert.equal(status, 200);
  assert.equal(json.app_count, 3);
  assert.equal(json.form_count, 5);
  assert.equal(json.submission_count, 38); // 30 普通填报 + 8 流程场景单据
  assert.ok(json.today_submission_count >= 3, '今日应有种子提交');
  assert.ok(json.fieldHotspots.length >= 5, '应有热点字段统计');
  // 热点排序：最多的排第一，且是请假天数/订单金额这类预设热点
  assert.ok(json.fieldHotspots[0].error_count >= json.fieldHotspots[1].error_count);
  assert.equal(json.trend.length, 7);
  assert.ok(json.perAppToday.length === 3);
});

test('表单详情：包含完整字段元数据（8 类字段覆盖）', async () => {
  const { json } = await call('GET', `/forms/${seedResult.formIds[0]}`);
  const types = new Set(json.field_schema.map((f) => f.type));
  for (const t of ['text', 'select', 'number', 'date', 'textarea', 'attachment', 'subform']) {
    assert.ok(types.has(t), `请假表单应含 ${t}`);
  }
});

test('合法提交：201 且计数 +1，默认值被补齐', async () => {
  const formId = seedResult.formIds[0]; // 请假
  const before = await call('GET', '/activity/overview');
  const payload = {
    f_emp_no: '99999999',
    f_name: '端到端测试员',
    f_dept: 'tech',
    f_leave_type: 'annual',
    f_days: 2,
    f_start_date: '2026-09-20',
    f_end_date: '2026-09-22',
    f_reason: '测试用，家事处理',
    f_cert: [],
    f_handover: [],
  };
  const r = await call('POST', '/submissions', { form_id: formId, data: payload });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.data.f_days, 2);
  assert.deepEqual(r.json.data.f_handover, []);
  const after = await call('GET', '/activity/overview');
  assert.equal(after.json.submission_count, before.json.submission_count + 1);
});

test('校验失败：422 + 字段级错误（必填/范围/月精度/唯一/子表单）', async () => {
  const leaveId = seedResult.formIds[0];
  // 超范围 + 唯一冲突（工号 10012301 已在种子里）+ 缺事由
  const r1 = await call('POST', '/submissions', {
    form_id: leaveId,
    data: {
      f_emp_no: '10012301', f_name: '张三', f_dept: 'tech', f_leave_type: 'sick',
      f_days: 999, f_start_date: '2026-09-20', f_reason: '', f_cert: [], f_handover: [],
    },
  });
  assert.equal(r1.status, 422);
  const codes = r1.json.errors.map((e) => e.code);
  assert.ok(codes.includes('MAX'));
  assert.ok(codes.includes('UNIQUE'));
  assert.ok(codes.includes('REQUIRED'));
  const daysErr = r1.json.errors.find((e) => e.fieldKey === 'f_days');
  assert.match(daysErr.message, /0.5~30|不能大于 30/);

  // 月精度字段拒绝日格式（客户拜访 f_visit_month）
  const visitId = seedResult.formIds[1];
  const r2 = await call('POST', '/submissions', {
    form_id: visitId,
    data: { f_customer_name: '某全新客户A', f_industry: 'edu', f_visit_month: '2026-09-01', f_score: 4, f_contacts: [], f_note: '', f_products: [] },
  });
  assert.equal(r2.status, 422);
  assert.ok(r2.json.errors.some((e) => e.fieldKey === 'f_visit_month'));

  // 子表单错误定位到行
  const materialId = seedResult.formIds[4];
  const r3 = await call('POST', '/submissions', {
    form_id: materialId,
    data: {
      f_applicant: '李四', f_m_dept: 'hr', f_apply_month: '2026-09', f_expect_date: null, f_remark: '',
      f_items: [{ f_material_name: '电脑', f_m_qty: 0, f_usage: '' }],
    },
  });
  assert.equal(r3.status, 422);
  const subErr = r3.json.errors.find((e) => e.fieldKey === 'f_items.f_m_qty');
  assert.ok(subErr);
  assert.deepEqual(subErr.path, ['f_items', 0, 'f_m_qty']);
  // 该字段配置了自定义校验提示，优先展示自定义文案
  assert.equal(subErr.message, '申领数量至少 1 件');

  // 失败计数反映到看板
  const ov = await call('GET', '/activity/overview');
  assert.ok(ov.json.today_error_count >= 5);
});

test('删除被引用字段：409 拦截且说明被谁引用', async () => {
  const formId = seedResult.formIds[0]; // 请假审批流引用 f_leave_type/f_days/f_dept，视图引用 f_emp_no 等
  const check = await call('POST', `/forms/${formId}/fields/check-delete`, { path: 'f_days' });
  assert.equal(check.status, 200);
  assert.equal(check.json.blocked, true);
  assert.ok(check.json.references.some((r) => r.kind === '流程' && /请假审批流/.test(r.reason)));
  assert.ok(check.json.references.some((r) => /f_days|请假天数/.test(r.reason)));

  const removed = await call('POST', `/forms/${formId}/fields/remove`, { path: 'f_days' });
  assert.equal(removed.status, 409);
  assert.equal(removed.json.blocked, true);
  assert.ok(removed.json.references.length >= 1);

  // 视图引用（f_emp_no 在「请假台账」列中）
  const v = await call('POST', `/forms/${formId}/fields/remove`, { path: 'f_emp_no' });
  assert.equal(v.status, 409);
  assert.ok(v.json.references.some((r) => r.kind === '视图' && /请假台账/.test(r.reason)));
});

test('删除未被引用字段：成功且 schema 中消失', async () => {
  const formId = seedResult.formIds[4]; // 物料申领：f_expect_date 没有流程/视图引用
  const r = await call('POST', `/forms/${formId}/fields/remove`, { path: 'f_expect_date' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.blocked, false);
  assert.ok(!r.json.form.field_schema.some((f) => f.key === 'f_expect_date'));
});

test('整表 PUT 覆盖也无法绕开引用拦截', async () => {
  const formId = seedResult.formIds[0];
  const { json: form } = await call('GET', `/forms/${formId}`);
  const reduced = form.field_schema.filter((f) => f.key !== 'f_dept'); // f_dept 被流程 approver + 视图 filter 引用
  const r = await call('PUT', `/forms/${formId}`, { name: form.name, field_schema: reduced });
  assert.equal(r.status, 409);
  assert.ok(r.json.references.length >= 1);
});

test('子表单子字段被引用时同样可拦截（流程条件命中点路径）', async () => {
  // 构造：给物料表单加一个引用子字段的视图，再尝试删子字段
  const formId = seedResult.formIds[4];
  await pool.query(
    `INSERT INTO form_views(app_id, form_id, name, column_fields, filter_field)
     SELECT app_id, id, '物料测试视图', $1::jsonb, NULL FROM forms WHERE id = $2`,
    [JSON.stringify(['f_items.f_material_name']), formId],
  );
  const r = await call('POST', `/forms/${formId}/fields/remove`, { path: 'f_items.f_material_name' });
  assert.equal(r.status, 409);
  assert.ok(r.json.references.some((x) => /物料测试视图/.test(x.reason)));
});

test('非法 schema 保存被拒：重复 key / 数字范围倒置', async () => {
  const formId = seedResult.formIds[4];
  const bad = [
    { key: 'same_key', type: 'text', label: 'A' },
    { key: 'same_key', type: 'text', label: 'B' },
    { key: 'n1', type: 'number', label: 'N', min: 10, max: 1 },
  ];
  const r = await call('PUT', `/forms/${formId}`, { field_schema: bad });
  assert.equal(r.status, 400);
  assert.match(r.json.message, /重复|最小值不能大于最大值/);
});
