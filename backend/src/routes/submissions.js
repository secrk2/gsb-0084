import { Router } from 'express';
import { pool } from '../db.js';
import { applyDefaults, validateSubmission } from '../fields.js';
import { cacheDel } from '../redis.js';
import { startFlow, resubmit, FlowError } from '../flow/runtime.js';
import { diffData } from '../flow/engine.js';

const r = Router();

function actorOf(req) {
  return String(req.header('x-actor') || req.body.actor || '').trim();
}

async function attachmentChecker(ids) {
  if (!ids.length) return [];
  const { rows } = await pool.query(
    `SELECT id FROM attachments WHERE id = ANY($1::int[])`,
    [ids],
  );
  const exist = new Set(rows.map((x) => x.id));
  return ids.filter((id) => !exist.has(id));
}

r.get('/', async (req, res, next) => {
  try {
    const { formId, limit = 20 } = req.query;
    if (!formId) return res.status(400).json({ message: '缺少 formId' });
    const { rows } = await pool.query(
      `SELECT s.id, s.form_id, s.form_ver, s.data, s.status, s.created_by, s.created_at,
              fi.id AS instance_id, fi.status AS instance_status, fi.node_cursor,
              fl.id AS flow_id, fl.name AS flow_name, fl.version AS flow_version, fl.status AS flow_version_status,
              (SELECT count(*) FROM flow_tasks t WHERE t.instance_id = fi.id AND t.status = 'pending')::int AS pending_count,
              (SELECT string_agg(t.assignee, ',' ORDER BY t.id)
                 FROM flow_tasks t WHERE t.instance_id = fi.id AND t.status = 'pending') AS pending_assignees,
              (SELECT min(t.created_at) FROM flow_tasks t
                 WHERE t.instance_id = fi.id AND t.status = 'pending') AS pending_since,
              (SELECT n.node_name FROM flow_tasks n
                 WHERE n.instance_id = fi.id AND n.status = 'pending'
                 ORDER BY n.id LIMIT 1) AS current_node_name
       FROM submissions s
       LEFT JOIN flow_instances fi ON fi.submission_id = s.id
       LEFT JOIN flows fl ON fl.id = fi.flow_id
       WHERE s.form_id = $1
       ORDER BY s.id DESC LIMIT $2`,
      [Number(formId), Math.min(Number(limit) || 20, 200)],
    );
    res.json(rows);
  } catch (e) { next(e); }
});

async function validateData(client, form, data, excludeSubmissionId = null) {
  return validateSubmission(form.field_schema, data, {
    uniqueChecker: async (key, value) => {
      const { rows } = await client.query(
        `SELECT 1 FROM submissions
         WHERE form_id = $1 AND data #>> $2::text[] = $3
         ${excludeSubmissionId ? 'AND id <> $4' : ''}
         LIMIT 1`,
        excludeSubmissionId
          ? [form.id, key.split('.'), String(value), excludeSubmissionId]
          : [form.id, key.split('.'), String(value)],
      );
      return rows.length > 0;
    },
    attachmentChecker,
  });
}

async function logValidationErrors(client, formId, errors) {
  for (const e of errors.slice(0, 50)) {
    await client.query(
      `INSERT INTO validation_errors(form_id, field_key, field_label, error_code, message)
       VALUES ($1,$2,$3,$4,$5)`,
      [formId, e.fieldKey, e.fieldLabel, e.code, e.message.slice(0, 300)],
    );
  }
}

r.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const formId = Number(req.body.form_id || req.body.formId);
    if (!formId) return res.status(400).json({ message: '缺少 formId' });
    const { rows: formRows } = await client.query('SELECT * FROM forms WHERE id = $1', [formId]);
    if (!formRows.length) return res.status(404).json({ message: '表单不存在或已删除' });
    const form = formRows[0];
    const actor = actorOf(req);
    const data = applyDefaults(form.field_schema, req.body.data || {});

    const { errors } = await validateData(client, form, data);
    if (errors.length) {
      await logValidationErrors(client, formId, errors);
      return res.status(422).json({ message: '提交内容未通过校验', errors });
    }

    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO submissions(form_id, form_ver, data, status, created_by)
       VALUES ($1,$2,$3::jsonb,'submitted',$4)
       RETURNING id, form_id, form_ver, data, status, created_by, created_at`,
      [formId, form.version, JSON.stringify(data), actor],
    );
    const submission = rows[0];
    // 首版快照（change_summary 为空，表示初次提交）
    await client.query(
      `INSERT INTO submission_revisions(submission_id, revision, data, change_summary, created_by)
       VALUES ($1,1,$2::jsonb,'[]'::jsonb,$3)`,
      [submission.id, JSON.stringify(data), actor],
    );
    // 若该表单有生效流程则启动审批；无流程则单据直接收数（status=submitted）
    const instance = await startFlow(client, { submission, data });
    await client.query('COMMIT');
    await cacheDel('activity:overview');
    res.status(201).json({ ...submission, instance_id: instance?.id || null, has_flow: !!instance });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e instanceof FlowError) return res.status(e.status).json({ message: e.message });
    next(e);
  } finally {
    client.release();
  }
});

/** 退回发起人后改单重新提交：按当前 schema 校验 → diff 留痕 → 按新数据从头重走流程 */
r.put('/:id/resubmit', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const submissionId = Number(req.params.id);
    const actor = actorOf(req);
    if (!actor) return res.status(400).json({ message: '缺少操作人（actor）' });

    const { rows: srows } = await client.query('SELECT * FROM submissions WHERE id = $1', [submissionId]);
    if (!srows.length) return res.status(404).json({ message: '单据不存在' });
    const submission = srows[0];
    if (submission.status !== 'returned') {
      return res.status(409).json({ message: '只有被退回发起人的单据才能修改重提' });
    }
    if (submission.created_by && actor !== submission.created_by) {
      return res.status(403).json({ message: '只有发起人本人才能修改并重新提交该单据' });
    }
    const { rows: frows } = await client.query('SELECT * FROM forms WHERE id = $1', [submission.form_id]);
    const form = frows[0];
    const data = applyDefaults(form.field_schema, req.body.data || {});

    const { errors } = await validateData(client, form, data, submissionId);
    if (errors.length) {
      await logValidationErrors(client, form.id, errors);
      return res.status(422).json({ message: '提交内容未通过校验', errors });
    }

    const changes = diffData(submission.data, data, form.field_schema);
    await client.query('BEGIN');
    const inst = await resubmit(client, { submissionId, actor, data, form, changes });
    await client.query('COMMIT');
    await cacheDel('activity:overview');
    res.json({ ok: true, instance_id: inst?.id || null, changed: changes.length });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e instanceof FlowError) return res.status(e.status).json({ message: e.message });
    next(e);
  } finally {
    client.release();
  }
});

/** 重提前预览：返回与上一版的字段级 diff（前端弹确认用，不落库） */
r.post('/:id/resubmit/diff', async (req, res, next) => {
  try {
    const submissionId = Number(req.params.id);
    const { rows: srows } = await pool.query('SELECT * FROM submissions WHERE id = $1', [submissionId]);
    if (!srows.length) return res.status(404).json({ message: '单据不存在' });
    const { rows: frows } = await pool.query('SELECT * FROM forms WHERE id = $1', [srows[0].form_id]);
    const form = frows[0];
    const data = applyDefaults(form.field_schema, req.body.data || {});
    res.json(diffData(srows[0].data, data, form.field_schema));
  } catch (e) { next(e); }
});

export default r;
