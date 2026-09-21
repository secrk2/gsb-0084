// 与后端字段类型保持一致的前端定义
export const FIELD_TYPES = {
  text: { label: '单行文本', icon: 'Aa', uniqueable: true },
  textarea: { label: '多行文本', icon: '¶', uniqueable: false },
  number: { label: '数字', icon: '123', uniqueable: true },
  date: { label: '日期', icon: '日', uniqueable: true },
  select: { label: '下拉单选', icon: '▾', uniqueable: true },
  multiselect: { label: '多选', icon: '☑', uniqueable: false },
  attachment: { label: '附件', icon: '📎', uniqueable: false },
  subform: { label: '子表单', icon: '⊞', uniqueable: false },
};

export const TYPE_ORDER = ['text', 'textarea', 'number', 'date', 'select', 'multiselect', 'attachment', 'subform'];

let seq = 0;
export function uid() {
  seq += 1;
  return `r_${Date.now().toString(36)}_${seq}`;
}

export function newFieldMeta(type) {
  const s = `${Date.now().toString(36)}${(seq++).toString(36)}`;
  const base = {
    key: `f_${type}_${s}`.slice(0, 40),
    type,
    label: FIELD_TYPES[type].label,
    required: false,
    unique: false,
    defaultValue: null,
    validateMessage: '',
    tips: '',
  };
  switch (type) {
    case 'text': return { ...base, maxLength: 200 };
    case 'textarea': return { ...base, maxLength: 1000 };
    case 'number': return { ...base, unit: '', min: '', max: '' };
    case 'date': return { ...base, datePrecision: 'day' };
    case 'select':
    case 'multiselect':
      return { ...base, options: [{ label: '选项一', value: `opt${s.slice(-4)}1` }, { label: '选项二', value: `opt${s.slice(-4)}2` }] };
    case 'attachment': return { ...base, maxCount: 5, accept: '' };
    case 'subform':
      return { ...base, key: `f_sub_${s}`.slice(0, 32), children: [childField('text', '子字段', s)] };
    default: return base;
  }
}

export function childField(type, label, token = '') {
  const s = `${Date.now().toString(36)}${(seq++).toString(36)}${token}`;
  return {
    key: `f_child_${s}`.slice(0, 40),
    type,
    label: label || FIELD_TYPES[type].label,
    required: false,
    unique: false,
    defaultValue: null,
    validateMessage: '',
    tips: '',
    ...(type === 'number' ? { unit: '', min: '', max: '' } : {}),
    ...(type === 'date' ? { datePrecision: 'day' } : {}),
    ...(type === 'select' ? { options: [{ label: '选项一', value: 'opt1' }, { label: '选项二', value: 'opt2' }] } : {}),
    ...(type === 'multiselect' ? { options: [{ label: '选项一', value: 'opt1' }, { label: '选项二', value: 'opt2' }] } : {}),
    ...(type === 'text' ? { maxLength: 100 } : {}),
    ...(type === 'textarea' ? { maxLength: 500 } : {}),
  };
}
