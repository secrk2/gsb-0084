// 流程运行时：发起 / 节点推进 / 通过 / 退回 / 修改重提。
// 所有函数接收 pg client，由路由层包事务；流程定义在发起时快照进 flow_instances.definition，
// 因此「换流程」不影响在途单据——它们始终按快照走完。
import {
  evaluateGroup,
  evaluateTrigger,
  routeCondition,
  resolveAssignees,
} from './flowdef.js';

export const SUB_STATUS = {
  SUBMITTED: 'submitted', // 无流程的普通提交
  RUNNING: 'running',
  APPROVED: 'approved',
  RETURNED: 'returned',
};

export function nodeMap(def) {
  const m = new Map();
  for (const n of def?.nodes || []) m.set(n.key, n);
  return m;
}

async function logEvent(client, instanceId, action, node, actor, comment = '') {
  await client.query(
    `INSERT INTO flow_events(instance_id, action, node_key, node_name, actor, comment)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [instanceId, action, node?.key || null, node?.name || '', actor || '', String(comment || '').slice(0, 1000)],
  );
}

/**
 * 进入某个节点：
 * - end/空：流程通过
 * - condition：按当前单据数据选路，记 route 事件后继续
 * - approval：解析审批人并生成待办；解析不出人自动跳过
 * 深度上限防御异常定义（正常定义已在校验时禁止成环）。
 */
async function enterNode(client, inst, nodeKey, round, depth = 0) {
  if (depth > 50) throw new Error('流程节点深度超限，请检查是否存在环路');
  const node = nodeMap(inst.definition).get(nodeKey);
  if (!node || node.type === 'end') {
    return finishInstance(client, inst);
  }
  if (node.type === 'condition') {
    const nextKey = routeCondition(node, inst.data);
    const hit = (node.branches || []).find((b) => b.next === nextKey && evaluateGroup(b, inst.data)) || null;
    await logEvent(
      client, inst.id, 'route', node, inst.submitter,
      hit ? `命中分支：${hit.label}` : (nextKey ? '走默认分支' : '无命中分支，流程结束'),
    );
    if (!nextKey) return finishInstance(client, inst);
    return enterNode(client, inst, nextKey, round, depth + 1);
  }
  if (node.type === 'approval') {
    const assignees = resolveAssignees(node, inst.data);
    if (!assignees.length) {
      await logEvent(client, inst.id, 'auto_pass', node, inst.submitter, '未解析到审批人，自动通过');
      return enterNode(client, inst, node.next, round, depth + 1);
    }
    for (const assignee of assignees) {
      await client.query(
        `INSERT INTO flow_tasks(instance_id, node_key, node_name, assignee, status, round)
         VALUES ($1,$2,$3,$4,'pending',$5)`,
        [inst.id, node.key, node.name, assignee, round],
      );
    }
    await client.query(
      `UPDATE flow_instances
       SET current_node_key=$2, current_node_name=$3, node_entered_at=now()
       WHERE id=$1`,
      [inst.id, node.key, node.name],
    );
    return;
  }
  // start 或未知类型直接往后走
  return enterNode(client, inst, node.next, round, depth + 1);
}

async function finishInstance(client, inst) {
  await client.query(
    `UPDATE flow_instances
       SET status='approved', current_node_key=NULL, current_node_name='',
           node_entered_at=NULL, finished_at=now()
     WHERE id=$1`,
    [inst.id],
  );
  await client.query(`UPDATE submissions SET status='approved' WHERE id=$1`, [inst.submission_id]);
  const endNode = [...(inst.definition.nodes || [])].find((n) => n.type === 'end');
  await logEvent(client, inst.id, 'finish', endNode, inst.submitter, '全部节点通过');
}

/** 发起一条流程实例（若表单无生效流程或不满足触发条件，返回 null，单据保持普通提交） */
export async function startInstance(client, { form, submission, submitter }) {
  const { rows: flowRows } = await client.query(
    `SELECT * FROM flows WHERE form_id=$1 AND status='published'`,
    [form.id],
  );
  if (!flowRows.length) return null;
  const flow = flowRows[0];
  if (!evaluateTrigger(flow.trigger_rule, submission.data)) return null;

  const { rows } = await client.query(
    `INSERT INTO flow_instances
       (flow_id, flow_version, form_id, submission_id, status, definition, submitter, round, started_at)
     VALUES ($1,$2,$3,$4,'running',$5::jsonb,$6,1,now())
     RETURNING *`,
    [flow.id, flow.version, form.id, submission.id, JSON.stringify(flow.definition), submitter || ''],
  );
  const inst = rows[0];
  inst.data = submission.data;
  await client.query(`UPDATE submissions SET status='running' WHERE id=$1`, [submission.id]);
  await logEvent(client, inst.id, 'start', null, submitter, `流程「${flow.name}」发起`);

  const start = (flow.definition.nodes || []).find((n) => n.type === 'start');
  await enterNode(client, inst, start?.next, 1);
  return inst;
}

async function loadInstanceForAction(client, instanceId) {
  const { rows } = await client.query('SELECT * FROM flow_instances WHERE id=$1 FOR UPDATE', [instanceId]);
  if (!rows.length) return null;
  const inst = rows[0];
  const { rows: subRows } = await client.query(
    'SELECT id, data FROM submissions WHERE id=$1 FOR UPDATE', [inst.submission_id],
  );
  inst.data = subRows[0].data;
  inst.submissionId = subRows[0].id;
  return inst;
}

async function completeNodeIfReady(client, inst, node, round, { force = false } = {}) {
  // mode=all：仍有待办则停留；mode=any（force）：取消其余待办后推进
  const { rows: pendingRows } = await client.query(
    `SELECT count(*)::int AS n FROM flow_tasks
     WHERE instance_id=$1 AND node_key=$2 AND round=$3 AND status='pending'`,
    [inst.id, node.key, round],
  );
  if (!force && pendingRows[0].n > 0) return;

  if (force) {
    await client.query(
      `UPDATE flow_tasks SET status='cancelled', acted_at=now()
       WHERE instance_id=$1 AND node_key=$2 AND round=$3 AND status='pending'`,
      [inst.id, node.key, round],
    );
  }
  await enterNode(client, inst, node.next, round);
}

/** 通过：会签需所有人通过，或签一人通过即推进 */
export async function approveTask(client, { taskId, actor, comment }) {
  const { rows: taskRows } = await client.query('SELECT * FROM flow_tasks WHERE id=$1 FOR UPDATE', [taskId]);
  if (!taskRows.length) return { code: 404, message: '待办不存在或已被处理' };
  const task = taskRows[0];
  if (task.status !== 'pending') return { code: 409, message: '该待办已处理' };

  const inst = await loadInstanceForAction(client, task.instance_id);
  if (!inst) return { code: 404, message: '流程实例不存在' };
  if (inst.status !== 'running') return { code: 409, message: `单据已${inst.status === 'approved' ? '通过' : '退回'}，无需处理` };
  if (task.round !== inst.round) return { code: 409, message: '单据已被退回重提，该待办已失效' };

  await client.query(
    `UPDATE flow_tasks SET status='approved', comment=$2, acted_at=now() WHERE id=$1`,
    [task.id, String(comment || '').slice(0, 1000)],
  );
  const node = nodeMap(inst.definition).get(task.node_key);
  await logEvent(client, inst.id, 'approve', node, actor, comment);

  const isAnySign = node?.mode === 'any';
  await completeNodeIfReady(client, inst, node, inst.round, { force: isAnySign });
  return { code: 200, instanceId: inst.id };
}

/**
 * 退回：统一口径——退回到发起人。
 * 任一审批人退回即作废当前节点全部待办，单据回到发起人手中修改；
 * 发起人改完重新提交后，流程从第一个节点重新走（新一轮），原审批记录与修改留痕全部保留。
 */
export async function returnTask(client, { taskId, actor, comment }) {
  const { rows: taskRows } = await client.query('SELECT * FROM flow_tasks WHERE id=$1 FOR UPDATE', [taskId]);
  if (!taskRows.length) return { code: 404, message: '待办不存在或已被处理' };
  const task = taskRows[0];
  if (task.status !== 'pending') return { code: 409, message: '该待办已处理' };

  const inst = await loadInstanceForAction(client, task.instance_id);
  if (!inst) return { code: 404, message: '流程实例不存在' };
  if (inst.status !== 'running') return { code: 409, message: '单据不在审批中' };
  if (task.round !== inst.round) return { code: 409, message: '单据已被退回重提，该待办已失效' };

  const node = nodeMap(inst.definition).get(task.node_key);
  await client.query(
    `UPDATE flow_tasks SET status='returned', comment=$2, acted_at=now() WHERE id=$1`,
    [task.id, String(comment || '').slice(0, 1000)],
  );
  await client.query(
    `UPDATE flow_tasks SET status='cancelled', acted_at=now()
     WHERE instance_id=$1 AND round=$2 AND status='pending'`,
    [inst.id, inst.round],
  );
  await client.query(
    `UPDATE flow_instances
       SET status='returned', returned_at=now(),
           return_comment=$2, current_node_key=NULL, current_node_name='', node_entered_at=NULL
     WHERE id=$1`,
    [inst.id, String(comment || '').slice(0, 1000)],
  );
  await client.query(`UPDATE submissions SET status='returned' WHERE id=$1`, [inst.submission_id]);
  await logEvent(client, inst.id, 'return', node, actor, comment || '退回发起人修改');
  return { code: 200, instanceId: inst.id };
}

/** 退回后修改重提：写留痕、轮次 +1、从开始节点重走（仍按发起时的流程定义快照） */
export async function resubmitInstance(client, { submissionId, submitter, data, beforeData, changes }) {
  const { rows: instRows } = await client.query(
    'SELECT * FROM flow_instances WHERE submission_id=$1 FOR UPDATE', [submissionId],
  );
  if (!instRows.length) return { code: 404, message: '该单据没有流程实例' };
  const inst = instRows[0];
  if (inst.status !== 'returned') return { code: 409, message: '只有被退回的单据才能修改重提' };
  if (!changes.length) return { code: 400, message: '内容没有变化，请修改后再提交' };

  const newRound = inst.round + 1;
  await client.query(
    `UPDATE submissions SET data=$2::jsonb, status='running' WHERE id=$1`,
    [submissionId, JSON.stringify(data)],
  );
  await client.query(
    `INSERT INTO submission_revisions(submission_id, instance_id, round, editor, changes, before_data, after_data)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)`,
    [submissionId, inst.id, newRound, submitter || inst.submitter, JSON.stringify(changes),
     JSON.stringify(beforeData || {}), JSON.stringify(data)],
  );
  await client.query(
    `UPDATE flow_instances
       SET status='running', round=$2, returned_at=NULL, return_comment='',
           current_node_key=NULL, current_node_name='', node_entered_at=NULL
     WHERE id=$1`,
    [inst.id, newRound],
  );
  inst.data = data;
  inst.round = newRound;
  await logEvent(
    client, inst.id, 'resubmit', null, submitter || inst.submitter,
    `修改后重新提交（第 ${newRound} 轮），共 ${changes.length} 处变更`,
  );
  const start = (inst.definition.nodes || []).find((n) => n.type === 'start');
  await enterNode(client, inst, start?.next, newRound);
  return { code: 200, instanceId: inst.id, round: newRound, changes };
}
