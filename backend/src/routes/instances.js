// 流程运行期接口：实例列表/详情、我的待办、通过/退回。
// 实例列表直接算出「当前节点 / 待办人 / 停留时长」，供看板和列表展示。
import { Router } from 'express';
import { pool } from '../db.js';
import { approveTask, returnTask } from '../flow.js';
import { userName } from '../users.js';
import { cacheDel } from '../redis.js';

const r = Router();

const LIST_SELECT = `
  SELECT fi.id, fi.flow_id, fi.flow_version, fi.form_id, fi.submission_id,
         fi.status, fi.current_node_key, fi.current_node_name,
         fi.node_entered_at, fi.round, fi.submitter, fi.started_at,
         fi.finished_at, fi.returned_at, fi.return_comment,
         f.name  AS form_name,
         fl.name AS flow_name,
         s.data AS data,
         (SELECT count(*) FROM submission_revisions sr WHERE sr.instance_id = fi.id)::int AS revision_count,
         CASE WHEN fi.node_entered_at IS NOT NULL
              THEN floor(extract(epoch FROM (now() - fi.node_entered_at)))::bigint ELSE NULL END AS waiting_seconds,
         COALESCE((SELECT json_agg(json_build_object('id', t.id, 'assignee', t.assignee, 'name', t.assignee)
                                   ORDER BY t.id)
                   FROM flow_tasks t
                   WHERE t.instance_id = fi.id AND t.round = fi.round AND t.status = 'pending'), '[]'::json) AS pending_tasks
  FROM flow_instances fi
  JOIN forms f ON f.id = fi.form_id
  JOIN flows fl ON fl.id = fi.flow_id
  JOIN submissions s ON s.id = fi.submission_id
`;

function withNames(tasks) {
  return (tasks || []).map((t) => ({ ...t, name: userName(t.assignee) }));
}

/** 实例列表：可按 formId / status / 待办人(assignee) / 发起人过滤 */
r.get('/', async (req, res, next) => {
  try {
    const where = [];
    const params = [];
    const { formId, status, assignee, submitter } = req.query;
    if (formId) { params.push(Number(formId)); where.push(`fi.form_id = $${params.length}`); }
    if (status && ['running', 'approved', 'returned'].includes(status)) {
      params.push(status); where.push(`fi.status = $${params.length}`);
    }
    if (submitter) { params.push(String(submitter)); where.push(`fi.submitter = $${params.length}`); }
    if (assignee) {
      params.push(String(assignee));
      where.push(`EXISTS (SELECT 1 FROM flow_tasks pt
                          WHERE pt.instance_id = fi.id AND pt.round = fi.round
                            AND pt.status='pending' AND pt.assignee = $${params.length})`);
    }
    const limit = Math.min(Number(req.query.limit) || 100, 200);
    const { rows } = await pool.query(
      `${LIST_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY fi.id DESC LIMIT ${limit}`,
      params,
    );
    rows.forEach((row) => { row.pending_tasks = withNames(row.pending_tasks); });
    res.json(rows);
  } catch (e) { next(e); }
});

/** 实例详情：单据 + 当前待办 + 全部任务 + 事件流水 + 修改留痕 */
r.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ message: '流程实例不存在' });
    const { rows } = await pool.query(
      `SELECT fi.*, f.name AS form_name, f.field_schema, fl.name AS flow_name,
              s.data AS data, s.created_by AS created_by, s.created_at AS submitted_at,
              CASE WHEN fi.node_entered_at IS NOT NULL
                   THEN floor(extract(epoch FROM (now() - fi.node_entered_at)))::bigint ELSE NULL END AS waiting_seconds
       FROM flow_instances fi
       JOIN forms f ON f.id = fi.form_id
       JOIN flows fl ON fl.id = fi.flow_id
       JOIN submissions s ON s.id = fi.submission_id
       WHERE fi.id = $1`,
      [id],
    );
    if (!rows.length) return res.status(404).json({ message: '流程实例不存在' });
    const inst = rows[0];

    const { rows: tasks } = await pool.query(
      `SELECT id, node_key, node_name, assignee, status, comment, round, created_at, acted_at
       FROM flow_tasks WHERE instance_id=$1 ORDER BY round, id`, [id],
    );
    const { rows: events } = await pool.query(
      `SELECT id, action, node_key, node_name, actor, comment, created_at
       FROM flow_events WHERE instance_id=$1 ORDER BY id`, [id],
    );
    const { rows: revisions } = await pool.query(
      `SELECT id, round, editor, changes, before_data, after_data, created_at
       FROM submission_revisions WHERE instance_id=$1 ORDER BY round`, [id],
    );
    const pending = tasks.filter((t) => t.status === 'pending' && t.round === inst.round);
    res.json({
      ...inst,
      tasks: tasks.map((t) => ({ ...t, name: userName(t.assignee) })),
      pending_tasks: pending.map((t) => ({ ...t, name: userName(t.assignee) })),
      events: events.map((e) => ({ ...e, actor_name: userName(e.actor) })),
      revisions: revisions.map((rv) => ({ ...rv, editor_name: userName(rv.editor) })),
    });
  } catch (e) { next(e); }
});

/** 审批中心：某用户的待办（聚合当前节点、停留时长）。须注册在 /:id 之前避免被吞掉 */
r.get('/tasks/todo', async (req, res, next) => {
  try {
    const assignee = String(req.query.assignee || '');
    if (!assignee) return res.status(400).json({ message: '缺少 assignee' });
    const { rows } = await pool.query(
      `SELECT t.id AS task_id, t.node_key, t.node_name, t.created_at AS task_created_at,
              fi.id AS instance_id, fi.status AS instance_status, fi.round,
              fi.submitter, fi.form_id, fi.submission_id,
              f.name AS form_name, f.field_schema, fl.name AS flow_name, s.data AS data,
              s.created_at AS submitted_at,
              floor(extract(epoch FROM (now() - fi.node_entered_at)))::bigint AS waiting_seconds,
              (SELECT count(*) FROM flow_tasks pt
               WHERE pt.instance_id=fi.id AND pt.round=fi.round AND pt.status='pending')::int AS pending_total
       FROM flow_tasks t
       JOIN flow_instances fi ON fi.id = t.instance_id
       JOIN forms f ON f.id = fi.form_id
       JOIN flows fl ON fl.id = fi.flow_id
       JOIN submissions s ON s.id = fi.submission_id
       WHERE t.assignee=$1 AND t.status='pending' AND fi.status='running' AND t.round=fi.round
       ORDER BY fi.node_entered_at ASC`,
      [assignee],
    );
    res.json(rows.map((x) => ({ ...x, submitter_name: userName(x.submitter) })));
  } catch (e) { next(e); }
});

async function withTaskAction(req, res, next, action) {
  const client = await pool.connect();
  try {
    const actor = String(req.body.actor || '');
    if (!actor) return res.status(400).json({ message: '缺少操作人（actor）' });
    const comment = String(req.body.comment || '');
    await client.query('BEGIN');
    const result = await action(client, {
      taskId: Number(req.params.taskId), actor, comment,
    });
    if (result.code !== 200) { await client.query('ROLLBACK'); return res.status(result.code).json({ message: result.message }); }
    await client.query('COMMIT');
    await cacheDel('activity:overview');
    res.json({ ok: true, instance_id: result.instanceId });
  } catch (e) {
    await client.query('ROLLBACK');
    next(e);
  } finally { client.release(); }
}

r.post('/tasks/:taskId/approve', (req, res, next) => withTaskAction(req, res, next, approveTask));
r.post('/tasks/:taskId/return', (req, res, next) => withTaskAction(req, res, next, returnTask));

export default r;
