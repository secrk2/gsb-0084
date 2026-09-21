// 流程设计期接口：草稿保存 / 发布 / 停用。
// 口径：一张表单同时最多一条 published + 一条 draft（DB 部分唯一索引兜底）。
// 重新发布时旧版转 archived（在途实例持其定义快照继续走完），草稿转正为新版。
import { Router } from 'express';
import { pool } from '../db.js';
import { validateFlowDefinition, validateRule, fieldMapOfSchema } from '../flowdef.js';

const r = Router();

async function loadForm(client, formId) {
  const { rows } = await client.query('SELECT * FROM forms WHERE id=$1', [formId]);
  return rows[0] || null;
}

/** 表单的流程列表（草稿 + 生效版 + 历史版） */
r.get('/', async (req, res, next) => {
  try {
    const formId = Number(req.query.formId);
    if (!formId) return res.status(400).json({ message: '缺少 formId' });
    const { rows } = await pool.query(
      `SELECT f.id, f.app_id, f.form_id, f.name, f.status, f.version,
              f.trigger_rule, f.definition, f.published_at, f.updated_at,
              (SELECT count(*) FROM flow_instances fi WHERE fi.flow_id = f.id AND fi.status='running')::int AS running_count
       FROM flows f WHERE f.form_id=$1
       ORDER BY CASE f.status WHEN 'draft' THEN 0 WHEN 'published' THEN 1 ELSE 2 END, f.id DESC`,
      [formId],
    );
    res.json(rows);
  } catch (e) { next(e); }
});

/** 设计器取数：优先草稿；无草稿则返回生效版（标注基于哪版改）；都没有返回空模板 */
r.get('/form/:formId/design', async (req, res, next) => {
  try {
    const formId = Number(req.params.formId);
    const form = await loadForm(pool, formId);
    if (!form) return res.status(404).json({ message: '表单不存在' });
    const { rows } = await pool.query(
      `SELECT * FROM flows WHERE form_id=$1 AND status IN ('draft','published')
       ORDER BY CASE status WHEN 'draft' THEN 0 ELSE 1 END`,
      [formId],
    );
    const draft = rows.find((x) => x.status === 'draft');
    const published = rows.find((x) => x.status === 'published');
    if (draft) {
      return res.json({ ...draft, base_version: published?.version || null, editable: true });
    }
    if (published) {
      return res.json({
        ...published,
        id: null, // 0 表示尚未落草稿：前端保存时新建
        status: 'draft',
        base_version: published.version,
        editable: true,
        is_copy: true,
      });
    }
    res.json({
      id: null, form_id: formId, app_id: form.app_id, name: `${form.name}审批流`,
      status: 'draft', trigger_rule: null,
      definition: { nodes: [{ key: 'start', type: 'start', next: 'end' }, { key: 'end', type: 'end' }] },
      editable: true,
    });
  } catch (e) { next(e); }
});

/** 保存（ upsert ）草稿 */
r.put('/form/:formId/draft', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const formId = Number(req.params.formId);
    const form = await loadForm(client, formId);
    if (!form) return res.status(404).json({ message: '表单不存在' });

    const name = String(req.body.name || '').trim();
    const definition = req.body.definition || { nodes: [] };
    const triggerRule = req.body.trigger_rule || null;
    if (!name) return res.status(400).json({ message: '流程名称必填' });

    const problems = validateFlowDefinition(definition, form.field_schema);
    if (triggerRule) {
      const fmap = fieldMapOfSchema(form.field_schema);
      problems.push(...validateRule(triggerRule, fmap, '触发条件'));
    }
    if (problems.length) {
      return res.status(400).json({ message: '流程设计有问题：' + problems.join('；'), problems });
    }

    const { rows: existing } = await client.query(
      `SELECT id FROM flows WHERE form_id=$1 AND status='draft'`, [formId],
    );
    let row;
    if (existing.length) {
      ({ rows: [row] } = await client.query(
        `UPDATE flows SET name=$2, trigger_rule=$3::jsonb, definition=$4::jsonb, updated_at=now()
         WHERE id=$1 RETURNING *`,
        [existing[0].id, name, JSON.stringify(triggerRule), JSON.stringify(definition)],
      ));
    } else {
      ({ rows: [row] } = await client.query(
        `INSERT INTO flows(app_id, form_id, name, status, trigger_rule, definition)
         VALUES ($1,$2,$3,'draft',$4::jsonb,$5::jsonb) RETURNING *`,
        [form.app_id, formId, name, JSON.stringify(triggerRule), JSON.stringify(definition)],
      ));
    }
    res.json(row);
  } catch (e) { next(e); }
  finally { client.release(); }
});

/**
 * 发布草稿：
 * 1) 旧 published → archived（在途实例的 flow_id 仍指向它、定义已快照，照常走完）
 * 2) 草稿 → published，version = 旧版 version + 1
 * 全部单据后续新提交都走新版。
 */
r.post('/:id/publish', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: draftRows } = await client.query('SELECT * FROM flows WHERE id=$1 FOR UPDATE', [Number(req.params.id)]);
    if (!draftRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ message: '流程不存在' }); }
    const draft = draftRows[0];
    if (draft.status !== 'draft') { await client.query('ROLLBACK'); return res.status(409).json({ message: '只有草稿可以发布' }); }

    const { rows: formRows } = await client.query('SELECT * FROM forms WHERE id=$1', [draft.form_id]);
    const form = formRows[0];
    const problems = validateFlowDefinition(draft.definition, form.field_schema);
    if (problems.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: '流程设计有问题，无法发布：' + problems.join('；'), problems });
    }

    const { rows: oldRows } = await client.query(
      `SELECT id, version FROM flows WHERE form_id=$1 AND status='published' FOR UPDATE`, [draft.form_id],
    );
    const nextVersion = (oldRows[0]?.version || 0) + 1;
    if (oldRows.length) {
      await client.query(`UPDATE flows SET status='archived' WHERE id=$1`, [oldRows[0].id]);
    }
    const { rows: updated } = await client.query(
      `UPDATE flows SET status='published', version=$2, published_at=now(), updated_at=now()
       WHERE id=$1 RETURNING *`,
      [draft.id, nextVersion],
    );
    await client.query('COMMIT');
    res.json(updated[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    next(e);
  } finally { client.release(); }
});

/** 停用生效流程：archived。在途实例继续按快照走完，之后的新提交不再发起审批。 */
r.post('/:id/unpublish', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE flows SET status='archived', updated_at=now()
       WHERE id=$1 AND status='published' RETURNING *`,
      [Number(req.params.id)],
    );
    if (!rows.length) return res.status(404).json({ message: '生效流程不存在或已停用' });
    res.json(rows[0]);
  } catch (e) { next(e); }
});

/** 删除草稿（生效版/历史版不允许删，在途实例需要追溯） */
r.delete('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`DELETE FROM flows WHERE id=$1 AND status='draft' RETURNING id`, [Number(req.params.id)]);
    if (!rows.length) return res.status(409).json({ message: '只能删除未发布的草稿' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default r;
