// 比较运算符（与后端 flowdef.js OPS 保持一致）
export const OPS = [
  { value: 'gt', label: '大于', numeric: true },
  { value: 'gte', label: '大于等于', numeric: true },
  { value: 'lt', label: '小于', numeric: true },
  { value: 'lte', label: '小于等于', numeric: true },
  { value: 'eq', label: '等于' },
  { value: 'ne', label: '不等于' },
  { value: 'in', label: '属于' },
  { value: 'not_in', label: '不属于' },
  { value: 'contains', label: '包含（多选）' },
  { value: 'not_contains', label: '不包含（多选）' },
  { value: 'empty', label: '为空', noValue: true },
  { value: 'not_empty', label: '不为空', noValue: true },
];

// 设计器可选运算符：与后端 OPS 保持一致，但去掉需要多值输入的 in/not_in（UI 仅提供单值比较框）
export const DESIGNER_OPS = OPS.filter((o) => o.value !== 'in' && o.value !== 'not_in');
