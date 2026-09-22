<template>
  <div class="page">
    <div v-if="loading" class="spinner"></div>
    <template v-else>
      <div class="page-head">
        <div>
          <router-link :to="`/apps/${form.app_id}/forms`" style="font-size:13px">← 返回表单列表</router-link>
          <h2 class="page-title" style="margin-top:6px">{{ form.name }} · 单据与审批</h2>
          <div class="page-sub">
            共 {{ rows.length }} 条单据
            <span v-if="activeFlow"> · 生效流程：{{ activeFlow.name }} v{{ activeFlow.version }}</span>
            <span v-else> · 未挂审批流（提交后直接收数）</span>
          </div>
        </div>
        <div style="display:flex;gap:8px">
          <router-link class="btn" :to="`/forms/${formId}/flow`">🔀 流程设计</router-link>
          <router-link class="btn primary" :to="`/forms/${formId}/fill`">＋ 填报一单</router-link>
        </div>
      </div>

      <div class="card">
        <div v-if="!rows.length" class="empty card-pad">还没有单据</div>
        <table v-else class="list-table">
          <thead>
            <tr><th>#</th><th>状态</th><th>当前节点 / 待处理人</th><th>已停留</th><th>发起人</th><th>提交时间</th><th style="width:80px"></th></tr>
          </thead>
          <tbody>
            <tr v-for="s in rows" :key="s.id">
              <td><strong>#{{ s.id }}</strong>
                <div v-if="s.flow_version" class="page-sub">{{ s.flow_name }} v{{ s.flow_version }}<span v-if="s.flow_version_status === 'archived'">（旧版）</span></div>
              </td>
              <td><span class="tag" :class="statusCls(s.status)">{{ statusLabel(s.status) }}</span></td>
              <td>
                <template v-if="s.status === 'in_approval'">
                  <span class="tag warn">{{ s.current_node_name || '审批中' }}</span>
                  <span v-if="s.pending_count > 1" class="tag" style="margin-left:4px">{{ s.pending_count }} 人会签</span>
                  <div class="page-sub">{{ pendingNames(s.pending_assignees) }}</div>
                </template>
                <template v-else-if="s.status === 'returned'">
                  <span class="tag danger">退回发起人，待改单</span>
                  <div class="page-sub">{{ userName(s.created_by) }}</div>
                </template>
                <template v-else>—</template>
              </td>
              <td>{{ s.status === 'in_approval' ? fmtDuration(s.pending_since) : '—' }}</td>
              <td>{{ userName(s.created_by) }}</td>
              <td>{{ fmtDateTime(s.created_at) }}</td>
              <td><router-link class="btn sm" :to="`/submissions/${s.id}`">详情</router-link></td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { fetchSubmissions, fetchForm, fetchActiveFlow, fetchUsers } from '../api.js';
import { fmtDateTime, fmtDuration, statusOf } from '../flow-format.js';

const route = useRoute();
const formId = route.params.id;
const loading = ref(true);
const rows = ref([]);
const form = ref({});
const activeFlow = ref(null);
const users = ref([]);

function statusLabel(s) { return statusOf(s).label; }
function statusCls(s) { return statusOf(s).cls; }
function userName(id) { return users.value.find((u) => u.id === id)?.name || id || '—'; }
function pendingNames(csv) { return (csv || '').split(',').filter(Boolean).map(userName).join('、'); }

onMounted(async () => {
  try {
    const [f, list, af, u] = await Promise.all([
      fetchForm(formId), fetchSubmissions(formId), fetchActiveFlow(formId), fetchUsers(),
    ]);
    form.value = f; rows.value = list; activeFlow.value = af; users.value = u;
  } finally { loading.value = false; }
});
</script>
