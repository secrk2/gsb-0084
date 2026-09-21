import { Router } from 'express';
import { pool } from '../db.js';
import { applyDefaults, validateSubmission } from '../fields.js';
import { cacheDel } from '../redis.js';
import { startInstance, resubmitInstance } from '../flow.js';
import { diffSubmission } from '../flowdef.js';

const r = Router();

async function attachmentChecker(ids) {
  if (!ids.length) return [];
  const { rows } = await pool.query(
    `SELECT id FROM attachments WHERE id = ANY($1::int[])`,
    [ids],
  );
  const exist = new Set(rows.map((x) => x.id));
  return ids.filter((id) => !exist.has(id));
}

async function uniqueChecker(client, formId, key, value, ignoreSubmissionId = null) {
  const { rows } = await client.query(
    `SELECT 1 FROM submissions
     WHERE form_id = $1 AND data #>> $2::text[] = $3
       ${ignoreSubmissionId ? 'AND id <> $4' : ''}
     LIMIT 1`,
    ignoreSubmissionId
      ? [formId, key.split('.'), String(value), ignoreSubmissionId]
      : [formId, key.split('.'), String(value)],
  );
  return rows.length > 0;
}

r.get('/', async (req, res, next) => {
  try {
    const { formId, limit = 20 } = req.query;
    if (!formId) return res.status(400).json({ message: '缺少 formId' });
    const { rows } = await pool.query(
      `SELECT s.id, s.form_id, s.form_ver, s.data, s.status, s.created_by, s.created_at,
              fi.id AS instance_id, fi.current_node_name, fi.round,
              fi.node_entered_at,
              CASE WHEN fi.node_entered_at IS NOT NULL
                   THEN floor(extract(epoch FROM (now() - fi.node_entered_at)))::bigint ELSE NULL END AS waiting_seconds
       FROM submissions s
       LEFT JOIN flow_instances fi ON fi.submission_id = s.id
       WHERE s.form_id = $1 ORDER BY s.id DESC LIMIT $2`,
      [Number(formId), Math.min(Number(limit) || 20, 200)],
    );
    res.json(rows);
  } catch (e) { next(e); }
});

r.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*, fi.id AS instance_id
       FROM submissions s LEFT JOIN flow_instances fi ON fi.submission_id = s.id
       WHERE s.id = $1`,
      [Number(req.params.id)],
    );
    if (!rows.length) return res.status(404).json({ message: '单据不存在' });
    res.json(rows[0]);
  } catch (e) { next(e); }
});

r.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const formId = Number(req.body.form_id || req.body.formId);
    if (!formId) {
      return res.status(400).json({ message: '缺少 formId' });
    }
    const { rows: formRows } = await client.query(
      'SELECT * FROM forms WHERE id = $1', [formId],
    );
    if (!formRows.length) return res.status(404).json({ message: '表单不存在或已删除' });
    const form = formRows[0];
    const submitter = String(req.body.created_by || req.body.createdBy || '').slice(0, 64);
    const data = applyDefaults(form.field_schema, req.body.data || {});

    const { errors } = await validateSubmission(form.field_schema, data, {
      uniqueChecker: (key, value) => uniqueChecker(client, formId, key, value),
      attachmentChecker,
    });

    if (errors.length) {
      // 落库校验失败明细，供「应用动态」统计热点字段
      for (const e of errors.slice(0, 50)) {
        await client.query(
          `INSERT INTO validation_errors(form_id, field_key, field_label, error_code, message)
           VALUES ($1,$2,$3,$4,$5)`,
          [formId, e.fieldKey, e.fieldLabel, e.code, e.message.slice(0, 300)],
        );
      }
      return res.status(422).json({ message: '提交内容未通过校验', errors });
    }

    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO submissions(form_id, form_ver, data, status, created_by)
       VALUES ($1,$2,$3::jsonb,'submitted',$4)
       RETURNING id, form_id, form_ver, data, status, created_by, created_at`,
      [formId, form.version, JSON.stringify(data), submitter],
    );
    const submission = rows[0];
    // 挂了生效流程且满足触发条件 → 发起审批实例（状态变 running）；否则维持普通 submitted
    const instance = await startInstance(client, { form, submission, submitter });
    await client.query('COMMIT');
    await cacheDel('activity:overview');
    res.status(201).json({ ...submission, instance_id: instance?.id || null });
  } catch (e) {
    await client.query('ROLLBACK');
    next(e);
  } finally {
    client.release();
  }
});

/**
 * 退回后修改重提：
 * 仍按表单当前元数据重新校验（含唯一值查重，排除自身）；
 * 与上一版数据做字段级 diff 留痕（改前改后都保留）；无变化 400。
 */
r.put('/:id/resubmit', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const { rows: subRows } = await client.query('SELECT * FROM submissions WHERE id=$1 FOR UPDATE', [id]);
    if (!subRows.length) return res.status(404).json({ message: '单据不存在' });
    const submission = subRows[0];
    if (submission.status !== 'returned') {
      return res.status(409).json({ message: '只有被退回的单据才能修改重提' });
    }
    const { rows: formRows } = await client.query('SELECT * FROM forms WHERE id=$1', [submission.form_id]);
    const form = formRows[0];
    const submitter = String(req.body.created_by || req.body.createdBy || submission.created_by).slice(0, 64);
    const data = applyDefaults(form.field_schema, req.body.data || {});

    const { errors } = await validateSubmission(form.field_schema, data, {
      uniqueChecker: (key, value) => uniqueChecker(client, form.id, key, value, id),
      attachmentChecker,
    });
    if (errors.length) {
      return res.status(422).json({ message: '提交内容未通过校验', errors });
    }

    const changes = diffSubmission(form.field_schema, submission.data, data);
    await client.query('BEGIN');
    const result = await resubmitInstance(client, {
      submissionId: id, submitter, data, beforeData: submission.data, changes,
    });
    if (result.code !== 200) {
      await client.query('ROLLBACK');
      return res.status(result.code).json({ message: result.message });
    }
    await client.query('COMMIT');
    await cacheDel('activity:overview');
    res.json({ ok: true, instance_id: result.instanceId, round: result.round, changes: result.changes });
  } catch (e) {
    await client.query('ROLLBACK');
    next(e);
  } finally {
    client.release();
  }
});

export default r;
