<template>
  <div class="page">
    <div v-if="loading" class="spinner"></div>
    <template v-else-if="form">
      <div class="fill-wrap">
        <div class="fill-head">
          <router-link :to="`/apps/${form.app_id}/forms`" style="font-size:13px">← 返回表单列表</router-link>
          <h2 class="page-title" style="margin-top:6px">{{ form.name }}
            <span class="tag warn" style="margin-left:8px;vertical-align:middle">预览填报</span>
          </h2>
          <div class="page-sub">{{ form.description || '设计后直接在此预览，并实际填入一条数据' }}</div>
        </div>

        <div v-if="submitError" class="card" style="border-color:var(--danger);margin-bottom:14px;background:var(--danger-soft)">
          <div style="padding:12px 16px;font-size:13.5px;color:var(--danger)">
            ⚠ {{ submitError }}
            <span v-if="errors.length" style="display:block;margin-top:4px;color:var(--text-2)">
              共 {{ errors.length }} 处问题，已在对应字段下方标出（子表单错误定位到具体行）。
            </span>
          </div>
        </div>

        <div class="card card-pad">
          <DynamicForm :schema="form.field_schema" v-model="formData" :errors="errors" />

          <div class="submit-bar">
            <button class="btn" @click="reset">重置</button>
            <button class="btn primary" :disabled="submitting" @click="submit">
              {{ submitting ? '提交中…' : '提交一条数据' }}
            </button>
          </div>
        </div>

        <!-- 提交成功后的最近记录 -->
        <div v-if="lastRecord" class="card" style="margin-top:18px">
          <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px">
            <span style="color:var(--success)">✅ 提交成功</span>
            <span class="page-sub">记录 #{{ lastRecord.id }} · {{ fmt(lastRecord.created_at) }}</span>
          </div>
          <pre style="padding:14px 18px;margin:0;font-size:12.5px;overflow-x:auto;background:#fafbfe">{{
            JSON.stringify(lastRecord.data, (_k, v) => v, 2)
          }}</pre>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import DynamicForm from '../components/DynamicForm.vue';
import { fetchForm, submitForm } from '../api.js';
import { applyDefaultsClient } from '../schema-utils.js';
import { toast } from '../toast.js';

const route = useRoute();
const formId = route.params.id;
const form = ref(null);
const loading = ref(true);
const submitting = ref(false);
const formData = ref({});
const errors = ref([]);
const submitError = ref('');
const lastRecord = ref(null);

function reset() {
  formData.value = applyDefaultsClient(form.value.field_schema, {});
  errors.value = [];
  submitError.value = '';
}
async function submit() {
  submitting.value = true;
  errors.value = [];
  submitError.value = '';
  try {
    const rec = await submitForm(formId, formData.value);
    lastRecord.value = rec;
    toast.success('提交成功');
    reset(); // 清空表单准备下一条；lastRecord 仍展示刚入库的记录
    lastRecord.value = rec;
  } catch (e) {
    if (e.status === 422) {
      submitError.value = e.data?.message || '提交内容未通过校验';
      errors.value = e.data?.errors || [];
      // 滚动到第一个出错字段
      setTimeout(() => {
        const first = document.querySelector('.field.invalid');
        first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 50);
    } else {
      toast.error(e.message);
    }
  } finally {
    submitting.value = false;
  }
}
function fmt(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

onMounted(async () => {
  try {
    form.value = await fetchForm(formId);
    formData.value = applyDefaultsClient(form.value.field_schema, {});
  } catch (e) {
    toast.error(e.message);
  } finally {
    loading.value = false;
  }
});
</script>
