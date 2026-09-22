// 种子：写入真实审批流定义，并用流程引擎把已有提交驱动成多种状态：
// 串行通过 / 条件分支 / 并行会签进行中 / 退回发起人后改单重提（留痕）/ 退回上节点 / 驳回 /
// 字段取审批人 / 换版本后在跑单据仍绑旧流程。
import {
  newApprovalNode,
  legacyRefFields,
  diffData,
} from './engine.js';
import {
  startFlow,
  approve,
  reject,
  returnTask,
  resubmit,
} from './runtime.js';

function appr(partial) { return newApprovalNode(partial); }

/** 各表单的流程定义（节点 id 固定，便于阅读） */
export function seedDefinitions() {
  return {
    // 请假：主管 →（天数>3：总监 → HR&财务会签）/ 其他直接结束
    leave: [
      { kind: 'approval', node: appr({ id: 'n_leave_mgr', name: '直属主管审批', mode: 'serial', approver_type: 'fixed', approvers: ['u10'], field: null }) },
      {
        kind: 'branch',
        branches: [
          {
            label: '请假超过 3 天',
            when: { field: 'f_days', op: 'gt', value: 3 },
            nodes: [
              appr({ id: 'n_leave_dir', name: '总监审批', mode: 'serial', approver_type: 'fixed', approvers: ['u11'], field: null }),
              appr({ id: 'n_leave_cs', name: 'HR 与财务会签', mode: 'countersign', approver_type: 'fixed', approvers: ['u12', 'u13'], field: null }),
            ],
          },
          { label: '3 天以内（免上级会签）', when: null, nodes: [] },
        ],
      },
    ],
    // 订单 v1：金额>1 万：财务 → 老板；否则仅财务
    orderV1: [
      {
        kind: 'branch',
        branches: [
          {
            label: '金额超过 1 万元',
            when: { field: 'f_amount', op: 'gt', value: 10000 },
            nodes: [
              appr({ id: 'n_ord_fin', name: '财务审批', mode: 'serial', approver_type: 'fixed', approvers: ['u13'], field: null }),
              appr({ id: 'n_ord_boss', name: '总经理审批', mode: 'serial', approver_type: 'fixed', approvers: ['u14'], field: null }),
            ],
          },
          { label: '一万元以下', when: null, nodes: [
            appr({ id: 'n_ord_fin_s', name: '财务审批', mode: 'serial', approver_type: 'fixed', approvers: ['u13'], field: null }),
          ] },
        ],
      },
    ],
    // 订单 v2（换流程示例）：门槛提高到 10 万
    orderV2: [
      {
        kind: 'branch',
        branches: [
          {
            label: '金额超过 10 万元',
            when: { field: 'f_amount', op: 'gt', value: 100000 },
            nodes: [
              appr({ id: 'n2_fin', name: '财务审批', mode: 'serial', approver_type: 'fixed', approvers: ['u13'], field: null }),
              appr({ id: 'n2_boss', name: '总经理审批', mode: 'serial', approver_type: 'fixed', approvers: ['u14'], field: null }),
            ],
          },
          { label: '十万元以下', when: null, nodes: [
            appr({ id: 'n2_fin_s', name: '财务审批', mode: 'serial', approver_type: 'fixed', approvers: ['u13'], field: null }),
          ] },
        ],
      },
    ],
    // 巡检：审批人取表单「巡检员」字段 → 门店经理复核
    inspect: [
      { kind: 'approval', node: appr({ id: 'n_insp_self', name: '巡检员确认', mode: 'serial', approver_type: 'field', approvers: [], field: 'f_inspector' }) },
      { kind: 'approval', node: appr({ id: 'n_insp_mgr', name: '门店经理复核', mode: 'serial', approver_type: 'fixed', approvers: ['u03'], field: null }) },
    ],
  };
}

async function insertFlow(pool, { appId, formId, name, definition, version, status }) {
  const legacy = legacyRefFields(definition);
  const { rows } = await pool.query(
    `INSERT INTO flows(app_id, form_id, name, definition, version, status, published_at,
                       trigger_field, condition_field, approver_field)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6, now(), $7,$8,$9) RETURNING *`,
    [appId, formId, name, JSON.stringify(definition), version, status,
     legacy.trigger_field, legacy.condition_field, legacy.approver_field],
  );
  return rows[0];
}

async function submissionsOf(pool, formId) {
  const { rows } = await pool.query('SELECT * FROM submissions WHERE form_id = $1 ORDER BY id', [formId]);
  return rows;
}

async function attachRevision1(pool, sub) {
  await pool.query(
    `INSERT INTO submission_revisions(submission_id, revision, data, change_summary, created_by)
     VALUES ($1,1,$2::jsonb,'[]'::jsonb,$3)`,
    [sub.id, JSON.stringify(sub.data), sub.created_by],
  );
}

async function pendingTasks(pool, instanceId) {
  const { rows } = await pool.query(
    `SELECT * FROM flow_tasks WHERE instance_id = $1 AND status = 'pending' ORDER BY id`,
    [instanceId],
  );
  return rows;
}

async function backdatePending(pool, instanceId, hours) {
  await pool.query(
    `UPDATE flow_tasks SET created_at = now() - ($2 || ' hours')::interval
     WHERE instance_id = $1 AND status = 'pending'`,
    [instanceId, String(hours)],
  );
}

/**
 * @param {import('pg').Pool} pool
 * @param {{appIds:number[], formIds:number[]}} ids
 */
export async function seedFlows(pool, { appIds, formIds }) {
  const D = seedDefinitions();

  // ── 请假审批流 ────────────────────────────────────────────────
  const leaveFlow = await insertFlow(pool, {
    appId: appIds[0], formId: formIds[0], name: '请假审批流',
    definition: D.leave, version: 1, status: 'active',
  });
  const leaveSubs = await submissionsOf(pool, formIds[0]);
  // 种子请假天数依次 1,2,0.5,3,5,1,2,10

  // 1) 短假（1 天）：主管通过 → 默认分支无节点 → 终审通过
  {
    const sub = leaveSubs[0];
    await attachRevision1(pool, sub);
    const inst = await startFlow(pool, { submission: sub, data: sub.data });
    let tasks = await pendingTasks(pool, inst.id);
    await approve(pool, { taskId: tasks[0].id, actor: 'u10', comment: '短假，同意' });
  }

  // 2) 长假（5 天）：主管、总监已通过，会签中 HR 已批、财务待批（停留 27 小时）
  let countersignInstId;
  {
    const sub = leaveSubs[4];
    await attachRevision1(pool, sub);
    const inst = await startFlow(pool, { submission: sub, data: sub.data });
    let tasks = await pendingTasks(pool, inst.id);
    await approve(pool, { taskId: tasks[0].id, actor: 'u10', comment: '同意，报上级' });
    tasks = await pendingTasks(pool, inst.id);
    await approve(pool, { taskId: tasks[0].id, actor: 'u11', comment: '总监同意，HR/财务会签' });
    tasks = await pendingTasks(pool, inst.id);
    const hr = tasks.find((t) => t.assignee === 'u12');
    await approve(pool, { taskId: hr.id, actor: 'u12', comment: 'HR 核假无误' });
    countersignInstId = inst.id;
    await backdatePending(pool, inst.id, 27);
  }

  // 3) 10 天长假：主管通过后被总监退回发起人 → 改成 2 天重提 → 重新走（此刻停在主管）
  {
    const sub = leaveSubs[7];
    await attachRevision1(pool, sub);
    const inst = await startFlow(pool, { submission: sub, data: sub.data });
    let tasks = await pendingTasks(pool, inst.id);
    await approve(pool, { taskId: tasks[0].id, actor: 'u10', comment: '拟同意' });
    tasks = await pendingTasks(pool, inst.id);
    await returnTask(pool, {
      taskId: tasks[0].id, actor: 'u11', comment: '10 天太长，请缩短并补充事由', target: 'initiator',
    });
    // 发起人改单：天数 10 → 2，事由改写
    const newData = {
      ...sub.data,
      f_days: 2,
      f_reason: `${sub.data.f_reason}（已按总监意见缩短为 2 天）`,
    };
    const { rows: formRows } = await pool.query('SELECT * FROM forms WHERE id = $1', [sub.form_id]);
    const changes = diffData(sub.data, newData, formRows[0].field_schema);
    await resubmit(pool, {
      submissionId: sub.id, actor: sub.created_by, data: newData,
      form: formRows[0], changes,
    });
  }

  // 4) 主管通过后总监「退回上一节点」：重新停在主管（第二个批次）
  {
    // 把一条 2 天的单改成 8 天以走长假分支
    const sub = leaveSubs[1];
    const data = { ...sub.data, f_days: 8 };
    await pool.query('UPDATE submissions SET data = $2::jsonb WHERE id = $1', [sub.id, JSON.stringify(data)]);
    sub.data = data;
    await attachRevision1(pool, sub);
    const inst = await startFlow(pool, { submission: sub, data });
    let tasks = await pendingTasks(pool, inst.id);
    await approve(pool, { taskId: tasks[0].id, actor: 'u10', comment: '同意' });
    tasks = await pendingTasks(pool, inst.id);
    await returnTask(pool, { taskId: tasks[0].id, actor: 'u11', comment: '交接人没写清楚，请主管再把关', target: 'previous' });
    await backdatePending(pool, inst.id, 5);
  }

  // 5) 主管直接驳回（终态）
  {
    const sub = leaveSubs[5];
    await attachRevision1(pool, sub);
    const inst = await startFlow(pool, { submission: sub, data: sub.data });
    const tasks = await pendingTasks(pool, inst.id);
    await reject(pool, { taskId: tasks[0].id, actor: 'u10', comment: '证明材料不齐，驳回' });
  }

  // 6) 主管退回发起人后一直未改（停在 returned，出现在发起人待办里）
  {
    const sub = leaveSubs[3]; // 3 天
    await attachRevision1(pool, sub);
    const inst = await startFlow(pool, { submission: sub, data: sub.data });
    const tasks = await pendingTasks(pool, inst.id);
    await returnTask(pool, {
      taskId: tasks[0].id, actor: 'u10', target: 'initiator',
      comment: '事由写得太简单，请补充具体安排后重新提交',
    });
    await pool.query(
      `UPDATE submissions SET created_at = now() - interval '2 days' WHERE id = $1`, [sub.id],
    );
  }

  // ── 订单审批流 v1 → 发布 v2（在跑单据仍绑 v1）──────────────────
  const orderV1 = await insertFlow(pool, {
    appId: appIds[1], formId: formIds[2], name: '订单审批流',
    definition: D.orderV1, version: 1, status: 'active',
  });
  const orderSubs = await submissionsOf(pool, formIds[2]);
  // 大额订单 126000：财务已批，停在总经理（换版本前启动，始终走 v1）
  let oldInstanceId;
  {
    const sub = orderSubs[1];
    await attachRevision1(pool, sub);
    const inst = await startFlow(pool, { submission: sub, data: sub.data });
    const tasks = await pendingTasks(pool, inst.id);
    await approve(pool, { taskId: tasks[0].id, actor: 'u13', comment: '财务核准' });
    oldInstanceId = inst.id;
    await backdatePending(pool, inst.id, 30);
  }
  // 换流程：v1 归档、v2 生效
  await pool.query(`UPDATE flows SET status = 'archived', updated_at = now() WHERE id = $1`, [orderV1.id]);
  await insertFlow(pool, {
    appId: appIds[1], formId: formIds[2], name: '订单审批流',
    definition: D.orderV2, version: 2, status: 'active',
  });
  // 小额订单 9800 在新版本下提交：财务通过即终审（走 v2 默认分支）
  {
    const sub = orderSubs[2];
    await attachRevision1(pool, sub);
    const inst = await startFlow(pool, { submission: sub, data: sub.data });
    const tasks = await pendingTasks(pool, inst.id);
    await approve(pool, { taskId: tasks[0].id, actor: 'u13', comment: '小额，同意' });
  }

  // ── 巡检整改流（审批人取字段 f_inspector）──────────────────────
  await insertFlow(pool, {
    appId: appIds[2], formId: formIds[3], name: '巡检整改流',
    definition: D.inspect, version: 1, status: 'active',
  });
  const inspectSubs = await submissionsOf(pool, formIds[3]);
  {
    // 第一条巡检员 u01：停在 u01 待确认（字段取审批人）
    const sub = inspectSubs[0];
    await attachRevision1(pool, sub);
    const inst = await startFlow(pool, { submission: sub, data: sub.data });
    await backdatePending(pool, inst.id, 4);
  }
  {
    // 第二条 u02：u02 确认、经理 u03 复核通过 → 终审
    const sub = inspectSubs[1];
    await attachRevision1(pool, sub);
    const inst = await startFlow(pool, { submission: sub, data: sub.data });
    let tasks = await pendingTasks(pool, inst.id);
    await approve(pool, { taskId: tasks[0].id, actor: tasks[0].assignee, comment: '情况属实' });
    tasks = await pendingTasks(pool, inst.id);
    await approve(pool, { taskId: tasks[0].id, actor: 'u03', comment: '整改到位' });
  }

  return {
    flowIds: [leaveFlow.id, orderV1.id],
    countersignInstanceId: countersignInstId,
    oldVersionInstanceId: oldInstanceId,
    instanceCount: 10,
  };
}
