<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">应用与表单</h2>
        <div class="page-sub">业务部门的小系统都搭在这里</div>
      </div>
      <button class="btn primary" @click="showCreate = true">＋ 新建应用</button>
    </div>

    <div v-if="loading" class="spinner"></div>
    <div v-else class="app-grid">
      <router-link v-for="a in apps" :key="a.id" :to="`/apps/${a.id}/forms`" class="card app-card">
        <div class="app-icon">{{ icon(a.icon) }}</div>
        <h3>{{ a.name }}</h3>
        <div class="page-sub" style="margin-top:4px">{{ a.description || '暂无描述' }}</div>
        <div class="app-stats">
          <span>📋 {{ a.form_count }} 张表单</span>
          <span>📥 累计 {{ a.submission_count }}</span>
          <span>🕐 今日 {{ a.today_count }}</span>
        </div>
      </router-link>
    </div>

    <!-- 新建应用 -->
    <div v-if="showCreate" class="modal-mask" @click.self="showCreate = false">
      <div class="modal">
        <h3>🧩 新建应用</h3>
        <div class="field"><label>应用名称</label><input class="input" v-model="form.name" placeholder="如：行政办公" /></div>
        <div class="field"><label>描述</label><textarea class="textarea" v-model="form.description"></textarea></div>
        <div class="modal-foot">
          <button class="btn" @click="showCreate = false">取消</button>
          <button class="btn primary" :disabled="saving" @click="save">创建</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { createApp, fetchApps } from '../api.js';
import { toast } from '../toast.js';

const apps = ref([]);
const loading = ref(true);
const showCreate = ref(false);
const saving = ref(false);
const form = reactive({ name: '', description: '', icon: 'app' });
const router = useRouter();

const ICONS = { office: '🏢', sales: '💼', store: '🏬', app: '🧩' };
function icon(k) { return ICONS[k] || ICONS.app; }

async function load() {
  loading.value = true;
  try { apps.value = await fetchApps(); }
  catch (e) { toast.error(e.message); }
  finally { loading.value = false; }
}
async function save() {
  if (!form.name.trim()) return toast.error('请填写应用名称');
  saving.value = true;
  try {
    const a = await createApp({ ...form });
    toast.success('应用已创建');
    showCreate.value = false;
    router.push(`/apps/${a.id}/forms`);
  } catch (e) {
    toast.error(e.message);
  } finally {
    saving.value = false;
  }
}
onMounted(load);
</script>
