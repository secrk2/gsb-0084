// 当前操作人：平台暂无登录体系，在顶栏切换身份，持久化到 localStorage。
import { reactive } from 'vue';

const KEY = 'jimu.currentUser';

export const auth = reactive({
  user: JSON.parse(localStorage.getItem(KEY) || 'null') || { id: 'u_chen', name: '陈晨' },
  users: [],
});

export function setUser(u) {
  auth.user = u;
  localStorage.setItem(KEY, JSON.stringify(u));
}

export function userName(id) {
  return auth.users.find((u) => u.id === id)?.name || id || '—';
}
