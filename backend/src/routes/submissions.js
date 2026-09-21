import { Router } from 'express';
import { pool } from '../db.js';
import { applyDefaults, validateSubmission } from '../fields.js';
import { cacheDel } from '../redis.js';

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

r.get('/', async (req, res, next) => {
  try {
    const { formId, limit = 20 } = req.query;
    if (!formId) return res.status(400).json({ message: '缺少 formId' });
    const { rows } = await pool.query(
      `SELECT id, form_id, form_ver, data, status, created_at
       FROM submissions WHERE form_id = $1 ORDER BY id DESC LIMIT $2`,
      [Number(formId), Math.min(Number(limit) || 20, 200)],
    );
    res.json(rows);
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
    const data = applyDefaults(form.field_schema, req.body.data || {});

    const { errors } = await validateSubmission(form.field_schema, data, {
      uniqueChecker: async (key, value) => {
        const { rows } = await client.query(
          `SELECT 1 FROM submissions WHERE form_id = $1 AND data #>> $2::text[] = $3 LIMIT 1`,
          [formId, key.split('.'), String(value)],
        );
        return rows.length > 0;
      },
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

    const { rows } = await client.query(
      `INSERT INTO submissions(form_id, form_ver, data, status)
       VALUES ($1,$2,$3::jsonb,'submitted')
       RETURNING id, form_id, form_ver, data, status, created_at`,
      [formId, form.version, JSON.stringify(data)],
    );
    await cacheDel('activity:overview');
    res.status(201).json(rows[0]);
  } catch (e) {
    next(e);
  } finally {
    client.release();
  }
});

export default r;
