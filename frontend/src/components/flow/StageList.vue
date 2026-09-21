<template>
  <div class="stage-list" :class="{ nested }">
    <template v-for="(s, i) in stages" :key="s.key">
      <div class="stage-connector up"><span>↓</span></div>
      <ApprovalNodeCard v-if="s.kind === 'approval'" :stage="s" :users="users" :fields="fields"
        :movable="!nested || true" @remove="removeAt(i)" @move="(d) => move(i, d)" />
      <ConditionCard v-else-if="s.kind === 'condition'" :stage="s" :users="users" :fields="fields"
        @remove="removeAt(i)" @move="(d) => move(i, d)" />
    </template>
    <div class="stage-connector" :class="{ up: stages.length }"><span>↓</span></div>
    <div class="stage-add">
      <button class="btn sm" @click="addApproval">＋ 审批节点</button>
      <button v-if="!nested" class="btn sm" @click="addCondition">＋ 条件分支</button>
    </div>
  </div>
</template>

<script setup>
import ApprovalNodeCard from './ApprovalNodeCard.vue';
import ConditionCard from './ConditionCard.vue';
import { emptyBranch, emptyStages } from '../../flow-utils.js';

const props = defineProps({
  stages: { type: Array, required: true },
  users: { type: Array, default: () => [] },
  fields: { type: Array, default: () => [] },
  nested: { type: Boolean, default: false },
});

function addApproval() {
  props.stages.push(emptyStages()[0]);
}
function addCondition() {
  props.stages.push({
    key: `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    kind: 'condition',
    name: '条件分支',
    branches: [emptyBranch()],
    defaultStages: [],
  });
}
function removeAt(i) {
  if (!window.confirm('确定删除这个节点？其下分支与审批节点会一并删除。')) return;
  props.stages.splice(i, 1);
}
function move(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= props.stages.length) return;
  const [x] = props.stages.splice(i, 1);
  props.stages.splice(j, 0, x);
}
</script>
