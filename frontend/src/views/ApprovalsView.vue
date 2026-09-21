<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">✅ 审批中心</h2>
        <div class="page-sub">
          当前身份：<strong>{{ auth.user.name }}</strong>（{{ auth.user.dept }} · {{ auth.user.role }}）
          · 待办 {{ todo.length }} 条
        </div>
      </div>
      <button class="btn" @click="load">🔄 刷新</button>
    </div>

    <div v-if="loading" class="spinner"></div>
    <template v-else>
      <div v-if="!todo.length" class="card card-pad empty">🎉 当前没有待处理的审批</div>
      <div v-else class="grid" style="gap:12px">
        <div v-for="t in todo" :key="t.task_id" class="card card-pad todo-card">
          <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
            <div>
              <router-link :to="`/instances/${t.instance_id}`" class="todo-title">
                {{ t.form_name }} <span class="page-sub">#{{ t.submission_id }}</span>
              </router-link>
              <div class="todo-meta">
                <span class="tag warn">{{ t.node_name }}</span>
                <span class="tag muted">{{ t.flow_name }}</span>
              </div>
            </div>
            <span class="wait-pill">已停留 {{ duration(t.waiting_seconds) }}</span>
          </div>
          <div class="todo-meta" style="margin-top:8px">
            发起人：{{ t.submitter_name }} · 本节点会签待签 {{ t.pending_total }} 人
            · 单据提交于 {{ fmtTime(t.submitted_at) }}
          </div>
          <div class="todo-data">
            <template v-for="f in topFields(t)" :key="f.key">
              <span class="data-chip"><em>{{ f.label }}</em>：{{ f.text }}</span>
            </template>
          </div>
          <div class="todo-actions">
            <router-link class="btn sm" :to="`/instances/${t.instance_id}`">查看详情</router-link>
            <button class="btn sm primary" :disabled="acting === t.task_id" @click="act(t, 'approve')">✓ 通过</button>
            <button class="btn sm danger" :disabled="acting === t.task_id" @click="act(t, 'return')">↩ 退回发起人</button>
          </div>
        </div>
      </div>

      <div class="card card-pad" style="margin-top:18px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <h4 style="font-size:15px">我发起的单据</h4>
          <router-link class="btn sm" :to="`/instances?submitter=${auth.user.id}`">全部 →</router-link>
        </div>
        <table class="list-table" v-if="mine.length">
          <thead><tr><th>单据</th><th>状态</th><th>当前节点</th><th>已停留</th><th></th></tr></thead>
          <tbody>
            <tr v-for="x in mine" :key="x.id">
              <td>{{ x.form_name }} #{{ x.submission_id }}</td>
              <td><span class="tag" :class="INST_STATUS[x.status]?.cls">{{ INST_STATUS[x.status]?.label }}</span></td>
              <td>{{ x.current_node_name || '—' }}</td>
              <td>{{ x.status === 'running' ? duration(x.waiting_seconds) : '—' }}</td>
              <td>
                <router-link class="btn sm" :to="`/instances/${x.id}`">查看</router-link>
                <router-link v-if="x.status === 'returned'" class="btn sm danger" :to="`/submissions/${x.submission_id}/resubmit`">
                  修改重提
                </router-link>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty" style="padding:20px 0">还没有发起过审批单据</div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { onMounted, ref, watch } from 'vue';
import { fetchTodo, fetchInstances, approveTask, returnTask } from '../api.js';
import { auth } from '../auth.js';
import { duration, fmtTime, INST_STATUS, fieldByKey, formatFieldValue } from '../flow-utils.js';
import { toast } from '../toast.js';

const loading = ref(true);
const acting = ref(0);
const todo = ref([]);
const mine = ref([]);

function topFields(t) {
  // 待办卡片上展示前 3 个有值的顶层标量字段，便于快速判断
  return (t.field_schema || [])
    .filter((f) => f.type !== 'subform' && f.type !== 'attachment'
      && t.data?.[f.key] !== null && t.data?.[f.key] !== '' && !(Array.isArray(t.data?.[f.key]) && !t.data[f.key].length))
    .slice(0, 3)
    .map((f) => ({ key: f.key, label: f.label, text: formatFieldValue(f, t.data[f.key]) }));
}

async function load() {
  loading.value = true;
  try {
    const [td, mi] = await Promise.all([
      fetchTodo(auth.user.id),
      fetchInstances({ submitter: auth.user.id, limit: 20 }),
    ]);
    todo.value = td;
    mine.value = mi;
  } catch (e) {
    toast.error(e.message);
  } finally {
    loading.value = false;
  }
}

async function act(t, kind) {
  let comment = '';
  if (kind === 'return') {
    comment = window.prompt('退回到发起人：请填写退回意见（必填）', '');
    if (comment === null) return;
    if (!comment.trim()) return toast.error('退回必须填写意见');
  } else {
    comment = window.prompt('审批意见（选填）', '') || '';
  }
  acting.value = t.task_id;
  try {
    if (kind === 'approve') await approveTask(t.task_id, auth.user.id, comment.trim());
    else await returnTask(t.task_id, auth.user.id, comment.trim());
    toast.success(kind === 'approve' ? '已通过' : '已退回发起人');
    await load();
  } catch (e) {
    toast.error(e.message);
  } finally {
    acting.value = 0;
  }
}

// 顶栏切换身份后立即刷新待办与我发起的单据
watch(() => auth.user.id, () => load());

onMounted(load);
</script>

<style scoped>
.todo-title { font-weight: 600; font-size: 14.5px; }
.todo-meta { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
.todo-data { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0; }
.data-chip { font-size: 12.5px; color: var(--text-2); background: #f5f7fc; border-radius: 8px; padding: 3px 10px; }
.data-chip em { color: var(--text-3); font-style: normal; margin-right: 2px; }
.todo-actions { display: flex; gap: 8px; }
</style>
