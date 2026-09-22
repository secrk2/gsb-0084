<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">审批中心</h2>
        <div class="page-sub">当前身份：<strong>{{ userName(actor.current) }}</strong>，切换身份可体验不同审批人的待办</div>
      </div>
      <select class="select" style="width:180px" :value="actor.current" @change="switchActor($event.target.value)">
        <option v-for="u in users" :key="u.id" :value="u.id">{{ u.name }}</option>
      </select>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="tabs">
        <button :class="{ on: tab === 'todo' }" @click="tab = 'todo'">我的待办（{{ todo.length }}）</button>
        <button :class="{ on: tab === 'all' }" @click="tab = 'all'">全部单据</button>
      </div>
    </div>

    <div v-if="loading" class="spinner"></div>

    <div v-else-if="tab === 'todo'" class="card">
      <div v-if="!todo.length" class="empty card-pad">当前没有待办事项 🎉</div>
      <table v-else class="list-table">
        <thead>
          <tr><th>单据</th><th>当前节点</th><th>提交人</th><th>关键信息</th><th>等待时长</th><th style="width:110px">操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="t in todo" :key="t.task_id">
            <td>
              <strong>{{ t.form_name }}</strong>
              <div class="page-sub">#{{ t.submission_id }} · {{ t.flow_name }}</div>
            </td>
            <td><span class="tag warn">{{ t.node_name }}</span></td>
            <td>{{ userName(t.created_by) }}</td>
            <td class="brief">{{ brief(t) }}</td>
            <td>{{ fmtDuration(t.task_created_at) }}</td>
            <td>
              <router-link class="btn sm primary" :to="`/submissions/${t.submission_id}?from=inbox`">去处理</router-link>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-else class="card">
      <div v-if="!instances.length" class="empty card-pad">暂无审批单据</div>
      <table v-else class="list-table">
        <thead>
          <tr><th>单据</th><th>流程版本</th><th>状态</th><th>当前节点 / 待处理人</th><th>提交人/时间</th><th style="width:90px"></th></tr>
        </thead>
        <tbody>
          <tr v-for="x in instances" :key="x.instance_id">
            <td><strong>{{ x.form_name }}</strong><div class="page-sub">#{{ x.submission_id }}</div></td>
            <td>{{ x.flow_name }} v{{ x.flow_version }}</td>
            <td><span class="tag" :class="statusCls(x.submission_status)">{{ statusLabel(x.submission_status) }}</span></td>
            <td>
              <template v-if="x.submission_status === 'in_approval'">
                {{ currentName(x) }}
                <div class="page-sub">{{ pendingNames(x.pending_assignees) }}</div>
              </template>
              <template v-else>—</template>
            </td>
            <td>{{ x.created_by }}<div class="page-sub">{{ fmtDateTime(x.created_at) }}</div></td>
            <td><router-link class="btn sm" :to="`/submissions/${x.submission_id}`">详情</router-link></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref, watch } from 'vue';
import { fetchTodo, fetchInstances, fetchUsers } from '../api.js';
import { actorState, setActor } from '../actor.js';
import { fmtDateTime, fmtDuration, statusOf } from '../flow-format.js';

const actor = actorState;
const users = ref([]);
const tab = ref('todo');
const loading = ref(true);
const todo = ref([]);
const instances = ref([]);

function userName(id) { return users.value.find((u) => u.id === id)?.name || id || '—'; }
function pendingNames(csv) { return (csv || '').split(',').filter(Boolean).map(userName).join('、') || '—'; }
function statusLabel(s) { return statusOf(s).label; }
function statusCls(s) { return statusOf(s).cls; }
function currentName(x) {
  // instances 列表不带节点名，用待办人数量展示会签信息；节点名进详情看
  return x.pending_count > 1 ? `${x.pending_count} 人会签中` : '审批中';
}
function brief(t) {
  const d = t.data || {};
  const parts = [];
  if (d.f_name) parts.push(d.f_name);
  if (d.f_amount !== undefined && d.f_amount !== null) parts.push(`金额 ${d.f_amount}`);
  if (d.f_days) parts.push(`${d.f_days} 天`);
  if (d.f_customer) parts.push(d.f_customer);
  if (d.f_store_name) parts.push(d.f_store_name);
  return parts.join(' · ') || '—';
}
function switchActor(id) { setActor(id); }

async function load() {
  loading.value = true;
  try {
    const [t, all] = await Promise.all([fetchTodo(actor.current), fetchInstances({})]);
    todo.value = t;
    instances.value = all;
  } finally { loading.value = false; }
}
watch(() => actorState.current, load);
onMounted(async () => { users.value = await fetchUsers(); await load(); });
</script>

<style scoped>
.tabs { display: flex; gap: 4px; padding: 8px; }
.tabs button { border: none; background: transparent; padding: 8px 16px; border-radius: 8px; font-size: 14px; cursor: pointer; color: var(--text-2); }
.tabs button.on { background: var(--brand-soft); color: var(--brand); font-weight: 600; }
.brief { max-width: 260px; color: var(--text-2); font-size: 12.5px; }
.tag.ok { background: #e9f8ef; color: var(--success); }
</style>
