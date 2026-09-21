import { Router } from 'express';
import { pool } from '../db.js';
import { validateSchema } from '../fields.js';
import { collectCandidates, findFieldByPath, findReferences, removeFieldByPath, walkFields } from '../references.js';
import { cacheDel } from '../redis.js';

const r = Router();

async function loadForm(id) {
  const { rows } = await pool.query('SELECT * FROM forms WHERE id = $1', [id]);
  return rows[0] || null;
}

r.get('/', async (req, res, next) => {
  try {
    const { appId } = req.query;
    const { rows } = await pool.query(
      `SELECT f.id, f.app_id, f.name, f.description, f.version, f.updated_at,
              (SELECT count(*) FROM submissions s WHERE s.form_id = f.id)::int AS submission_count,
              (SELECT count(*) FROM flows fl WHERE fl.form_id = f.id)::int AS flow_count,
              (SELECT count(*) FROM form_views v WHERE v.form_id = f.id)::int AS view_count
       FROM forms f ${appId ? 'WHERE f.app_id = $1' : ''} ORDER BY f.id`,
      appId ? [Number(appId)] : [],
    );
    res.json(rows);
  } catch (e) { next(e); }
});

r.get('/:id', async (req, res, next) => {
  try {
    const form = await loadForm(req.params.id);
    if (!form) return res.status(404).json({ message: '表单不存在' });
    res.json(form);
  } catch (e) { next(e); }
});

r.post('/', async (req, res, next) => {
  try {
    const appId = Number(req.body.app_id || req.body.appId);
    const name = String(req.body.name || '').trim();
    const schema = req.body.field_schema || req.body.fieldSchema || [];
    if (!appId) return res.status(400).json({ message: '请选择所属应用' });
    if (!name) return res.status(400).json({ message: '表单名称必填' });
    const problems = validateSchema(schema);
    if (problems.length) return res.status(400).json({ message: '字段设置有问题：' + problems.join('；'), problems });

    const { rows: appRows } = await pool.query('SELECT 1 FROM apps WHERE id=$1', [appId]);
    if (!appRows.length) return res.status(400).json({ message: '所属应用不存在' });

    const { rows } = await pool.query(
      `INSERT INTO forms(app_id, name, description, field_schema, version)
       VALUES ($1,$2,$3,$4::jsonb,1) RETURNING *`,
      [appId, name, String(req.body.description || ''), JSON.stringify(schema)],
    );
    await cacheDel('activity:overview');
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

r.put('/:id', async (req, res, next) => {
  try {
    const form = await loadForm(req.params.id);
    if (!form) return res.status(404).json({ message: '表单不存在' });
    const schema = req.body.field_schema || req.body.fieldSchema || form.field_schema;
    const problems = validateSchema(schema);
    if (problems.length) return res.status(400).json({ message: '字段设置有问题：' + problems.join('；'), problems });

    // 防止通过整表覆盖删掉被流程 / 视图引用的字段
    const newPaths = new Set();
    walkFields(schema, (f, path) => newPaths.add(path));
    const removedCandidates = [];
    walkFields(form.field_schema, (f, path) => {
      if (!newPaths.has(path)) removedCandidates.push({ path, key: f.key, label: f.label });
    });
    if (removedCandidates.length) {
      const references = await findReferences(form.id, removedCandidates);
      if (references.length) {
        const labels = removedCandidates.map((c) => c.label).slice(0, 3).join('、');
        return res.status(409).json({
          message: `保存被拦截：字段「${labels}」等正被流程或视图引用，请先解除引用`,
          blocked: true,
          references,
        });
      }
    }

    const { rows } = await pool.query(
      `UPDATE forms SET name = COALESCE($2, name),
                        description = COALESCE($3, description),
                        field_schema = $4::jsonb,
                        version = version + 1,
                        updated_at = now()
       WHERE id = $1 RETURNING *`,
      [form.id, req.body.name ? String(req.body.name) : null,
       req.body.description !== undefined ? String(req.body.description) : null,
       JSON.stringify(schema)],
    );
    res.json(rows[0]);
  } catch (e) { next(e); }
});

/**
 * 删除字段（路径形如 key 或 parentKey.childKey）。
 * 被流程 / 视图引用时 409 拦下，返回引用明细说清楚被谁引用。
 */
r.post('/:id/fields/remove', async (req, res, next) => {
  try {
    const form = await loadForm(req.params.id);
    if (!form) return res.status(404).json({ message: '表单不存在' });
    const path = String(req.body.path || '');
    if (!path) return res.status(400).json({ message: '缺少字段路径' });

    const target = findFieldByPath(form.field_schema, path);
    if (!target) return res.status(404).json({ message: '字段不存在，可能已被删除' });

    const candidates = collectCandidates(target, path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : '');
    const references = await findReferences(form.id, candidates);
    if (references.length) {
      return res.status(409).json({
        message: `字段「${target.label}」正被 ${references.length} 处流程或视图引用，不能删除`,
        blocked: true,
        references,
      });
    }

    removeFieldByPath(form.field_schema, path);
    const { rows } = await pool.query(
      `UPDATE forms SET field_schema = $2::jsonb, version = version + 1, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [form.id, JSON.stringify(form.field_schema)],
    );
    res.json({ blocked: false, form: rows[0] });
  } catch (e) { next(e); }
});

/** 只做引用检查（前端点删除时先弹确认用），不落库 */
r.post('/:id/fields/check-delete', async (req, res, next) => {
  try {
    const form = await loadForm(req.params.id);
    if (!form) return res.status(404).json({ message: '表单不存在' });
    const path = String(req.body.path || '');
    const target = findFieldByPath(form.field_schema, path);
    if (!target) return res.status(404).json({ message: '字段不存在' });
    const candidates = collectCandidates(target, path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : '');
    const references = await findReferences(form.id, candidates);
    res.json({ blocked: references.length > 0, fieldLabel: target.label, references });
  } catch (e) { next(e); }
});

export default r;
