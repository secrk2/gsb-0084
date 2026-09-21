import { createRouter, createWebHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/activity' },
    { path: '/activity', name: 'activity', component: () => import('./views/ActivityView.vue'), meta: { title: '应用动态' } },
    { path: '/apps', name: 'apps', component: () => import('./views/AppsView.vue'), meta: { title: '应用' } },
    { path: '/apps/:appId/forms', name: 'forms', component: () => import('./views/FormsView.vue'), meta: { title: '表单' } },
    { path: '/forms/:id/design', name: 'design', component: () => import('./views/DesignerView.vue'), meta: { title: '表单设计' } },
    { path: '/forms/:id/fill', name: 'fill', component: () => import('./views/FillView.vue'), meta: { title: '预览填报' } },
    { path: '/forms/:id/flow', name: 'flow-design', component: () => import('./views/FlowDesignerView.vue'), meta: { title: '流程设计' } },
    { path: '/approvals', name: 'approvals', component: () => import('./views/ApprovalsView.vue'), meta: { title: '审批中心' } },
    { path: '/instances', name: 'instances', component: () => import('./views/InstancesView.vue'), meta: { title: '流程实例' } },
    { path: '/instances/:id', name: 'instance', component: () => import('./views/InstanceDetailView.vue'), meta: { title: '实例详情' } },
    { path: '/submissions/:id/resubmit', name: 'resubmit', component: () => import('./views/ResubmitView.vue'), meta: { title: '退回修改' } },
  ],
});
