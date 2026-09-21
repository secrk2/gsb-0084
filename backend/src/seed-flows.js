// 流程种子：4 张表单各挂一条「生效中」流程定义，并驱动出覆盖各状态的实例：
//   串行通过 / 条件分支 / 并行会签（一人已签一人待签）/ 退回后修改重提（含留痕）/
//   字段取审批人 / 触发条件不满足不发起。
import { startInstance, approveTask, returnTask, resubmitInstance } from './flow.js';
import { diffSubmission } from './flowdef.js';

// ---- 四条流程定义（节点 key 稳定，便于场景脚本引用） ----
export const FLOW_DEFS = [
  {
    formIdx: 0,
    name: '请假审批流',
    trigger_rule: { field: 'f_leave_type', op: 'not_empty' },
    nodes: [
      { key: 'start', type: 'start', next: 'n_leader' },
      { key: 'n_leader', type: 'approval', name: '部门主管审批', mode: 'all',
        approvers: [{ type: 'user', value: 'u_wang' }], next: 'c_days' },
      { key: 'c_days', type: 'condition', name: '请假天数分支',
        branches: [
          { label: '请假超过 3 天，报总监', logic: 'and',
            conditions: [{ field: 'f_days', op: 'gt', value: 3 }], next: 'n_director' },
        ], defaultNext: 'end' },
      { key: 'n_director', type: 'approval', name: '总监审批', mode: 'all',
        approvers: [{ type: 'user', value: 'u_sun' }], next: 'end' },
      { key: 'end', type: 'end' },
    ],
  },
  {
    formIdx: 1,
    name: '大客户跟进审批流',
    trigger_rule: { field: 'f_score', op: 'lt', value: 4 },
    nodes: [
      { key: 'start', type: 'start', next: 'n_sales' },
      { key: 'n_sales', type: 'approval', name: '销售主管复核', mode: 'all',
        approvers: [{ type: 'user', value: 'u_zhao' }], next: 'end' },
      { key: 'end', type: 'end' },
    ],
  },
  {
    formIdx: 2,
    name: '销售订单审批流',
    trigger_rule: { field: 'f_order_no', op: 'not_empty' },
    nodes: [
      { key: 'start', type: 'start', next: 'c_amount' },
      { key: 'c_amount', type: 'condition', name: '订单金额分支',
        branches: [
          { label: '金额超过 1 万，先报总监', logic: 'and',
            conditions: [{ field: 'f_amount', op: 'gt', value: 10000 }], next: 'n_director' },
        ], defaultNext: 'n_fin' },
      { key: 'n_director', type: 'approval', name: '总监审批', mode: 'all',
        approvers: [{ type: 'user', value: 'u_sun' }], next: 'n_fin' },
      { key: 'n_fin', type: 'approval', name: '财务会签（出纳+复核）', mode: 'all',
        approvers: [{ type: 'user', value: 'u_zhou' }, { type: 'user', value: 'u_wudi' }], next: 'end' },
      { key: 'end', type: 'end' },
    ],
  },
  {
    formIdx: 3,
    name: '巡检整改审批流',
    trigger_rule: { field: 'f_overall_score', op: 'lt', value: 80 },
    nodes: [
      { key: 'start', type: 'start', next: 'n_leader' },
      { key: 'n_leader', type: 'approval', name: '运营主管审核', mode: 'all',
        approvers: [{ type: 'user', value: 'u_zhao' }], next: 'n_inspector' },
      { key: 'n_inspector', type: 'approval', name: '巡检员现场复核', mode: 'all',
        approvers: [{ type: 'field', value: 'f_inspector' }], next: 'end' },
      { key: 'end', type: 'end' },
    ],
  },
];

// ---- 场景单据 ----
const SCENARIOS = [
  // ① 串行审批，全程通过
  { formIdx: 0, submitter: 'u_chen', ago: 2, data: {
    f_emp_no: '20020001', f_name: '陈晨', f_dept: 'tech', f_leave_type: 'personal',
    f_days: 2, f_start_date: '2026-09-18', f_end_date: '2026-09-19',
    f_reason: '家中临时有事，处理一天', f_cert: [], f_handover: [] },
    steps: [{ approve: 'u_wang', comment: '同意，注意交接' }],
    finishedAgo: 1 },

  // ② 条件分支：超过 3 天走到总监，目前停在总监
  { formIdx: 0, submitter: 'u_han', ago: 1, data: {
    f_emp_no: '20020002', f_name: '韩梅梅', f_dept: 'sales', f_leave_type: 'annual',
    f_days: 5, f_start_date: '2026-09-25', f_end_date: '2026-09-29',
    f_reason: '年假连休，出游', f_cert: [],
    f_handover: [{ f_item: '客户回访', f_person: '同事甲', f_status: 'done' }] },
    steps: [{ approve: 'u_wang', comment: '同意' }],
    waitingHours: 19 },

  // ③ 退回后修改重提：主管退回 → 发起人改事由 → 重新提交，停在主管（第 2 轮），留痕 1 处
  { formIdx: 0, submitter: 'u_lilei', ago: 3, data: {
    f_emp_no: '20020003', f_name: '李雷', f_dept: 'sales', f_leave_type: 'personal',
    f_days: 1, f_start_date: '2026-09-22', f_end_date: null,
    f_reason: '有事', f_cert: [], f_handover: [] },
    returned: { by: 'u_wang', comment: '请假事由太简略，请写明具体事项与交接安排', ago: 2 },
    edit: { f_reason: '家中急事需回去处理，周报已发同事甲代管' },
    resubmitHoursAgo: 6 },

  // ④ 销售大单：金额 12.6 万走总监 → 财务会签，周倩已签、吴迪待签（并行会签）
  { formIdx: 2, submitter: 'u_han', ago: 1, data: {
    f_order_no: 'SO-FLOW-001', f_customer: '海东银行', f_order_date: '2026-09-20',
    f_currency: 'CNY', f_amount: 126000, f_delivery: '分两批交付', f_contract: [],
    f_lines: [{ f_goods: 'CRM 专业版', f_line_qty: 2, f_line_price: 63000 }] },
    steps: [
      { approve: 'u_sun', comment: '价格已核准' },
      { approve: 'u_zhou', comment: '出纳已复核收款账户' },
    ],
    waitingHours: 27 },

  // ⑤ 销售小单：不足 1 万不经总监，财务两人会签后通过（串行 + 会签完成）
  { formIdx: 2, submitter: 'u_lilei', ago: 2, data: {
    f_order_no: 'SO-FLOW-002', f_customer: '明远集团', f_order_date: '2026-09-19',
    f_currency: 'CNY', f_amount: 7600, f_delivery: '', f_contract: [],
    f_lines: [{ f_goods: '扩展模块', f_line_qty: 1, f_line_price: 7600 }] },
    steps: [
      { approve: 'u_zhou', comment: '通过' },
      { approve: 'u_wudi', comment: '通过' },
    ],
    finishedAgo: 2 },

  // ⑥ 低分巡检触发整改：主管已审，现场复核人取字段值（u_wang），停在复核
  { formIdx: 3, submitter: 'u_chen', ago: 1, data: {
    f_store_name: '种子示例店', f_inspect_date: '2026-09-20', f_inspector: 'u_wang',
    f_overall_score: 65, f_tags: ['safety', 'hygiene'], f_summary: '消防通道堆物，需整改',
    f_photos: [],
    f_issues: [{ f_issue_desc: '后场堆放杂物堵塞通道', f_level: 'high', f_deadline: '2026-09-23' }] },
    steps: [{ approve: 'u_zhao', comment: '限期三天整改' }],
    waitingHours: 11 },

  // ⑦ 客户满意度低：触发跟进审批，停在销售主管
  { formIdx: 1, submitter: 'u_lilei', ago: 1, data: {
    f_customer_name: '回流客户（审批示例）', f_industry: 'manufacture', f_visit_month: '2026-09',
    f_score: 2, f_contacts: ['visit', 'phone'], f_note: '客户对交付延期强烈不满，需主管介入',
    f_products: [{ f_product: '年度维保', f_qty: 1, f_price: 20000 }] },
    steps: [],
    waitingHours: 8 },

  // ⑧ 高分巡检：不满足触发条件（>=80），不发起流程，单据保持普通提交
  { formIdx: 3, submitter: 'u_chen', noInstance: true, ago: 1, data: {
    f_store_name: '达标示例店', f_inspect_date: '2026-09-20', f_inspector: 'u_chen',
    f_overall_score: 92, f_tags: ['display'], f_summary: '陈列规范，无整改项', f_photos: [], f_issues: [] } },
];

function agoDate(hours) {
  return new Date(Date.now() - hours * 3600 * 1000);
}

/** 把实例的事件、待办时间均匀铺到 [startedAt, endedAt]，当前待办停在最后一个事件时刻 */
async function normalizeTimeline(client, instanceId, startedAt, endedAt) {
  const { rows: events } = await client.query(
    'SELECT id, action, node_key, actor FROM flow_events WHERE instance_id=$1 ORDER BY id',
    [instanceId],
  );
  if (!events.length) return;
  const n = events.length;
  const span = endedAt.getTime() - startedAt.getTime();
  // 在途且只有发起事件时，进入节点时间直接取 endedAt（预期停留时刻）
  const times = events.map((_, i) => {
    if (n === 1) return new Date(endedAt);
    return new Date(startedAt.getTime() + (span * i) / (n - 1));
  });
  for (let i = 0; i < n; i++) {
    await client.query('UPDATE flow_events SET created_at=$2 WHERE id=$1', [events[i].id, times[i]]);
  }
  const eventTime = (action, nodeKey, actor) => {
    const idx = events.findIndex((e) => e.action === action && e.node_key === nodeKey && (!actor || e.actor === actor));
    return idx >= 0 ? { idx, at: times[idx] } : null;
  };

  const { rows: tasks } = await client.query(
    'SELECT id, node_key, assignee, status FROM flow_tasks WHERE instance_id=$1 ORDER BY round, id',
    [instanceId],
  );
  for (const t of tasks) {
    if (t.status === 'pending') {
      // 停在当前节点：待办产生于最近一次事件
      await client.query('UPDATE flow_tasks SET created_at=$2 WHERE id=$1', [t.id, times[n - 1]]);
    } else {
      const action = t.status === 'returned' ? 'return' : 'approve';
      const hit = eventTime(action, t.node_key, t.assignee)
        || eventTime('return', t.node_key, null)
        || eventTime('approve', t.node_key, null);
      const actedAt = hit?.at || times[n - 1];
      const createdAt = times[Math.max(0, (hit?.idx || 1) - 1)];
      await client.query('UPDATE flow_tasks SET created_at=$2, acted_at=$3 WHERE id=$1', [t.id, createdAt, actedAt]);
    }
  }
  // 修改留痕时间对齐「重新提交」事件
  const resubmit = eventTime('resubmit', null, null);
  if (resubmit) {
    await client.query('UPDATE submission_revisions SET created_at=$2 WHERE instance_id=$1', [instanceId, resubmit.at]);
  }
  // 在途：进入当前节点的时间 = 最近一次事件；已结束：清空
  await client.query(
    `UPDATE flow_instances SET node_entered_at = CASE WHEN status='running' THEN $2::timestamptz ELSE NULL END
     WHERE id=$1`,
    [instanceId, times[n - 1]],
  );
}
function taskOf(tasks, assignee) {
  return tasks.find((t) => t.assignee === assignee);
}
async function pendingTasks(client, instanceId, round = 1) {
  const { rows } = await client.query(
    `SELECT id, node_key, assignee FROM flow_tasks
     WHERE instance_id=$1 AND round=$2 AND status='pending' ORDER BY id`,
    [instanceId, round],
  );
  return rows;
}

/**
 * @param {import('pg').Pool} pool
 * @param {{appIds:number[], formIds:number[]}} ctx  与 seed.js 相同的 app/form 下标
 */
export async function seedFlows(pool, { appIds, formIds }) {
  // 1) 落流程定义（全部直接生效）。app 归属：请假=行政(0)，拜访/订单=销售(1)，巡检=运营(2)
  const appOfForm = [0, 1, 1, 2, 2];
  const flowIds = [];
  for (const def of FLOW_DEFS) {
    const { rows } = await pool.query(
      `INSERT INTO flows(app_id, form_id, name, status, version, trigger_rule, definition, published_at)
       VALUES ($1,$2,$3,'published',1,$4::jsonb,$5::jsonb, now()) RETURNING id`,
      [appIds[appOfForm[def.formIdx]], formIds[def.formIdx], def.name,
       JSON.stringify(def.trigger_rule), JSON.stringify({ nodes: def.nodes })],
    );
    flowIds[def.formIdx] = rows[0].id;
  }

  // 2) 驱动场景
  const instanceIds = [];
  for (const sc of SCENARIOS) {
    const formId = formIds[sc.formIdx];
    const { rows: formRows } = await pool.query('SELECT * FROM forms WHERE id=$1', [formId]);
    const form = formRows[0];

    const { rows: subRows } = await pool.query(
      `INSERT INTO submissions(form_id, form_ver, data, status, created_by, created_at)
       VALUES ($1,1,$2::jsonb,'submitted',$3,$4) RETURNING *`,
      [formId, JSON.stringify(sc.data), sc.submitter, agoDate(sc.ago * 24 + 4)],
    );
    const submission = subRows[0];

    const inst = await startInstance(pool, { form, submission, submitter: sc.submitter });
    if (sc.noInstance) { continue; }
    instanceIds.push(inst.id);

    // 串行/会签：逐步找到当前节点该审批人的待办并通过
    for (const step of sc.steps || []) {
      const tasks = await pendingTasks(pool, inst.id);
      const task = taskOf(tasks, step.approve);
      if (!task) throw new Error(`种子失败：实例 ${inst.id} 找不到 ${step.approve} 的待办`);
      const r = await approveTask(pool, { taskId: task.id, actor: step.approve, comment: step.comment || '' });
      if (r.code !== 200) throw new Error(`种子失败：审批 ${step.approve} → ${r.message}`);
    }

    // 退回 → 发起人修改 → 重提
    if (sc.returned) {
      let tasks = await pendingTasks(pool, inst.id);
      const t = taskOf(tasks, sc.returned.by);
      const rr = await returnTask(pool, { taskId: t.id, actor: sc.returned.by, comment: sc.returned.comment });
      if (rr.code !== 200) throw new Error(`种子失败：退回 ${sc.returned.by} → ${rr.message}`);
      const edited = { ...sc.data, ...sc.edit };
      const changes = diffSubmission(form.field_schema, sc.data, edited);
      const rs = await resubmitInstance(pool, {
        submissionId: submission.id, submitter: sc.submitter,
        data: edited, beforeData: sc.data, changes,
      });
      if (rs.code !== 200) throw new Error(`种子失败：重提 → ${rs.message}`);
    }

    // 3) 回拨时间，让「停了多久 / 发起时间」有真实分布，并把事件/待办均匀铺到时间窗内
    const hoursStart = sc.ago * 24 + 4;
    let hoursEnd;
    if (sc.finishedAgo) hoursEnd = sc.finishedAgo * 24;
    else if (sc.resubmitHoursAgo) hoursEnd = sc.resubmitHoursAgo;
    else if (sc.waitingHours) hoursEnd = sc.waitingHours;
    else hoursEnd = 1;
    const startedAt = agoDate(hoursStart);
    const endedAt = agoDate(hoursEnd);
    await pool.query(`UPDATE flow_instances SET started_at=$2 WHERE id=$1`, [inst.id, startedAt]);
    if (sc.finishedAgo) await pool.query(`UPDATE flow_instances SET finished_at=$2 WHERE id=$1`, [inst.id, endedAt]);
    await normalizeTimeline(pool, inst.id, startedAt, endedAt);
  }

  const { rows: counts } = await pool.query(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE status='running')::int AS running,
       count(*) FILTER (WHERE status='approved')::int AS approved,
       count(*) FILTER (WHERE round > 1)::int AS resent
     FROM flow_instances`,
  );
  return { flowIds, instanceIds, ...counts[0] };
}
