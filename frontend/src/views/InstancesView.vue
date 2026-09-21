<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">📜 流程实例</h2>
        <div class="page-sub">每条审批单据当前停在哪个节点、该谁处理、已经停了多久，一目了然</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <select class="select" style="width:150px" v-model="filters.formId">
          <option value="">全部表单</option>
          <option v-for="f in forms" :key="f.id" :value="f.id">{{ f.name }}</option>
        </select>
        <select class="select" style="width:130px" v-model="filters.status">
          <option value="">全部状态</option>
          <option value="running">审批中</option>
          <option value="approved">已通过</option>
          <option value="returned">已退回</option>
        </select>
        <button class="btn" @click="load">🔄 刷新</button>
      </div>
    </div>

    <div v-if="loading" class="spinner"></div>
    <div v-else-if="!rows.length" class="card card-pad empty">没有符合条件的流程实例</div>
    <div v-else class="card">
      <table class="list-table">
        <thead>
          <tr>
            <th>单据</th><th>流程</th><th>状态</th><th>当前节点</th><th>待办人</th>
            <th>已停留</th><th>轮次</th><th>发起人</th><th>发起时间</th><th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="x in rows" :key="x.id">
            <td>{{ x.form_name }} <span class="page-sub">#{{ x.submission_id }}</span></td>
            <td>{{ x.flow_name }} <span class="tag muted">v{{ x.flow_version }}</span></td>
            <td><span class="tag" :class="INST_STATUS[x.status]?.cls">{{ INST_STATUS[x.status]?.label }}</span></td>
            <td>
              <span v-if="x.status === 'running'"><strong>{{ x.current_node_name }}</strong></span>
              <span v-else style="color:var(--text-3)">—</span>
            </td>
            <td>
              <template v-if="x.status === 'running'">
                <span v-for="t in x.pending_tasks" :key="t.id" class="tag" style="margin:1px 2px">{{ t.name }}</span>
              </template>
              <span v-else style="color:var(--text-3)">—</span>
            </td>
            <td>
              <span v-if="x.status === 'running'" class="wait-pill">{{ duration(x.waiting_seconds) }}</span>
              <span v-else style="color:var(--text-3)">—</span>
            </td>
            <td>
              <span v-if="x.round > 1" class="tag danger">第 {{ x.round }} 轮</span>
              <span v-else>第 1 轮</span>
              <span v-if="x.revision_count" class="page-sub"> · {{ x.revision_count }} 次改单</span>
            </td>
            <td>{{ userName(x.submitter) }}</td>
            <td style="white-space:nowrap;color:var(--text-2)">{{ fmtTime(x.started_at) }}</td>
            <td><router-link class="btn sm" :to="`/instances/${x.id}`">详情</router-link></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { fetchInstances, fetchForms } from '../api.js';
import { userName } from '../auth.js';
import { duration, fmtTime, INST_STATUS } from '../flow-utils.js';
import { toast } from '../toast.js';

const route = useRoute();
const loading = ref(true);
const rows = ref([]);
const forms = ref([]);
const filters = reactive({
  formId: route.query.formId || '',
  status: route.query.status || '',
  submitter: route.query.submitter || '',
});

async function load() {
  loading.value = true;
  try {
    rows.value = await fetchInstances({
      formId: filters.formId, status: filters.status, submitter: filters.submitter,
    });
  } catch (e) {
    toast.error(e.message);
  } finally {
    loading.value = false;
  }
}

watch(() => [filters.formId, filters.status], load);
onMounted(async () => {
  try {
    forms.value = await fetchForms();
  } catch (e) { toast.error(e.message); }
  await load();
});
</script>
