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
      </nav>
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
import { toasts } from './toast.js';
</script>

<style>
.fade-enter-active, .fade-leave-active { transition: opacity .12s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
