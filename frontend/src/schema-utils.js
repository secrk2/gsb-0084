// 前端侧的默认值/空值补齐，与后端 applyDefaults 保持同一约定
export function applyDefaultsClient(schema, data = {}) {
  const out = {};
  for (const f of schema || []) {
    if (data[f.key] !== undefined && data[f.key] !== null) {
      out[f.key] = data[f.key];
    } else if (f.defaultValue !== undefined && f.defaultValue !== null && f.defaultValue !== '') {
      out[f.key] = f.defaultValue;
    } else if (f.type === 'multiselect' || f.type === 'attachment' || f.type === 'subform') {
      out[f.key] = [];
    } else {
      out[f.key] = null;
    }
  }
  return out;
}

// 深拷贝字段（设计器拖拽/复制用）
export function cloneField(f) {
  return JSON.parse(JSON.stringify(f));
}
