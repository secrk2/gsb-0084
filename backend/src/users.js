// 演示环境的固定人员名册（无登录体系，前端通过 X-Actor / actor 传当前操作人）。
// value 与表单「人员类」下拉选项的值保持同一命名空间（如巡检员 u01..u03）。
export const USERS = [
  // 管理层 / 审批人
  { id: 'u01', name: '张巡检' },
  { id: 'u02', name: '李督查' },
  { id: 'u03', name: '王经理' },
  { id: 'u10', name: '赵主管' },
  { id: 'u11', name: '钱总监' },
  { id: 'u12', name: '孙HR' },
  { id: 'u13', name: '周财务' },
  { id: 'u14', name: '吴老板' },
  // 普通员工（发起人）
  { id: 'u20', name: '陈晨' },
  { id: 'u21', name: '李雷' },
  { id: 'u22', name: '韩梅梅' },
  { id: 'u23', name: '王浩' },
];

export function userName(id) {
  if (id === null || id === undefined || id === '') return '';
  return USERS.find((u) => u.id === id)?.name || String(id);
}

/** 把审批人 id 列表丰富成 {id,name} */
export function enrichUsers(ids) {
  return [...new Set((ids || []).filter(Boolean))].map((id) => ({ id: String(id), name: userName(id) }));
}
