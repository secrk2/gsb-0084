// 审批流定义管理：草稿 / 发布（同表单唯一生效）/ 新版本 / 停用
import { Router } from 'express';
import { pool } from '../db.js';
import { validateDefinition, legacyRefFields } from '../flow/engine.js';

const r = Router();

async function loadFlow(id) {
  const { rows } = await pool.query('SELECT * FROM flows WHERE id = $1', [id]);
  return rows[0] || null;
}

function syncLegacyRefs(definition) {
  // 旧版引用拦截（references.findReferences）仍读这三列，由 definition 派生
  const refs = legacyRefFields(definition);
  return refs;
}

/** 某表单的流程版本列表 */
r.get('/', async (req, res, next) => {
  try {
    const { formId } = req.query;
    if (!formId) return res.status(400).json({ message: '缺少 formId' });
    const { rows } = await pool.query(
      `SELECT id, name, version, status, published_at, created_at, updated_at
       FROM flows WHERE form_id = $1 ORDER BY version DESC, id DESC`,
      [Number(formId)],
    );
    res.json(rows);
  } catch (e) { next(e); }
});

/** 某表单当前生效的流程（可能为空） */
r.get('/active', async (req, res, next) => {
  try {
    const { formId } = req.query;
    if (!formId) return res.status(400).json({ message: '缺少 formId' });
    const { rows } = await pool.query(
      `SELECT id, name, version, status, definition, published_at, updated_at
       FROM flows WHERE form_id = $1 AND status = 'active' LIMIT 1`,
      [Number(formId)],
    );
    res.json(rows[0] || null);
  } catch (e) { next(e); }
});

/** 新建草稿（也允许复制某条已有版本：body.copy_from） */
r.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const formId = Number(req.body.form_id || req.body.formId);
    const name = String(req.body.name || '').trim();
    if (!formId) return res.status(400).json({ message: '缺少 formId' });
    if (!name) return res.status(400).json({ message: '流程名称必填' });

    const { rows: frows } = await client.query('SELECT * FROM forms WHERE id = $1', [formId]);
    if (!frows.length) return res.status(404).json({ message: '表单不存在' });
    const form = frows[0];

    let definition = req.body.definition || [];
    if (req.body.copy_from) {
      const { rows } = await client.query('SELECT definition FROM flows WHERE id = $1 AND form_id = $2',
        [Number(req.body.copy_from), formId]);
      if (!rows.length) return res.status(404).json({ message: '被复制的流程不存在' });
      definition = rows[0].definition;
    }
    const problems = validateDefinition(definition, form.field_schema, { strict: false });
    if (problems.length) return res.status(400).json({ message: '流程设置有问题：' + problems.join('；'), problems });

    const { rows: vrows } = await client.query(
      'SELECT coalesce(max(version), 0) AS v FROM flows WHERE form_id = $1', [formId],
    );
    const nextVersion = vrows[0].v + 1;
    const legacy = syncLegacyRefs(definition);
    const { rows } = await client.query(
      `INSERT INTO flows(app_id, form_id, name, definition, version, status,
                         trigger_field, condition_field, approver_field)
       VALUES ($1,$2,$3,$4::jsonb,$5,'draft',$6,$7,$8) RETURNING *`,
      [form.app_id, formId, name, JSON.stringify(definition), nextVersion,
       legacy.trigger_field, legacy.condition_field, legacy.approver_field],
    );
    res.status(201).json(rows[0]);
  } catch (e) { next(e); } finally { client.release(); }
});

r.get('/:id', async (req, res, next) => {
  try {
    const flow = await loadFlow(req.params.id);
    if (!flow) return res.status(404).json({ message: '流程不存在' });
    res.json(flow);
  } catch (e) { next(e); }
});

/** 保存草稿（仅 draft 可改；生效流程需先「新建版本」） */
r.put('/:id', async (req, res, next) => {
  try {
    const flow = await loadFlow(req.params.id);
    if (!flow) return res.status(404).json({ message: '流程不存在' });
    if (flow.status !== 'draft') {
      return res.status(409).json({ message: '生效中的流程不能直接修改，请先「新建版本」改完再发布' });
    }
    const { rows: frows } = await pool.query('SELECT field_schema FROM forms WHERE id = $1', [flow.form_id]);
    const definition = req.body.definition !== undefined ? req.body.definition : flow.definition;
    const problems = validateDefinition(definition, frows[0].field_schema, { strict: false });
    if (problems.length) return res.status(400).json({ message: '流程设置有问题：' + problems.join('；'), problems });

    const name = req.body.name !== undefined ? String(req.body.name).trim() : flow.name;
    if (!name) return res.status(400).json({ message: '流程名称必填' });
    const legacy = syncLegacyRefs(definition);
    const { rows } = await pool.query(
      `UPDATE flows SET name = $2, definition = $3::jsonb, updated_at = now(),
                        trigger_field = $4, condition_field = $5, approver_field = $6
       WHERE id = $1 RETURNING *`,
      [flow.id, name, JSON.stringify(definition),
       legacy.trigger_field, legacy.condition_field, legacy.approver_field],
    );
    res.json(rows[0]);
  } catch (e) { next(e); }
});

/**
 * 发布：事务内把该表单现有 active 流程转 archived，再把本草稿置 active。
 * 已在跑的单据实例绑定旧 flow_id，继续按旧定义走完，不迁移、不追溯；
 * 此后新提交的单据走新流程。
 */
r.post('/:id/publish', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM flows WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ message: '流程不存在' }); }
    const flow = rows[0];
    if (flow.status === 'active') { await client.query('ROLLBACK'); return res.status(409).json({ message: '该流程已是生效状态' }); }
    if (flow.status === 'archived') { await client.query('ROLLBACK'); return res.status(409).json({ message: '已归档流程不能发布，请新建版本' }); }

    const { rows: frows } = await client.query('SELECT field_schema FROM forms WHERE id = $1', [flow.form_id]);
    const problems = validateDefinition(flow.definition, frows[0].field_schema);
    if (problems.length) { await client.query('ROLLBACK'); return res.status(400).json({ message: '流程设置有问题：' + problems.join('；'), problems }); }

    const { rows: statRows } = await client.query(
      `SELECT count(*)::int AS running FROM flow_instances WHERE form_id = $1 AND status = 'running'`,
      [flow.form_id],
    );
    await client.query(
      `UPDATE flows SET status = 'archived', updated_at = now()
       WHERE form_id = $1 AND status = 'active'`,
      [flow.form_id],
    );
    const { rows: updated } = await client.query(
      `UPDATE flows SET status = 'active', published_at = now(), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [flow.id],
    );
    await client.query('COMMIT');
    res.json({ flow: updated[0], running_on_previous: statRows[0].running });
  } catch (e) {
    await client.query('ROLLBACK');
    next(e);
  } finally { client.release(); }
});

/** 停用生效流程（停用后新单据不再走审批，直接收数；在跑的实例不受影响） */
r.post('/:id/disable', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM flows WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ message: '流程不存在' }); }
    if (rows[0].status !== 'active') { await client.query('ROLLBACK'); return res.status(409).json({ message: '只有生效中的流程可以停用' }); }
    const { rows: updated } = await client.query(
      `UPDATE flows SET status = 'archived', updated_at = now() WHERE id = $1 RETURNING *`,
      [req.params.id],
    );
    await client.query('COMMIT');
    res.json(updated[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    next(e);
  } finally { client.release(); }
});

/** 基于某流程（通常是 active）创建下一版草稿，definition 原样复制 */
r.post('/:id/new-version', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM flows WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ message: '流程不存在' }); }
    const base = rows[0];
    const { rows: vrows } = await client.query(
      'SELECT coalesce(max(version), 0) AS v FROM flows WHERE form_id = $1', [base.form_id],
    );
    const { rows: ins } = await client.query(
      `INSERT INTO flows(app_id, form_id, name, definition, version, status,
                         trigger_field, condition_field, approver_field)
       VALUES ($1,$2,$3,$4::jsonb,$5,'draft',$6,$7,$8) RETURNING *`,
      [base.app_id, base.form_id, base.name, JSON.stringify(base.definition), vrows[0].v + 1,
       base.trigger_field, base.condition_field, base.approver_field],
    );
    await client.query('COMMIT');
    res.status(201).json(ins[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    next(e);
  } finally { client.release(); }
});

export default r;
