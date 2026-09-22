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
        <router-link to="/inbox">审批中心</router-link>
      </nav>
      <div class="actor-box" v-if="users.length">
        <span class="actor-label">当前身份</span>
        <select class="actor-select" :value="actorState.current" @change="setActor($event.target.value)">
          <option v-for="u in users" :key="u.id" :value="u.id">{{ u.name }}</option>
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
import { onMounted, ref } from 'vue';
import { toasts } from './toast.js';
import { actorState, setActor } from './actor.js';
import { fetchUsers } from './api.js';

const users = ref([]);
onMounted(async () => {
  try { users.value = await fetchUsers(); actorState.users = users.value; } catch { /* 忽略 */ }
});
</script>

<style>
.fade-enter-active, .fade-leave-active { transition: opacity .12s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
.actor-box { display: flex; align-items: center; gap: 6px; }
.actor-label { font-size: 12px; color: var(--text-3); }
.actor-select { padding: 5px 8px; font-size: 13px; border: 1px solid var(--border); border-radius: 8px; background: #fff; color: var(--text); }
</style>
