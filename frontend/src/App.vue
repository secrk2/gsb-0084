<template>
  <div class="app-shell">
    <header class="topbar">
      <router-link to="/activity" class="logo">
        <span class="blocks">🧱</span>
        <span>积木<em>·</em>Jimu</span>
        <span class="sub" style="font-size:12px;color:var(--text-3);font-weight:400;margin-left:2px">低代码搭建平台</span>
      </router-link>
      <nav class="nav">
        <router-link to="/activity">应用动态</router-link>
        <router-link to="/apps">应用与表单</router-link>
        <router-link to="/approvals">审批中心</router-link>
        <router-link to="/instances">流程实例</router-link>
      </nav>
      <div class="identity-box">
        <span>当前身份</span>
        <select :value="auth.user.id" @change="switchUser($event.target.value)">
          <option v-for="u in auth.users" :key="u.id" :value="u.id">{{ u.name }} · {{ u.role }}</option>
        </select>
      </div>
    </header>

    <router-view v-slot="{ Component }">
      <transition name="fade" mode="out-in">
        <component :is="Component" />
      </transition>
    </router-view>

    <div class="toast-wrap">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="t.type">{{ t.message }}</div>
    </div>
  </div>
</template>

<script setup>
import { onMounted } from 'vue';
import { toasts } from './toast.js';
import { auth, setUser } from './auth.js';
import { fetchUsers } from './api.js';

onMounted(async () => {
  try { auth.users = await fetchUsers(); } catch { /* 人员目录加载失败不阻塞页面 */ }
});
function switchUser(id) {
  const u = auth.users.find((x) => x.id === id);
  if (u) setUser(u);
}
</script>

<style>
.fade-enter-active, .fade-leave-active { transition: opacity .12s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
