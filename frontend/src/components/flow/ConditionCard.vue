<template>
  <div class="flow-node condition-node">
    <div class="fn-head">
      <span class="fn-icon">⑂</span>
      <input class="input fn-name" v-model="stage.name" placeholder="分支名称，如：金额分支" />
      <button v-if="movable" class="fn-icon-btn" title="上移" @click="$emit('move', -1)">↑</button>
      <button v-if="movable" class="fn-icon-btn" title="下移" @click="$emit('move', 1)">↓</button>
      <button class="fn-icon-btn danger" title="删除分支节点" @click="$emit('remove')">✕</button>
    </div>

    <div class="branches">
      <div v-for="(b, bi) in stage.branches" :key="bi" class="branch-box">
        <div class="branch-head">
          <input class="input branch-label" v-model="b.label" placeholder="分支说明，如：金额超过 1 万" />
          <button class="fn-icon-btn danger" title="删除该分支" @click="removeBranch(bi)">✕</button>
        </div>
        <div class="cond-logic">
          满足
          <select class="select logic-sel" v-model="b.logic">
            <option value="and">全部</option>
            <option value="or">任一</option>
          </select>
          条件：
        </div>
        <div v-for="(c, ci) in b.conditions" :key="ci" class="cond-row">
          <select class="select cond-field" v-model="c.field" @change="onFieldChange(c)">
            <option value="" disabled>选择字段</option>
            <option v-for="f in flatFields" :key="f.path" :value="f.path">{{ f.label }}</option>
          </select>
          <select class="select cond-op" v-model="c.op" @change="onOpChange(c)">
            <option v-for="o in DESIGNER_OPS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <!-- 比较值：按字段类型给不同控件 -->
          <select v-if="optionField(c)" class="select cond-val" v-model="c.value">
            <option value="" disabled>选择值</option>
            <option v-for="o in optionField(c).options" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <input v-else-if="numberField(c) && !noValue(c)" class="input cond-val" type="number" v-model="c.value" placeholder="数值" />
          <input v-else-if="!noValue(c)" class="input cond-val" v-model="c.value" placeholder="比较值" />
          <span v-else class="cond-val noop">—</span>
          <button class="fn-icon-btn danger" title="删除条件" @click="removeCond(b, ci)">✕</button>
        </div>
        <button class="btn sm" @click="addCond(b)">＋ 添加条件</button>

        <div class="branch-then">命中后依次经过：</div>
        <StageList :stages="b.stages" :users="users" :fields="fields" :nested="true" />
      </div>

      <div class="branch-box default">
        <div class="branch-head"><strong>都不满足时（默认分支）</strong></div>
        <div class="branch-then">依次经过：</div>
        <StageList :stages="stage.defaultStages" :users="users" :fields="fields" :nested="true" />
        <div class="fn-hint">默认分支也不设节点时，所有条件都不命中即流程直接结束。</div>
      </div>
      <button class="btn sm" @click="addBranch">＋ 添加分支</button>
    </div>
  </div>
</template>

<script setup>
import StageList from './StageList.vue';
import { DESIGNER_OPS } from '../../flow-ops.js';

const props = defineProps({
  stage: { type: Object, required: true },
  users: { type: Array, default: () => [] },
  fields: { type: Array, default: () => [] },
  movable: { type: Boolean, default: true },
});
defineEmits(['remove', 'move']);

// 条件字段：仅顶层标量字段（子表单子字段的比较语义不直观，不开放）
const flatFields = (props.fields || [])
  .filter((f) => f.type !== 'subform')
  .map((f) => ({ path: f.key, label: f.label, field: f }));

function findField(path) {
  return flatFields.find((f) => f.path === path)?.field || null;
}
function optionField(c) { const f = findField(c.field); return f && ['select', 'multiselect'].includes(f.type) ? f : null; }
function numberField(c) { return findField(c.field)?.type === 'number'; }
function noValue(c) { return ['empty', 'not_empty'].includes(c.op); }

function onFieldChange(c) { c.value = ''; }
function onOpChange(c) { if (noValue(c)) c.value = ''; }

function addCond(b) { b.conditions.push({ field: '', op: 'gt', value: '' }); }
function removeCond(b, i) { b.conditions.splice(i, 1); }
function addBranch() {
  props.stage.branches.push({
    label: '新分支', logic: 'and',
    conditions: [{ field: '', op: 'gt', value: '' }],
    stages: [],
  });
}
function removeBranch(i) { props.stage.branches.splice(i, 1); }
</script>
