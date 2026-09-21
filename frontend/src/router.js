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
  ],
});
