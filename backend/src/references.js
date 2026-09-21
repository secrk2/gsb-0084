import { pool } from './db.js';

/**
 * 待删字段及其全部后代：{ path: 全路径('a.b') / key: 裸 key / label }
 * schema 设计期保证 key 全表唯一，因此裸 key 与全路径匹配都安全。
 */
export function collectCandidates(field, parentPath = '') {
  const selfPath = parentPath ? `${parentPath}.${field.key}` : field.key;
  const out = [{ path: selfPath, key: field.key, label: field.label }];
  for (const child of field.children || []) {
    out.push(...collectCandidates(child, selfPath));
  }
  return out;
}

/** 引用串（可能是裸 key 或 'parent.child' 点路径）是否落在候选集合中 */
function matchCandidate(ref, candidates) {
  if (!ref) return null;
  return candidates.find(
    (c) => ref === c.path || ref === c.key || ref.startsWith(`${c.path}.`),
  ) || null;
}

/**
 * 检查待删字段（含子字段）是否被流程 / 视图引用。
 * @param {number} formId
 * @param {Array<{path:string,key:string,label:string}>} candidates
 * @returns {Promise<Array<{kind:string,name:string,reason:string}>>}
 */
export async function findReferences(formId, candidates) {
  const refs = [];

  const { rows: flows } = await pool.query(
    `SELECT id, name, trigger_field, condition_field, approver_field FROM flows WHERE form_id = $1`,
    [formId],
  );
  for (const f of flows) {
    const t = matchCandidate(f.trigger_field, candidates);
    if (t) refs.push({ kind: '流程', name: f.name, reason: `流程「${f.name}」的触发条件使用了字段「${t.label}」` });
    const c = matchCandidate(f.condition_field, candidates);
    if (c) refs.push({ kind: '流程', name: f.name, reason: `流程「${f.name}」的分支条件使用了字段「${c.label}」` });
    const a = matchCandidate(f.approver_field, candidates);
    if (a) refs.push({ kind: '流程', name: f.name, reason: `流程「${f.name}」将字段「${a.label}」指定为审批人` });
  }

  const { rows: views } = await pool.query(
    `SELECT id, name, column_fields, filter_field FROM form_views WHERE form_id = $1`,
    [formId],
  );
  for (const v of views) {
    const cols = Array.isArray(v.column_fields) ? v.column_fields : [];
    for (const col of cols) {
      const m = matchCandidate(col, candidates);
      if (m) refs.push({ kind: '视图', name: v.name, reason: `视图「${v.name}」的列表列展示了字段「${m.label}」` });
    }
    const fv = matchCandidate(v.filter_field, candidates);
    if (fv) refs.push({ kind: '视图', name: v.name, reason: `视图「${v.name}」的筛选条件使用了字段「${fv.label}」` });
  }
  return refs;
}

/** 按 "parent.child" 路径在 schema 中找字段对象 */
export function findFieldByPath(schema, path) {
  const parts = path.split('.');
  let node = null;
  let list = schema;
  for (const p of parts) {
    node = list.find((f) => f.key === p);
    if (!node) return null;
    list = node.children || [];
  }
  return node;
}

/** schema 中按 "parent.child" 路径删除字段；返回删除的字段对象 */
export function removeFieldByPath(schema, path) {
  const parts = path.split('.');
  let list = schema;
  for (let i = 0; i < parts.length - 1; i++) {
    const parent = list.find((f) => f.key === parts[i]);
    if (!parent || parent.type !== 'subform') return null;
    list = parent.children || (parent.children = []);
  }
  const idx = list.findIndex((f) => f.key === parts[parts.length - 1]);
  if (idx === -1) return null;
  return list.splice(idx, 1)[0];
}

/** 遍历 schema 全部字段（含子字段） */
export function walkFields(schema, fn, parentPath = '') {
  for (const f of schema || []) {
    const p = parentPath ? `${parentPath}.${f.key}` : f.key;
    fn(f, p);
    if (f.children?.length) walkFields(f.children, fn, p);
  }
}
