// 平台暂无登录体系：用一份静态人员目录表示「谁在操作」。
// 前端在顶栏切换当前身份，提交/审批都带上账号（actor），后端不做鉴权只做留痕。
export const USERS = [
  { id: 'u_chen', name: '陈晨', dept: '技术部', role: '员工' },
  { id: 'u_lilei', name: '李雷', dept: '销售部', role: '员工' },
  { id: 'u_han', name: '韩梅梅', dept: '销售部', role: '员工' },
  { id: 'u_wang', name: '王浩', dept: '技术部', role: '部门主管' },
  { id: 'u_zhao', name: '赵敏', dept: '销售部', role: '部门主管' },
  { id: 'u_sun', name: '孙杰', dept: '管理层', role: '总监' },
  { id: 'u_zhou', name: '周倩', dept: '财务部', role: '财务' },
  { id: 'u_wudi', name: '吴迪', dept: '财务部', role: '财务' },
  { id: 'u_hr', name: '何人事', dept: '人事部', role: '人事' },
];

export function userName(id) {
  return USERS.find((u) => u.id === id)?.name || id || '';
}
