// 流程相关的展示工具：状态/动作中文、停留时长、按字段元数据把值格式化成可读文本
export const SUBMISSION_STATUS = {
  submitted: { label: '已收数', cls: 'muted' },
  in_approval: { label: '审批中', cls: 'warn' },
  returned: { label: '已退回', cls: 'danger' },
  approved: { label: '审批通过', cls: 'ok' },
  rejected: { label: '已驳回', cls: 'danger' },
};

export const ACTION_LABELS = {
  submit: '提交申请',
  node_enter: '进入节点',
  approve: '通过',
  reject: '驳回',
  return_initiator: '退回发起人',
  return_previous: '退回上一节点',
  resubmit: '修改后重新提交',
};

export function statusOf(s) {
  return SUBMISSION_STATUS[s] || { label: s, cls: 'muted' };
}

const pad = (n) => String(n).padStart(2, '0');
export function fmtDateTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 停留时长：45 分钟 / 27 小时 / 3 天 5 小时 */
export function fmtDuration(from, to = Date.now()) {
  if (!from) return '—';
  let ms = new Date(to).getTime() - new Date(from).getTime();
  if (ms < 0) ms = 0;
  const min = Math.floor(ms / 60000);
  if (min < 1) return '不到 1 分钟';
  if (min < 60) return `${min} 分钟`;
  const hours = Math.floor(min / 60);
  const restMin = min % 60;
  if (hours < 24) return restMin ? `${hours} 小时 ${restMin} 分` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  const restH = hours % 24;
  return restH ? `${days} 天 ${restH} 小时` : `${days} 天`;
}

/** 按字段元数据把原始值转成可读文本（diff/摘要用） */
export function formatFieldValue(value, field) {
  if (value === null || value === undefined || value === '') return '（空）';
  if (!field) return typeof value === 'object' ? JSON.stringify(value) : String(value);
  const optLabel = (v) => field.options?.find((o) => String(o.value) === String(v))?.label ?? v;
  switch (field.type) {
    case 'select':
      return String(optLabel(value));
    case 'multiselect':
      return (Array.isArray(value) ? value : [value]).map(optLabel).join('、') || '（空）';
    case 'attachment':
      return Array.isArray(value) ? `${value.length} 个附件` : '（空）';
    case 'subform':
      return Array.isArray(value) ? `${value.length} 行` : '（空）';
    case 'number':
      return `${value}${field.unit ? ' ' + field.unit : ''}`;
    default:
      return String(value);
  }
}

/** 在 schema 里按 key 找字段（含子字段） */
export function findField(schema, key) {
  for (const f of schema || []) {
    if (f.key === key) return f;
    if (f.children?.length) {
      const hit = findField(f.children, key);
      if (hit) return hit;
    }
  }
  return null;
}

/** 条件操作符（与后端 engine OPS 对应） */
export const OP_OPTIONS = [
  { value: 'eq', label: '等于' },
  { value: 'ne', label: '不等于' },
  { value: 'gt', label: '大于' },
  { value: 'gte', label: '大于等于' },
  { value: 'lt', label: '小于' },
  { value: 'lte', label: '小于等于' },
  { value: 'in', label: '属于' },
  { value: 'not_in', label: '不属于' },
  { value: 'empty', label: '为空' },
  { value: 'not_empty', label: '不为空' },
];

/** 可作为分支条件的字段：标量类（数字/日期/单选/文本），不含子表单与附件 */
export function conditionableFields(schema) {
  return (schema || []).filter((f) => ['number', 'date', 'select', 'text', 'multiselect'].includes(f.type));
}

/** 可作为「字段取审批人」的字段：单选/多选/文本 */
export function approverFields(schema) {
  return (schema || []).filter((f) => ['select', 'multiselect', 'text'].includes(f.type));
}

export function opLabel(v) {
  return OP_OPTIONS.find((o) => o.value === v)?.label || v;
}
