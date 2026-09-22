// 审批流运行时：全部函数接收 pg client，由路由在事务里调用。
// 状态机口径见 engine.js 顶部注释；这里只做「驱动」：建任务、推进、退回、重提。
import {
  expandPath,
  resolveApprovers,
  diffData,
} from './engine.js';

export class FlowError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function getActiveFlow(client, formId) {
  const { rows } = await client.query(
    `SELECT * FROM flows WHERE form_id = $1 AND status = 'active' LIMIT 1`,
    [formId],
  );
  return rows[0] || null;
}

async function getForm(client, formId) {
  const { rows } = await client.query('SELECT * FROM forms WHERE id = $1', [formId]);
  return rows[0] || null;
}

async function logAction(client, instanceId, action, actor, nodeName = '', comment = '', detail = {}) {
  await client.query(
    `INSERT INTO flow_actions(instance_id, action, actor, node_name, comment, detail)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [instanceId, action, actor, nodeName, String(comment || '').slice(0, 500), JSON.stringify(detail)],
  );
}

/**
 * 在某节点创建审批任务。
 * serial：只下发当前 seq 一个任务（通过后再补下一个）；
 * countersign：一次性为全部审批人下发任务（同一批次）。
 * @returns {Array} 本次创建的任务行
 */
async function createTasks(client, inst, entry, approvers, fromSeq = 0) {
  const { node } = entry;
  const created = [];
  if (node.mode === 'countersign') {
    for (let seq = 0; seq < approvers.length; seq++) {
      const { rows } = await client.query(
        `INSERT INTO flow_tasks(instance_id, stage_idx, branch_idx, node_id, node_name, seq, batch_no, assignee)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [inst.id, entry.stage_idx, entry.branch_idx, node.id, node.name, seq, inst.batch_no, approvers[seq]],
      );
      created.push(rows[0]);
    }
  } else {
    const { rows } = await client.query(
      `INSERT INTO flow_tasks(instance_id, stage_idx, branch_idx, node_id, node_name, seq, batch_no, assignee)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [inst.id, entry.stage_idx, entry.branch_idx, node.id, node.name, fromSeq, inst.batch_no, approvers[fromSeq]],
    );
    created.push(rows[0]);
  }
  return created;
}

/** 让实例停在 active_path[cursor]（cursor 必须有效） */
async function enterNode(client, inst, data) {
  const entry = inst.active_path[inst.node_cursor];
  if (!entry) throw new FlowError(500, '执行路径异常：找不到当前节点');
  const approvers = [...new Set(resolveApprovers(entry.node, data).map(String))];
  if (!approvers.length) {
    throw new FlowError(422, `节点「${entry.node.name}」解析不到审批人（请检查流程的审批人设置或单据字段值），流程无法继续`);
  }
  await client.query(
    `UPDATE flow_instances SET current_stage = $2, batch_no = $3 WHERE id = $1`,
    [inst.id, entry.stage_idx, inst.batch_no],
  );
  await logAction(client, inst.id, 'node_enter', '', entry.node.name, '', {
    stage_idx: entry.stage_idx, branch_idx: entry.branch_idx, mode: entry.node.mode, approvers,
  });
  return createTasks(client, inst, entry, approvers, 0);
}

/**
 * 发起流程（提交单据后调用）。没有生效流程 → 单据保持 submitted 直接收数。
 * @returns {instance|null}
 */
export async function startFlow(client, { submission, data }) {
  const flow = await getActiveFlow(client, submission.form_id);
  if (!flow) {
    await client.query(`UPDATE submissions SET status = 'submitted' WHERE id = $1`, [submission.id]);
    return null;
  }
  const form = await getForm(client, submission.form_id);
  const activePath = expandPath(flow.definition, data);

  const { rows } = await client.query(
    `INSERT INTO flow_instances(flow_id, submission_id, form_id, status, current_stage,
                                active_path, node_cursor, batch_no)
     VALUES ($1,$2,$3,'running',$4,$5::jsonb,$6,$7) RETURNING *`,
    [flow.id, submission.id, submission.form_id, activePath[0]?.stage_idx ?? -1,
     JSON.stringify(activePath), 0, 1],
  );
  const inst = rows[0];
  await client.query(`UPDATE submissions SET status = 'in_approval' WHERE id = $1`, [submission.id]);
  await logAction(client, inst.id, 'submit', submission.created_by || '', flow.name, '', {
    flow_id: flow.id, flow_version: flow.version, node_count: activePath.length,
  });

  if (!activePath.length) {
    // 条件一个都没命中、且没有任何节点：自动通过
    return finishInstance(client, inst, 'approved', 'submit', submission.created_by || '', '无匹配审批节点，自动通过');
  }
  await enterNode(client, inst, data);
  return inst;
}

async function finishInstance(client, inst, result, action, actor, comment, detail = {}) {
  const { rows } = await client.query(
    `UPDATE flow_instances SET status = $2, finished_at = now() WHERE id = $1 RETURNING *`,
    [inst.id, result],
  );
  await client.query(`UPDATE submissions SET status = $2 WHERE id = $1`, [inst.submission_id, result]);
  await logAction(client, inst.id, action, actor, '', comment, detail);
  return rows[0];
}

/** 作废当前节点批次的其余 pending 任务（退回/驳回时） */
async function cancelBatchPeers(client, inst, task, status = 'cancelled') {
  await client.query(
    `UPDATE flow_tasks SET status = $2, acted_at = now()
     WHERE instance_id = $1 AND status = 'pending' AND id <> $3`,
    [inst.id, status, task.id],
  );
}

async function loadInstance(client, instanceId) {
  const { rows } = await client.query('SELECT * FROM flow_instances WHERE id = $1', [instanceId]);
  return rows[0] || null;
}

async function loadSubmissionData(client, submissionId) {
  const { rows } = await client.query('SELECT * FROM submissions WHERE id = $1', [submissionId]);
  return rows[0] || null;
}

/**
 * 推进：节点全部通过后调用。串行补人；序列走完则进入下一节点或终审。
 */
async function advanceAfterApprove(client, inst, task, comment, actor) {
  const entry = inst.active_path[inst.node_cursor];
  const { node } = entry;

  if (node.mode === 'serial') {
    // 串行：该节点是否还有下一个审批人
    const { rows: seqRows } = await client.query(
      `SELECT coalesce(max(seq), -1) AS max_seq FROM flow_tasks
       WHERE instance_id = $1 AND node_id = $2 AND batch_no = $3`,
      [inst.id, node.id, inst.batch_no],
    );
    const sub = await loadSubmissionData(client, inst.submission_id);
    const approvers = [...new Set(resolveApprovers(node, sub.data).map(String))];
    const nextSeq = seqRows[0].max_seq + 1;
    if (nextSeq < approvers.length) {
      await createTasks(client, inst, entry, approvers, nextSeq);
      return;
    }
  }

  // 节点完成 → 下一节点
  const nextCursor = inst.node_cursor + 1;
  if (nextCursor >= inst.active_path.length) {
    await finishInstance(client, inst, 'approved', 'approve', actor, comment, { last_node: node.name });
    return;
  }
  inst.node_cursor = nextCursor;
  inst.batch_no += 1;
  await client.query(
    'UPDATE flow_instances SET node_cursor = $2, batch_no = $3 WHERE id = $1',
    [inst.id, inst.node_cursor, inst.batch_no],
  );
  const sub = await loadSubmissionData(client, inst.submission_id);
  await enterNode(client, inst, sub.data);
}

/** 校验任务确属当前激活批次且归 actor 处理 */
async function requireActionableTask(client, inst, taskId, actor) {
  const { rows } = await client.query('SELECT * FROM flow_tasks WHERE id = $1', [taskId]);
  const task = rows[0];
  if (!task) throw new FlowError(404, '审批任务不存在');
  if (task.instance_id !== inst.id) throw new FlowError(400, '任务与流程实例不匹配');
  if (task.status !== 'pending') throw new FlowError(409, '该任务已处理或已失效');
  const entry = inst.active_path[inst.node_cursor];
  if (inst.node_cursor < 0 || !entry || entry.node.id !== task.node_id || task.batch_no !== inst.batch_no) {
    throw new FlowError(409, '该任务已失效（流程节点已变化）');
  }
  if (task.assignee !== actor) {
    throw new FlowError(403, `该任务应由「${task.assignee}」处理，当前身份无权操作`);
  }
  return task;
}

async function actOnTask(client, taskId, actor, kind, comment) {
  // 先按任务找到实例
  const { rows: trows } = await client.query('SELECT * FROM flow_tasks WHERE id = $1', [taskId]);
  if (!trows.length) throw new FlowError(404, '审批任务不存在');
  const inst = await loadInstance(client, trows[0].instance_id);
  if (!inst) throw new FlowError(404, '流程实例不存在');
  if (inst.status !== 'running') throw new FlowError(409, '流程已结束，不能再操作');
  const task = await requireActionableTask(client, inst, taskId, actor);
  return { inst, task };
}

/** 通过 */
export async function approve(client, { taskId, actor, comment }) {
  const { inst, task } = await actOnTask(client, taskId, actor, 'approve', comment);
  await client.query(
    `UPDATE flow_tasks SET status = 'approved', comment = $2, acted_at = now() WHERE id = $1`,
    [task.id, String(comment || '').slice(0, 500)],
  );
  await logAction(client, inst.id, 'approve', actor, task.node_name, comment, { seq: task.seq });

  // 会签：同批还有 pending 则继续等
  const { rows: waitRows } = await client.query(
    `SELECT count(*)::int AS c FROM flow_tasks
     WHERE instance_id = $1 AND node_id = $2 AND batch_no = $3 AND status = 'pending'`,
    [inst.id, task.node_id, inst.batch_no],
  );
  if (waitRows[0].c > 0) return loadInstance(client, inst.id);

  await advanceAfterApprove(client, inst, task, comment, actor);
  return loadInstance(client, inst.id);
}

/** 驳回（终态，不可再修改提交；区别于可改单的退回发起人） */
export async function reject(client, { taskId, actor, comment }) {
  const { inst, task } = await actOnTask(client, taskId, actor, 'reject', comment);
  await client.query(
    `UPDATE flow_tasks SET status = 'rejected', comment = $2, acted_at = now() WHERE id = $1`,
    [task.id, String(comment || '').slice(0, 500)],
  );
  await cancelBatchPeers(client, inst, task, 'cancelled');
  return finishInstance(client, inst, 'rejected', 'reject', actor, comment || '驳回', { node: task.node_name });
}

/**
 * 退回。
 * target='initiator'：退回发起人改单，cursor=-1，重提后从第一阶段重走（条件重新判定）。
 * target='previous'：退回上一审批节点，激活 cursor-1，再通过后继续往下；首个节点不允许。
 */
export async function returnTask(client, { taskId, actor, comment, target }) {
  const { inst, task } = await actOnTask(client, taskId, actor, 'return', comment);

  if (target === 'previous') {
    if (inst.node_cursor <= 0) {
      throw new FlowError(400, '已是第一个审批节点，没有上一节点可退；请改用「退回发起人」');
    }
    await client.query(
      `UPDATE flow_tasks SET status = 'cancelled', acted_at = now()
       WHERE instance_id = $1 AND status = 'pending'`,
      [inst.id],
    );
    await logAction(client, inst.id, 'return_previous', actor, task.node_name, comment, {
      from_cursor: inst.node_cursor,
    });
    inst.node_cursor -= 1;
    inst.batch_no += 1;
    await client.query(
      `UPDATE flow_instances SET node_cursor = $2, batch_no = $3 WHERE id = $1`,
      [inst.id, inst.node_cursor, inst.batch_no],
    );
    const sub = await loadSubmissionData(client, inst.submission_id);
    await enterNode(client, inst, sub.data);
    return loadInstance(client, inst.id);
  }

  // 退回发起人
  await client.query(
    `UPDATE flow_tasks SET status = 'cancelled', acted_at = now()
     WHERE instance_id = $1 AND status = 'pending'`,
    [inst.id],
  );
  await client.query(
    `UPDATE flow_instances SET node_cursor = -1, current_stage = -1 WHERE id = $1`,
    [inst.id],
  );
  await client.query(`UPDATE submissions SET status = 'returned' WHERE id = $1`, [inst.submission_id]);
  await logAction(client, inst.id, 'return_initiator', actor, task.node_name, comment || '请修改后重新提交', {});
  return loadInstance(client, inst.id);
}

/**
 * 退回后发起人改单重新提交：
 * 校验由路由完成后调用；存 revision 快照 + 字段级 diff，按新数据重建执行路径从头走。
 */
export async function resubmit(client, { submissionId, actor, data, form, changes }) {
  const sub = await loadSubmissionData(client, submissionId);
  if (!sub) throw new FlowError(404, '单据不存在');
  const { rows: irows } = await client.query(
    `SELECT * FROM flow_instances WHERE submission_id = $1 ORDER BY id DESC LIMIT 1`,
    [submissionId],
  );
  const inst = irows[0];
  if (!inst || inst.node_cursor !== -1) {
    throw new FlowError(409, '当前单据不在「退回待修改」状态，不能重新提交');
  }

  const { rows: vrows } = await client.query(
    `INSERT INTO submission_revisions(submission_id, revision, data, change_summary, created_by)
     SELECT $1, coalesce(max(revision), 0) + 1, $2::jsonb, $3::jsonb, $4
     FROM submission_revisions WHERE submission_id = $1
     RETURNING revision`,
    [submissionId, JSON.stringify(data), JSON.stringify(changes), actor],
  );
  const revision = vrows[0].revision;
  await client.query(
    `UPDATE submissions SET data = $2::jsonb, form_ver = $3, status = 'in_approval' WHERE id = $1`,
    [submissionId, JSON.stringify(data), form.version],
  );

  // 重新按新数据展开路径（条件分支可能改道）
  const { rows: frows } = await client.query('SELECT * FROM flows WHERE id = $1', [inst.flow_id]);
  const flow = frows[0];
  const activePath = expandPath(flow.definition, data);

  inst.active_path = activePath;
  inst.node_cursor = 0;
  inst.batch_no += 1;
  inst.status = 'running';
  inst.finished_at = null;
  await client.query(
    `UPDATE flow_instances SET active_path = $2::jsonb, node_cursor = 0, batch_no = $3,
                                    status = 'running', current_stage = $4, finished_at = NULL
     WHERE id = $1`,
    [inst.id, JSON.stringify(activePath), inst.batch_no, activePath[0]?.stage_idx ?? -1],
  );
  await logAction(client, inst.id, 'resubmit', actor, '', '', {
    revision, changed_fields: changes.length, changes: changes.slice(0, 50),
  });

  if (!activePath.length) {
    return finishInstance(client, inst, 'approved', 'approve', actor, '无匹配审批节点，自动通过');
  }
  await enterNode(client, inst, data);
  return loadInstance(client, inst.id);
}

// ---------- 查询组装 ----------

/** 实例详情：当前节点/待处理人/停留时长/进度/时间线/版本 */
export async function getInstanceDetail(client, submissionId) {
  const sub = await loadSubmissionData(client, submissionId);
  if (!sub) throw new FlowError(404, '单据不存在');
  const { rows: irows } = await client.query(
    'SELECT * FROM flow_instances WHERE submission_id = $1 ORDER BY id DESC LIMIT 1',
    [submissionId],
  );
  const inst = irows[0] || null;
  const { rows: formRows } = await client.query(
    'SELECT id, app_id, name, field_schema, version FROM forms WHERE id = $1',
    [sub.form_id],
  );
  const form = formRows[0];

  if (!inst) {
    return { submission: sub, form, instance: null, flow: null, current: null, progress: [], timeline: [], revisions: [] };
  }
  const { rows: flowRows } = await client.query(
    'SELECT id, name, version, status FROM flows WHERE id = $1',
    [inst.flow_id],
  );
  const flow = flowRows[0] || null;

  const { rows: taskRows } = await client.query(
    `SELECT * FROM flow_tasks WHERE instance_id = $1 ORDER BY id`,
    [inst.id],
  );
  const { rows: actRows } = await client.query(
    'SELECT * FROM flow_actions WHERE instance_id = $1 ORDER BY id',
    [inst.id],
  );
  const { rows: revRows } = await client.query(
    'SELECT id, revision, data, change_summary, created_by, created_at FROM submission_revisions WHERE submission_id = $1 ORDER BY revision',
    [submissionId],
  );

  // 当前状态
  let current = null;
  if (inst.status === 'running' && inst.node_cursor === -1) {
    const ret = [...actRows].reverse().find((a) => a.action === 'return_initiator');
    current = {
      phase: 'returned',
      label: '退回发起人 · 待修改重提',
      assignees: [sub.created_by],
      since: ret?.created_at || null,
      node_name: null,
    };
  } else if (inst.status === 'running') {
    const entry = inst.active_path[inst.node_cursor];
    const pending = taskRows.filter(
      (t) => t.node_id === entry.node.id && t.batch_no === inst.batch_no && t.status === 'pending',
    );
    current = {
      phase: 'approving',
      label: entry.node.name,
      mode: entry.node.mode,
      stage_idx: entry.stage_idx,
      branch_idx: entry.branch_idx,
      assignees: pending.map((t) => t.assignee),
      task_ids: pending.map((t) => t.id),
      since: pending.length ? pending.reduce((m, t) => (m < t.created_at ? m : t.created_at), pending[0].created_at) : null,
    };
  } else {
    current = { phase: inst.status, label: inst.status === 'approved' ? '审批通过' : '已驳回', assignees: [], since: inst.finished_at };
  }

  // 节点进度（按实际执行路径；历史动作全部在 timeline 里可查）
  const progress = inst.active_path.map((entry, idx) => {
    const nodeTasks = taskRows.filter((t) => t.node_id === entry.node.id);
    const latestBatch = nodeTasks.reduce((m, t) => Math.max(m, t.batch_no), 0);
    const batchTasks = nodeTasks.filter((t) => t.batch_no === latestBatch);
    let state = 'waiting';
    if (inst.status === 'approved') {
      state = 'done';
    } else if (inst.node_cursor === -1) {
      state = 'waiting'; // 退回发起人：即将从头重走，历史见时间线
    } else if (idx < inst.node_cursor) {
      state = 'done';
    } else if (idx === inst.node_cursor) {
      state = inst.status === 'rejected' || batchTasks.some((t) => t.status === 'rejected') ? 'rejected' : 'active';
    }
    return {
      idx,
      node_id: entry.node.id,
      name: entry.node.name,
      mode: entry.node.mode,
      stage_idx: entry.stage_idx,
      branch_idx: entry.branch_idx,
      state,
      tasks: batchTasks.map((t) => ({ assignee: t.assignee, status: t.status, comment: t.comment, acted_at: t.acted_at, seq: t.seq })),
    };
  });

  // 时间线：操作流水 + 内容版本合并
  const timeline = [
    ...actRows.map((a) => ({ kind: 'action', at: a.created_at, action: a.action, actor: a.actor, node_name: a.node_name, comment: a.comment, detail: a.detail })),
    ...revRows.filter((r) => r.revision > 1).map((r) => ({ kind: 'revision', at: r.created_at, revision: r.revision, actor: r.created_by, changes: r.change_summary })),
  ].sort((x, y) => new Date(x.at) - new Date(y.at));

  return {
    submission: sub,
    form,
    instance: { id: inst.id, status: inst.status, current_stage: inst.current_stage, node_cursor: inst.node_cursor, started_at: inst.started_at, finished_at: inst.finished_at },
    flow,
    definition: flow ? (await getDefinitionById(client, flow.id)) : null,
    active_path: inst.active_path,
    current,
    progress,
    timeline,
    revisions: revRows,
  };
}

async function getDefinitionById(client, flowId) {
  const { rows } = await client.query('SELECT definition FROM flows WHERE id = $1', [flowId]);
  return rows[0]?.definition || null;
}

/** 计算改单差异（供路由校验通过后、resubmit 前使用） */
export async function buildChanges(client, { submissionId, data, form }) {
  const { rows } = await client.query('SELECT data FROM submissions WHERE id = $1', [submissionId]);
  if (!rows.length) throw new FlowError(404, '单据不存在');
  return diffData(rows[0].data, data, form.field_schema);
}
