<template>
  <div>
    <template v-for="f in schema" :key="f.key">
      <!-- 普通字段 -->
      <div v-if="f.type !== 'subform'" class="field" :class="{ invalid: !!topErrors[f.key] }">
        <label>
          {{ f.label }}<span v-if="f.required" class="req-star">*</span>
          <span v-if="f.type === 'number' && f.unit" class="tag muted" style="font-weight:400;margin-left:4px">单位：{{ f.unit }}</span>
        </label>

        <input v-if="f.type === 'text'" class="input" v-model="data[f.key]" :maxlength="f.maxLength || 200"
          :placeholder="f.tips || `请输入${f.label}`" />
        <textarea v-else-if="f.type === 'textarea'" class="textarea" v-model="data[f.key]"
          :maxlength="f.maxLength || 5000" :placeholder="f.tips || `请输入${f.label}`"></textarea>
        <input v-else-if="f.type === 'number'" class="input" type="number" inputmode="decimal"
          v-model.number="data[f.key]" :min="f.min" :max="f.max"
          :placeholder="rangeHint(f)" />
        <input v-else-if="f.type === 'date'" class="input"
          :type="f.datePrecision === 'month' ? 'month' : 'date'"
          v-model="data[f.key]" />
        <select v-else-if="f.type === 'select'" class="select" v-model="data[f.key]">
          <option :value="null" value="" disabled>请选择</option>
          <option v-for="o in f.options" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <div v-else-if="f.type === 'multiselect'" class="multi-box">
          <label v-for="o in f.options" :key="o.value" class="multi-opt">
            <input type="checkbox" :checked="(data[f.key] || []).includes(o.value)"
              @change="toggleMulti(f.key, o.value, $event.target.checked)" />
            {{ o.label }}
          </label>
        </div>
        <AttachmentInput v-else-if="f.type === 'attachment'" :field="f" v-model="data[f.key]" />

        <div v-if="f.tips" class="field-tip">{{ f.tips }}</div>
        <div v-for="(msg, i) in topErrors[f.key] || []" :key="i" class="field-error">⚠ {{ msg }}</div>
      </div>

      <!-- 子表单 -->
      <div v-else class="field" :class="{ invalid: !!topErrors[f.key] }">
        <label>{{ f.label }}<span v-if="f.required" class="req-star">*</span></label>
        <SubFormInput :field="f" v-model="data[f.key]" :error-map="subErrorMap(f.key)"
          :self-error="(topErrors[f.key] || [])[0] || ''" />
      </div>
    </template>
  </div>
</template>

<script setup>
import { reactive, watch } from 'vue';
import AttachmentInput from './AttachmentInput.vue';
import SubFormInput from './SubFormInput.vue';
import { applyDefaultsClient } from '../schema-utils.js';

const props = defineProps({
  schema: { type: Array, required: true },
  modelValue: { type: Object, default: () => ({}) },
  // 后端 422 返回的 errors: [{path:[...], message}]
  errors: { type: Array, default: () => [] },
});
const emit = defineEmits(['update:modelValue']);

const data = reactive({});
let lastEcho = null; // 本组件刚上抛、又被父组件回传的对象，避免逐键输入时重复 hydrate
function hydrate(v) {
  if (v === lastEcho) return;
  const d = applyDefaultsClient(props.schema, v || {});
  Object.keys(data).forEach((k) => delete data[k]);
  Object.assign(data, d);
}
watch(() => props.modelValue, hydrate, { immediate: true, deep: false });
watch(data, (v) => {
  const payload = { ...v };
  lastEcho = payload;
  emit('update:modelValue', payload);
}, { deep: true });

function toggleMulti(key, value, checked) {
  const set = new Set(data[key] || []);
  if (checked) set.add(value); else set.delete(value);
  data[key] = [...set];
}
function rangeHint(f) {
  if (f.min !== '' && f.min !== null && f.max !== '' && f.max !== null) return `取值范围 ${f.min} ~ ${f.max}`;
  if (f.min !== '' && f.min !== null) return `不小于 ${f.min}`;
  if (f.max !== '' && f.max !== null) return `不大于 ${f.max}`;
  return `请输入${f.label}`;
}

// 顶层字段错误（key → 多条消息），reactive 以便错误变化即时渲染
const topErrors = reactive({});
// 子字段错误（"subKey.rowIdx.childKey" → msg）
function subErrorMap(subKey) {
  const map = {};
  for (const e of props.errors || []) {
    const p = e.path || [];
    if (p[0] === subKey && p.length >= 3) {
      map[`${p[0]}.${p[1]}.${p[2]}`] = e.message;
    }
  }
  return map;
}
function buildTopErrors() {
  for (const k of Object.keys(topErrors)) delete topErrors[k];
  for (const e of props.errors || []) {
    const p = e.path || [e.fieldKey];
    const key = p[0];
    (topErrors[key] ||= []).push(e.message);
  }
}
watch(() => props.errors, buildTopErrors, { immediate: true, deep: true });
</script>

<style scoped>
.multi-box { display: flex; flex-wrap: wrap; gap: 6px 16px; padding: 9px 4px; }
.multi-opt { display: inline-flex !important; align-items: center; gap: 6px; font-weight: 400 !important; margin: 0 !important; }
</style>
