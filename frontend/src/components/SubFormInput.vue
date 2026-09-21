<template>
  <div>
    <table class="sf-table">
      <thead>
        <tr>
          <th v-for="c in field.children" :key="c.key">
            {{ c.label }}<span v-if="c.required" class="req-star">*</span>
            <span v-if="c.type === 'number' && c.unit" class="field-tip" style="display:inline">（{{ c.unit }}）</span>
          </th>
          <th style="width:40px"></th>
        </tr>
      </thead>
      <tbody>
        <!-- 行用稳定 __uid 作为 key：增删行时 Vue 按 uid 复用 DOM，已填内容不会丢 -->
        <tr v-for="(row, idx) in rows" :key="row.__uid">
          <td v-for="c in field.children" :key="c.key"
              :data-label="cellLabel(c)"
              :class="['cell', { invalid: errAt(idx, c.key) }]">
            <input
              v-if="c.type === 'text'" class="input" :value="row[c.key] ?? ''"
              @input="setVal(idx, c.key, $event.target.value)" :placeholder="c.tips || ''" />
            <textarea v-else-if="c.type === 'textarea'" class="textarea" :value="row[c.key] ?? ''"
              @input="setVal(idx, c.key, $event.target.value)"></textarea>
            <input v-else-if="c.type === 'number'" class="input" inputmode="decimal" type="number"
              :value="row[c.key] ?? ''" :min="c.min" :max="c.max"
              @input="setVal(idx, c.key, $event.target.value === '' ? null : Number($event.target.value))" />
            <input v-else-if="c.type === 'date'" class="input"
              :type="c.datePrecision === 'month' ? 'month' : 'date'"
              :value="row[c.key] ?? ''"
              @input="setVal(idx, c.key, $event.target.value || null)" />
            <select v-else-if="c.type === 'select'" class="select" :value="row[c.key] ?? ''"
              @change="setVal(idx, c.key, $event.target.value)">
              <option value="" disabled>请选择</option>
              <option v-for="o in c.options" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <div v-else-if="c.type === 'multiselect'">
              <label v-for="o in c.options" :key="o.value" style="display:inline-flex;align-items:center;gap:4px;margin-right:10px;font-weight:400">
                <input type="checkbox" :checked="(row[c.key] || []).includes(o.value)"
                  @change="toggleMulti(idx, c.key, o.value, $event.target.checked)" />
                {{ o.label }}
              </label>
            </div>
            <input v-else class="input" :value="row[c.key] ?? ''" @input="setVal(idx, c.key, $event.target.value)" />
            <div v-if="errAt(idx, c.key)" class="cell-error">{{ errAt(idx, c.key) }}</div>
          </td>
          <td class="sf-actions">
            <button type="button" class="sf-del" title="删除本行" @click="removeRow(idx)">✕</button>
          </td>
        </tr>
      </tbody>
    </table>
    <button type="button" class="btn sm sf-add" @click="addRow">＋ 添加一行</button>
    <div v-if="errorOnSelf" class="field-error">{{ errorOnSelf }}</div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue';

let uidSeq = 0;
const nextUid = () => `sfrow_${Date.now().toString(36)}_${++uidSeq}`;

const props = defineProps({
  field: { type: Object, required: true },
  modelValue: { type: Array, default: () => [] },
  // key: `${field.key}.${rowIdx}.${childKey}` → 错误信息
  errorMap: { type: Object, default: () => ({}) },
  selfError: { type: String, default: '' },
});
const emit = defineEmits(['update:modelValue']);

// rows：带 __uid 的内部表示；modelValue（纯数据）与内部状态双向同步
const rows = ref([]);
let lastEmitted = null;

function toRows(values) {
  return (values || []).map((v) => ({ __uid: nextUid(), ...v }));
}
// 初始化（外部数据如默认值/历史值只在引用变化时整体接入）
watch(() => props.modelValue, (v) => {
  if (v !== lastEmitted) rows.value = toRows(v);
}, { immediate: true });

function sync() {
  const plain = rows.value.map(({ __uid, ...rest }) => rest);
  lastEmitted = plain;
  emit('update:modelValue', plain);
}
function blankRow() {
  const r = { __uid: nextUid() };
  for (const c of props.field.children || []) {
    if (c.type === 'multiselect' || c.type === 'attachment') r[c.key] = [];
    else if (c.defaultValue !== null && c.defaultValue !== undefined && c.defaultValue !== '') r[c.key] = c.defaultValue;
    else r[c.key] = null;
  }
  return r;
}
function addRow() {
  rows.value.push(blankRow());
  sync();
}
function removeRow(idx) {
  rows.value.splice(idx, 1); // 按 uid 渲染，其它行内容原样保留
  sync();
}
function setVal(idx, key, val) {
  rows.value[idx][key] = val;
  sync();
}
function toggleMulti(idx, key, value, checked) {
  const cur = new Set(rows.value[idx][key] || []);
  if (checked) cur.add(value); else cur.delete(value);
  rows.value[idx][key] = [...cur];
  sync();
}
function cellLabel(c) {
  return c.required ? `${c.label} *` : c.label;
}
function errAt(rowIdx, childKey) {
  return props.errorMap[`${props.field.key}.${rowIdx}.${childKey}`] || '';
}
</script>
