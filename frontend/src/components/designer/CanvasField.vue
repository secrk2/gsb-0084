<template>
  <div :class="path ? 'subform-box' : ''" :style="path ? '' : ''">
    <div class="cf-label" :class="{ sel: isSelf }" @click.stop="$emit('select-child', fullPath)">
      <strong>{{ field.label }}</strong>
      <span v-if="field.required" class="req-star">*</span>
      <span v-if="field.unique" class="tag warn" style="margin-left:6px">唯一</span>
      <span class="tag muted" style="margin-left:6px">{{ FIELD_TYPES[field.type]?.label }}</span>
      <span v-if="path" style="margin-left:auto">
        <button class="cf-btn" title="复制子字段" @click.stop="$emit('duplicate-child', fullPath)">⧉</button>
        <button class="cf-btn" title="删除子字段" @click.stop="$emit('remove-child', fullPath)">✕</button>
      </span>
    </div>

    <!-- 只读外观 -->
    <div v-if="field.type !== 'subform'" class="cf-preview" @click.stop="$emit('select-child', fullPath)">
      <input v-if="field.type === 'text'" class="input" disabled :placeholder="`请输入${field.label}`" />
      <textarea v-else-if="field.type === 'textarea'" class="textarea" disabled :placeholder="`请输入${field.label}`" style="min-height:56px"></textarea>
      <input v-else-if="field.type === 'number'" class="input" disabled
        :placeholder="numberHint" />
      <input v-else-if="field.type === 'date'" class="input" disabled
        :placeholder="field.datePrecision === 'month' ? 'YYYY-MM（只填到月）' : 'YYYY-MM-DD'" />
      <select v-else-if="field.type === 'select'" class="select" disabled>
        <option>请选择（{{ field.options?.length || 0 }} 个选项）</option>
      </select>
      <div v-else-if="field.type === 'multiselect'" class="cf-chips">
        <span v-for="o in (field.options || []).slice(0, 4)" :key="o.value" class="tag muted">{{ o.label }}</span>
        <span v-if="field.options?.length > 4" class="tag muted">+{{ field.options.length - 4 }}</span>
      </div>
      <div v-else-if="field.type === 'attachment'" class="upload-trigger" style="padding:8px">
        📎 附件上传（最多 {{ field.maxCount || 5 }} 个）
      </div>
    </div>

    <!-- 子表单：嵌套子字段列表 -->
    <div v-else style="margin-top:6px">
      <CanvasField v-for="c in field.children" :key="c.key" :field="c" :path="fullPath"
        :selected-path="selectedPath"
        @select-child="$emit('select-child', $event)"
        @remove-child="$emit('remove-child', $event)"
        @duplicate-child="$emit('duplicate-child', $event)"
        @add-child="(p, t) => $emit('add-child', p, t)" />
      <select v-if="addingChild" class="select" style="margin-top:6px" v-model="newChildType"
        @change="onAddChild">
        <option value="">— 选择子字段类型并添加 —</option>
        <option v-for="t in childTypes" :key="t" :value="t">{{ FIELD_TYPES[t].label }}</option>
      </select>
      <button v-else class="btn sm" style="margin-top:6px" @click.stop="addingChild = true">＋ 添加子字段</button>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { FIELD_TYPES } from '../../constants.js';

const props = defineProps({
  field: { type: Object, required: true },
  path: { type: String, default: '' }, // 父路径，空表示顶层
  selectedPath: { type: String, default: '' },
});
const emit = defineEmits(['select-child', 'remove-child', 'duplicate-child', 'add-child']);

const fullPath = computed(() => (props.path ? `${props.path}.${props.field.key}` : props.field.key));
const isSelf = computed(() => props.selectedPath === fullPath.value);
const numberHint = computed(() => {
  const f = props.field;
  const r = (f.min !== '' && f.min !== null) || (f.max !== '' && f.max !== null)
    ? `范围 ${f.min ?? '∞'} ~ ${f.max ?? '∞'}` : '数字';
  return f.unit ? `${r}（单位：${f.unit}）` : r;
});

const childTypes = ['text', 'textarea', 'number', 'date', 'select', 'multiselect'];
const addingChild = ref(false);
const newChildType = ref('text');
function onAddChild() {
  if (newChildType.value) {
    emit('select-child', fullPath.value); // 先确保父节点在属性面板可响应
    // 通过父组件（Designer）加子字段：这里冒泡自定义事件
    emit('add-child', fullPath.value, newChildType.value);
  }
  addingChild.value = false;
  newChildType.value = 'text';
}
</script>

<style scoped>
.cf-label { display: flex; align-items: center; gap: 4px; font-size: 13.5px; margin-bottom: 6px; padding: 2px 2px; border-radius: 6px; }
.cf-label.sel { color: var(--brand); }
.cf-preview { pointer-events: none; }
.cf-preview .input:disabled, .cf-preview .textarea:disabled, .cf-preview .select:disabled {
  background: #f7f8fb; color: var(--text-3); cursor: default; opacity: 1;
}
.cf-chips { display: flex; flex-wrap: wrap; gap: 6px; }
</style>
