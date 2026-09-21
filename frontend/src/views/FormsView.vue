<template>
  <div class="page">
    <div class="page-head">
      <div>
        <router-link to="/apps" style="font-size:13px">← 返回应用</router-link>
        <h2 class="page-title" style="margin-top:6px">{{ appName || '应用' }} · 表单</h2>
        <div class="page-sub">共 {{ forms.length }} 张表单</div>
      </div>
      <button class="btn primary" @click="showCreate = true">＋ 新建表单</button>
    </div>

    <div v-if="loading" class="spinner"></div>
    <div v-else-if="!forms.length" class="card card-pad empty">
      还没有表单，点右上角「新建表单」开始搭建
    </div>
    <div v-else class="card">
      <table class="list-table">
        <thead>
          <tr><th>表单名称</th><th>说明</th><th>提交量</th><th>引用</th><th>最近更新</th><th style="width:210px">操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="f in forms" :key="f.id">
            <td><strong>{{ f.name }}</strong></td>
            <td style="color:var(--text-2)">{{ f.description || '—' }}</td>
            <td>{{ f.submission_count }}</td>
            <td>
              <span class="tag muted" style="margin-right:4px">流程 {{ f.flow_count }}</span>
              <span class="tag muted">视图 {{ f.view_count }}</span>
            </td>
            <td style="color:var(--text-2);white-space:nowrap">{{ fmt(f.updated_at) }}</td>
            <td style="white-space:nowrap">
              <router-link class="btn sm" :to="`/forms/${f.id}/design`">✏️ 设计</router-link>
              <router-link class="btn sm" :to="`/forms/${f.id}/flow`" style="margin-left:6px">🔀 流程</router-link>
              <router-link class="btn sm primary" :to="`/forms/${f.id}/fill`" style="margin-left:6px">👁 预览填报</router-link>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 新建表单 -->
    <div v-if="showCreate" class="modal-mask" @click.self="showCreate = false">
      <div class="modal">
        <h3>📋 新建表单</h3>
        <div class="field"><label>表单名称</label><input class="input" v-model="form.name" placeholder="如：差旅报销申请" /></div>
        <div class="field"><label>说明</label><textarea class="textarea" v-model="form.description"></textarea></div>
        <div class="field">
          <label>初始字段</label>
          <select class="select" v-model="form.template">
            <option value="blank">空白表单</option>
            <option value="starter">常用起步（单行文本 + 多行文本 + 日期）</option>
          </select>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="showCreate = false">取消</button>
          <button class="btn primary" :disabled="saving" @click="save">创建并设计</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { createForm, fetchApps, fetchForms } from '../api.js';
import { toast } from '../toast.js';

const route = useRoute();
const router = useRouter();
const appId = route.params.appId;
const forms = ref([]);
const appName = ref('');
const loading = ref(true);
const showCreate = ref(false);
const saving = ref(false);
const form = reactive({ name: '', description: '', template: 'starter' });

function starterSchema() {
  const s = Date.now().toString(36);
  return [
    { key: `f_text_${s}`, type: 'text', label: '单行文本', required: true, unique: false, defaultValue: '', validateMessage: '', maxLength: 200, tips: '' },
    { key: `f_area_${s}`, type: 'textarea', label: '多行文本', required: false, unique: false, defaultValue: '', validateMessage: '', maxLength: 1000, tips: '' },
    { key: `f_date_${s}`, type: 'date', label: '日期', required: false, unique: false, defaultValue: null, validateMessage: '', datePrecision: 'day' },
  ];
}

function fmt(t) {
  if (!t) return '—';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function load() {
  loading.value = true;
  try {
    const [apps, fs] = await Promise.all([fetchApps(), fetchForms(appId)]);
    appName.value = apps.find((a) => String(a.id) === String(appId))?.name || '';
    forms.value = fs;
  } catch (e) {
    toast.error(e.message);
  } finally {
    loading.value = false;
  }
}
async function save() {
  if (!form.name.trim()) return toast.error('请填写表单名称');
  saving.value = true;
  try {
    const created = await createForm({
      app_id: Number(appId),
      name: form.name.trim(),
      description: form.description,
      field_schema: form.template === 'starter' ? starterSchema() : [],
    });
    toast.success('表单已创建');
    router.push(`/forms/${created.id}/design`);
  } catch (e) {
    toast.error(e.message);
  } finally {
    saving.value = false;
  }
}
onMounted(load);
</script>
