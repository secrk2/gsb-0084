<template>
  <div class="node-card">
    <div class="node-head">
      <span class="node-mode-icon">{{ node.mode === 'countersign' ? '⚙️' : '①' }}</span>
      <input class="input node-name-input" v-model="node.name" placeholder="节点名称，如：部门主管审批" />
      <span class="tag" :class="node.mode === 'countersign' ? 'warn' : ''">
        {{ node.mode === 'countersign' ? '并行会签' : '串行审批' }}
      </span>
      <button v-if="removable" class="btn sm danger ghost-del" @click="$emit('remove')" title="删除节点">✕</button>
    </div>
    <div class="node-body">
      <div class="seg">
        <button type="button" :class="{ on: node.mode === 'serial' }" @click="node.mode = 'serial'">串行（逐个审批）</button>
        <button type="button" :class="{ on: node.mode === 'countersign' }" @click="node.mode = 'countersign'">并行会签（全员通过）</button>
      </div>
      <div class="seg">
        <button type="button" :class="{ on: node.approver_type === 'fixed' }" @click="node.approver_type = 'fixed'">指定人员</button>
        <button type="button" :class="{ on: node.approver_type === 'field' }" @click="node.approver_type = 'field'">取表单字段值</button>
      </div>

      <div v-if="node.approver_type === 'fixed'" class="approver-pick">
        <label class="hint">
          {{ node.mode === 'countersign' ? '勾选参与会签的人（全部通过才往下走）' : '按顺序审批（拖动或点 ↑↓ 调整顺序）' }}
        </label>
        <div v-if="!orderedApprovers.length" class="hint danger-text">尚未选择审批人</div>
        <div v-for="(uid, idx) in orderedApprovers" :key="uid" class="approver-row">
          <span class="seq-badge">{{ idx + 1 }}</span>
          <span class="ap-name">{{ userName(uid) }}</span>
          <span class="ap-actions">
            <button type="button" class="mini" :disabled="idx === 0" @click="moveApprover(uid, -1)">↑</button>
            <button type="button" class="mini" :disabled="idx === orderedApprovers.length - 1" @click="moveApprover(uid, 1)">↓</button>
            <button type="button" class="mini danger" @click="toggleUser(uid)">移除</button>
          </span>
        </div>
        <div class="user-chips">
          <button v-for="u in users" :key="u.id" type="button"
                  class="chip" :class="{ on: node.approvers.includes(u.id) }"
                  @click="toggleUser(u.id)">
            {{ u.name }}
          </button>
        </div>
      </div>

      <div v-else class="approver-pick">
        <label class="hint">审批人取自该字段的值（单选 → 1 人；多选 → 多人{{ node.mode === 'countersign' ? '会签' : '串行' }}）</label>
        <select class="select" v-model="node.field">
          <option :value="null" disabled>选择表单字段…</option>
          <option v-for="f in approverFields(schema)" :key="f.key" :value="f.key">
            {{ f.label }}（{{ typeLabel(f.type) }}）
          </option>
        </select>
        <div v-if="!approverFields(schema).length" class="hint danger-text">该表单暂无可用于取审批人的字段（单选/多选/文本）</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { approverFields } from '../../flow-format.js';

const props = defineProps({
  node: { type: Object, required: true },
  schema: { type: Array, default: () => [] },
  users: { type: Array, default: () => [] },
  removable: { type: Boolean, default: false },
});
defineEmits(['remove']);

const orderedApprovers = computed(() => props.node.approvers || []);

function userName(id) {
  return props.users.find((u) => u.id === id)?.name || id;
}
function typeLabel(t) {
  return { select: '单选', multiselect: '多选', text: '文本' }[t] || t;
}
function toggleUser(uid) {
  const arr = [...(props.node.approvers || [])];
  const i = arr.indexOf(uid);
  if (i >= 0) arr.splice(i, 1); else arr.push(uid); // 新增排在末尾，用户可再用 ↑↓ 调整，不打乱既有顺序
  props.node.approvers = arr;
}
function moveApprover(uid, delta) {
  const arr = [...(props.node.approvers || [])];
  const i = arr.indexOf(uid);
  const j = i + delta;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  props.node.approvers = arr;
}
</script>

<style scoped>
.node-card { border: 1px solid var(--border); border-radius: 10px; background: #fff; margin-bottom: 10px; overflow: hidden; }
.node-head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: #fafbfe; border-bottom: 1px solid var(--border); }
.node-mode-icon { font-size: 15px; }
.node-name-input { flex: 1; padding: 6px 10px; font-weight: 600; }
.node-body { padding: 12px 14px; }
.seg { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; margin: 0 10px 10px 0; }
.seg button { border: none; background: #fff; padding: 6px 12px; font-size: 12.5px; cursor: pointer; color: var(--text-2); }
.seg button + button { border-left: 1px solid var(--border); }
.seg button.on { background: var(--brand); color: #fff; }
.approver-pick { margin-top: 4px; }
.hint { font-size: 12.5px; color: var(--text-3); display: block; margin: 4px 0 8px; }
.danger-text { color: var(--danger); }
.approver-row { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-bottom: 1px dashed var(--border); font-size: 13px; }
.seq-badge { width: 20px; height: 20px; border-radius: 50%; background: var(--brand-soft); color: var(--brand); font-size: 12px; display: inline-flex; align-items: center; justify-content: center; font-weight: 600; }
.ap-name { flex: 1; }
.ap-actions { display: flex; gap: 4px; }
.mini { border: 1px solid var(--border); background: #fff; border-radius: 6px; padding: 2px 8px; font-size: 12px; cursor: pointer; color: var(--text-2); }
.mini:disabled { opacity: .35; cursor: default; }
.mini.danger { color: var(--danger); }
.user-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.chip { border: 1px solid var(--border); background: #fff; border-radius: 999px; padding: 4px 12px; font-size: 12.5px; cursor: pointer; color: var(--text-2); }
.chip.on { background: var(--brand-soft); border-color: var(--brand); color: var(--brand); font-weight: 600; }
.ghost-del { margin-left: auto; }
</style>
