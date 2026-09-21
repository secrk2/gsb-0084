<template>
  <div class="pipeline">
    <div class="pl-node done"><div class="pl-name">发起</div><div class="pl-sub">{{ submitterName }}</div></div>

    <template v-for="s in stages" :key="s.key">
      <span class="pl-arrow">→</span>

      <!-- 审批节点 -->
      <div v-if="s.kind === 'approval'" class="pl-node" :class="states[s.key]">
        <div class="pl-name">{{ s.name }}</div>
        <div class="pl-sub">{{ modeText(s) }} · {{ approverText(s) }}</div>
      </div>

      <!-- 条件分支节点 -->
      <template v-else>
        <div class="pl-node branch" :class="decided[s.key] ? 'done' : 'skipped'">
          <div class="pl-name">⑂ {{ s.name }}</div>
          <div class="pl-sub">
            <span v-for="b in s.branches" :key="b.label"
              :class="['branch-chip', routes[s.key] === b.label ? 'hit' : (decided[s.key] ? 'miss' : '')]">
              {{ routes[s.key] === b.label ? '✓ ' : '' }}{{ b.label }}
            </span>
            <span v-if="decided[s.key] && routes[s.key] === null" class="branch-chip hit">默认分支</span>
          </div>
        </div>

        <!-- 命中分支内部的审批节点 -->
        <template v-if="decided[s.key]">
          <template v-for="b in s.branches" :key="'b-' + b.label">
            <template v-if="routes[s.key] === b.label">
              <template v-for="bs in b.stages" :key="bs.key">
                <span class="pl-arrow">→</span>
                <div class="pl-node sub" :class="states[bs.key]">
                  <div class="pl-name">{{ bs.name }}</div>
                  <div class="pl-sub">{{ modeText(bs) }} · {{ approverText(bs) }}</div>
                </div>
              </template>
            </template>
          </template>
          <template v-if="routes[s.key] === null">
            <template v-for="bs in s.defaultStages" :key="bs.key">
              <span class="pl-arrow">→</span>
              <div class="pl-node sub" :class="states[bs.key]">
                <div class="pl-name">{{ bs.name }}</div>
                <div class="pl-sub">{{ modeText(bs) }} · {{ approverText(bs) }}</div>
              </div>
            </template>
          </template>
        </template>
      </template>
    </template>

    <span class="pl-arrow">→</span>
    <div class="pl-node" :class="finalState"><div class="pl-name">结束</div><div class="pl-sub">{{ finalText }}</div></div>
  </div>
</template>

<script setup>
import { userName } from '../../auth.js';

defineProps({
  stages: { type: Array, default: () => [] },
  states: { type: Object, default: () => ({}) },
  routes: { type: Object, default: () => ({}) },
  decided: { type: Object, default: () => ({}) },
  submitterName: { type: String, default: '' },
  finalState: { type: String, default: '' },
  finalText: { type: String, default: '' },
});

function modeText(s) {
  if (s.mode === 'any') return '或签';
  const n = (s.approvers || []).length;
  return n ? `会签 ${n} 人` : '会签';
}
function approverText(s) {
  return (s.approvers || []).map((a) => (a.type === 'field' ? `字段:${a.value}` : userName(a.value))).join('、');
}
</script>

<style scoped>
.pipeline { display: flex; align-items: center; flex-wrap: wrap; gap: 2px 0; }
.branch-chip { display: inline-block; margin: 2px 4px 0 0; padding: 1px 7px; border-radius: 999px; background: #f3f0e2; font-size: 11px; }
.branch-chip.hit { background: var(--brand-soft); color: var(--brand); font-weight: 600; }
.branch-chip.miss { opacity: .45; }
.pl-node.sub { min-width: 96px; font-size: 12px; }
.pl-node.branch.done { border-color: var(--success); background: #f6fcf8; }
</style>
