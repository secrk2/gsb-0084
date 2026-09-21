<template>
  <div>
    <div class="upload-trigger" @click="pick">
      <input ref="fileEl" type="file" multiple hidden :accept="field.accept || ''" @change="onChange" />
      📤 点击上传附件<span v-if="field.maxCount">（最多 {{ field.maxCount }} 个，单个 20MB）</span>
      <div v-if="uploading" class="field-tip" style="color:var(--brand)">上传中…</div>
    </div>
    <div v-if="modelValue?.length" class="attach-list" style="margin-top:8px">
      <div v-for="f in modelValue" :key="f.id" class="attach-item">
        <span>📎</span>
        <a class="ai-name" :href="fileUrl(f.id)" target="_blank">{{ f.origin_name || f.name || '附件' }}</a>
        <span class="ai-size">{{ formatSize(f.size_bytes ?? f.size) }}</span>
        <button type="button" class="btn sm danger" @click="remove(f.id)">移除</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { uploadFiles, attachmentUrl } from '../api.js';
import { toast } from '../toast.js';

const props = defineProps({
  field: { type: Object, required: true },
  modelValue: { type: Array, default: () => [] },
});
const emit = defineEmits(['update:modelValue']);
const fileEl = ref(null);
const uploading = ref(false);

function pick() { fileEl.value?.click(); }
function fileUrl(id) { return attachmentUrl(id); }
function formatSize(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
async function onChange(e) {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const remain = (props.field.maxCount || 5) - (props.modelValue?.length || 0);
  if (files.length > remain) {
    toast.error(`最多 ${props.field.maxCount} 个附件`);
    return;
  }
  uploading.value = true;
  try {
    const saved = await uploadFiles(files);
    emit('update:modelValue', [...(props.modelValue || []), ...saved]);
  } catch (err) {
    toast.error(err.message || '上传失败');
  } finally {
    uploading.value = false;
  }
}
function remove(id) {
  emit('update:modelValue', (props.modelValue || []).filter((f) => f.id !== id));
}
</script>
