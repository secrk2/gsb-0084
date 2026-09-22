// 流程实例与审批操作：待办、单据详情（当前节点/停留时长/时间线/版本）、通过/驳回/退回
import { Router } from 'express';
import { pool } from '../db.js';
import { approve, reject, returnTask, getInstanceDetail, FlowError } from '../flow/runtime.js';

const r = Router();

function actorOf(req) {
  return String(req.header('x-actor') || req.body.actor || req.query.actor || '').trim();
}

/**
 * 待办：两部分
 * 1) 审批人名下 pending 任务；
 * 2) 退回到发起人、等待其改单重提的单据（发起人视角的待办）。
 */
r.get('/todo', async (req, res, next) => {
  try {
    const assignee = String(req.query.assignee || '').trim();
    if (!assignee) return res.status(400).json({ message: '缺少 assignee' });
    const { rows } = await pool.query(
      `SELECT * FROM (
         SELECT t.id AS task_id, t.node_id, t.node_name, t.assignee, t.created_at AS task_created_at,
                t.stage_idx, t.branch_idx, t.seq,
                i.id AS instance_id, i.flow_id, i.status AS instance_status, i.node_cursor,
                s.id AS submission_id, s.form_id, s.status AS submission_status, s.created_by,
                f.name AS form_name, s.data, s.created_at AS submitted_at,
                fl.name AS flow_name, 'approve' AS todo_kind
         FROM flow_tasks t
         JOIN flow_instances i ON i.id = t.instance_id
         JOIN submissions s ON s.id = i.submission_id
         JOIN forms f ON f.id = s.form_id
         JOIN flows fl ON fl.id = i.flow_id
         WHERE t.assignee = $1 AND t.status = 'pending' AND i.status = 'running'

         UNION ALL

         SELECT NULL AS task_id, NULL AS node_id, '退回发起人 · 待改单重提' AS node_name,
                s.created_by AS assignee,
                (SELECT max(a.created_at) FROM flow_actions a
                   JOIN flow_instances fi2 ON fi2.id = a.instance_id
                  WHERE fi2.submission_id = s.id AND a.action = 'return_initiator') AS task_created_at,
                NULL, NULL, NULL,
                i.id AS instance_id, i.flow_id, i.status AS instance_status, i.node_cursor,
                s.id AS submission_id, s.form_id, s.status AS submission_status, s.created_by,
                f.name AS form_name, s.data, s.created_at AS submitted_at,
                fl.name AS flow_name, 'resubmit' AS todo_kind
         FROM submissions s
         JOIN flow_instances i ON i.submission_id = s.id
         JOIN forms f ON f.id = s.form_id
         JOIN flows fl ON fl.id = i.flow_id
         WHERE s.status = 'returned' AND s.created_by = $1
       ) todo ORDER BY task_created_at DESC`,
      [assignee],
    );
    res.json(rows);
  } catch (e) { next(e); }
});

/** 实例列表（可按表单过滤） */
r.get('/', async (req, res, next) => {
  try {
    const { formId, status } = req.query;
    const conds = [];
    const args = [];
    if (formId) { args.push(Number(formId)); conds.push(`i.form_id = $${args.length}`); }
    if (status) { args.push(String(status)); conds.push(`s.status = $${args.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT i.id AS instance_id, i.status, i.current_stage, i.node_cursor, i.started_at, i.finished_at,
              s.id AS submission_id, s.form_id, s.status AS submission_status, s.data, s.created_by, s.created_at,
              f.name AS form_name, fl.name AS flow_name, fl.version AS flow_version,
              (SELECT count(*) FROM flow_tasks t WHERE t.instance_id = i.id AND t.status = 'pending')::int AS pending_count,
              (SELECT string_agg(t.assignee, ',') FROM flow_tasks t
                 WHERE t.instance_id = i.id AND t.status = 'pending') AS pending_assignees
       FROM flow_instances i
       JOIN submissions s ON s.id = i.submission_id
       JOIN forms f ON f.id = s.form_id
       JOIN flows fl ON fl.id = i.flow_id
       ${where}
       ORDER BY i.id DESC LIMIT 200`,
      args,
    );
    res.json(rows);
  } catch (e) { next(e); }
});

/** 单据的流程详情：当前节点/待处理人/停留时长/节点进度/时间线/改单版本 */
r.get('/by-submission/:submissionId', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const detail = await getInstanceDetail(client, Number(req.params.submissionId));
    res.json(detail);
  } catch (e) {
    if (e instanceof FlowError) return res.status(e.status).json({ message: e.message });
    next(e);
  } finally { client.release(); }
});

async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

function handleAction(fn) {
  return async (req, res, next) => {
    try {
      const actor = actorOf(req);
      if (!actor) return res.status(400).json({ message: '缺少操作人（actor）' });
      const taskId = Number(req.params.taskId);
      const comment = String(req.body.comment || '').slice(0, 500);
      let submissionId = null;
      await withTx(async (client) => {
        const out = await fn(client, { taskId, actor, comment, body: req.body });
        submissionId = out?.submission_id ?? null;
      });
      let detail = null;
      const client = await pool.connect();
      try {
        if (!submissionId) {
          const { rows } = await client.query('SELECT submission_id FROM flow_tasks WHERE id = $1', [taskId]);
          submissionId = rows[0]?.submission_id ?? null;
        }
        if (submissionId) detail = await getInstanceDetail(client, submissionId);
      } finally { client.release(); }
      res.json({ ok: true, detail });
    } catch (e) {
      if (e instanceof FlowError) return res.status(e.status).json({ message: e.message });
      next(e);
    }
  };
}

r.post('/tasks/:taskId/approve', handleAction((client, opts) => approve(client, opts)));
r.post('/tasks/:taskId/reject', handleAction((client, opts) => reject(client, opts)));
r.post('/tasks/:taskId/return', handleAction((client, opts) =>
  returnTask(client, { ...opts, target: opts.body.target === 'previous' ? 'previous' : 'initiator' })));

export default r;
