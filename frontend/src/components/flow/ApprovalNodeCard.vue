<template>
  <div class="flow-node approval-node">
    <div class="fn-head">
      <span class="fn-icon">👤</span>
      <input class="input fn-name" v-model="stage.name" placeholder="节点名称，如：部门主管审批" />
      <select class="select fn-mode" v-model="stage.mode" title="通过规则">
        <option value="all">会签 · 全部通过</option>
        <option value="any">或签 · 任一通过</option>
      </select>
      <button v-if="movable" class="fn-icon-btn" title="上移" @click="$emit('move', -1)">↑</button>
      <button v-if="movable" class="fn-icon-btn" title="下移" @click="$emit('move', 1)">↓</button>
      <button class="fn-icon-btn danger" title="删除节点" @click="$emit('remove')">✕</button>
    </div>
    <div class="fn-body">
      <div v-for="(a, i) in stage.approvers" :key="i" class="approver-row">
        <select class="select ap-type" v-model="a.type">
          <option value="user">固定人员</option>
          <option value="field">取表单字段</option>
        </select>
        <select v-if="a.type === 'user'" class="select ap-value" v-model="a.value">
          <option value="" disabled>选择审批人</option>
          <option v-for="u in users" :key="u.id" :value="u.id">{{ u.name }} · {{ u.dept }}{{ u.role }}</option>
        </select>
        <select v-else class="select ap-value" v-model="a.value">
          <option value="" disabled>选择字段</option>
          <option v-for="f in approverFields" :key="f.key" :value="f.key">{{ f.label }}（{{ typeLabel(f.type) }}）</option>
        </select>
        <button class="fn-icon-btn danger" title="移除审批人" @click="removeApprover(i)">✕</button>
      </div>
      <button class="btn sm" @click="addApprover">＋ 添加审批人</button>
      <div class="fn-hint">
        会签：所有审批人都通过才往下走（{{ stage.approvers.filter(a => a.value).length || 0 }} 人）；
        或签：任一人通过即推进。取字段时，审批人取该字段的填写值。
      </div>
    </div>
  </div>
</template>

<script setup>
const props = defineProps({
  stage: { type: Object, required: true },
  users: { type: Array, default: () => [] },
  fields: { type: Array, default: () => [] },
  movable: { type: Boolean, default: true },
});
defineEmits(['remove', 'move']);

const APPROVER_FIELD_TYPES = ['select', 'multiselect', 'text'];
const TYPE_LABEL = { text: '文本', select: '单选', multiselect: '多选' };
function typeLabel(t) { return TYPE_LABEL[t] || t; }

// 审批人字段：仅顶层 单选/多选/文本（子表单内的值不适合作为审批人）
const approverFields = (props.fields || [])
  .filter((f) => APPROVER_FIELD_TYPES.includes(f.type));

function addApprover() {
  props.stage.approvers.push({ type: 'user', value: '' });
}
function removeApprover(i) {
  props.stage.approvers.splice(i, 1);
}
</script>
