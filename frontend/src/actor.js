// 当前操作人（演示环境无登录体系，顶栏切换；持久化到 localStorage）
import { reactive } from 'vue';

const KEY = 'jimu_actor';

export const actorState = reactive({
  current: localStorage.getItem(KEY) || 'u20',
  users: [],
});

export function setActor(id) {
  actorState.current = id;
  localStorage.setItem(KEY, id);
}
