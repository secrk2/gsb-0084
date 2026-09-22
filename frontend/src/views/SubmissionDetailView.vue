<template>
  <div class="page">
    <div v-if="loading" class="spinner"></div>
    <template v-else-if="detail">
      <!-- 顶部 -->
      <div class="page-head">
        <div>
          <router-link :to="backLink" style="font-size:13px">← 返回单据列表</router-link>
          <h2 class="page-title" style="margin-top:6px">
            单据 #{{ detail.submission.id }} · {{ detail.form.name }}
            <span class="tag" :class="statusCls" style="margin-left:8px">{{ statusLabel }}</span>
            <span v-if="detail.flow" class="tag muted" style="margin-left:6px">
              {{ detail.flow.name }} v{{ detail.flow.version }}
              <span v-if="flowReplaced" title="该流程版本已被新版本替换，但本单据仍按本版本审批">（旧版在跑）</span>
            </span>
          </h2>
          <div class="page-sub">
            发起人 {{ userName(detail.submission.created_by) }} · 提交于 {{ fmtDateTime(detail.submission.created_at) }}
          </div>
        </div>
      </div>

      <!-- 当前节点状态条 -->
      <div v-if="detail.current" class="card current-card" :class="detail.current.phase">
        <template v-if="detail.current.phase === 'approving'">
          <div class="cc-main">
            <span class="cc-dot"></span>
            <div>
              <div class="cc-title">
                当前停在「{{ detail.current.label }}」
                <span class="tag" :class="detail.current.mode === 'countersign' ? 'warn' : 'muted'">
                  {{ detail.current.mode === 'countersign' ? '并行会签' : '串行审批' }}
                </span>
              </div>
              <div class="cc-sub">
                待处理：<strong v-for="(a, i) in detail.current.assignees" :key="a">
                  {{ i ? '、' : '' }}{{ userName(a) }}
                </strong>
                <span v-if="!detail.current.assignees.length">—</span>
              </div>
            </div>
          </div>
          <div class="cc-wait">已停留 <strong>{{ fmtDuration(detail.current.since) }}</strong></div>
        </template>
        <template v-else-if="detail.current.phase === 'returned'">
          <div class="cc-main">
            <span class="cc-dot returned"></span>
            <div>
              <div class="cc-title">已退回发起人 · 待修改重提</div>
              <div class="cc-sub">
                {{ userName(detail.submission.created_by) }} 修改后可重新提交；重提后从第一个节点重新审批，已停留
                {{ fmtDuration(detail.current.since) }}
              </div>
            </div>
          </div>
        </template>
        <template v-else>
          <div class="cc-main">
            <span class="cc-dot" :class="detail.current.phase"></span>
            <div>
              <div class="cc-title">{{ detail.current.label }}</div>
              <div class="cc-sub">{{ fmtDateTime(detail.current.since) }}</div>
            </div>
          </div>
        </template>
      </div>

      <div class="detail-grid">
        <div>
          <!-- 节点进度 -->
          <div v-if="detail.progress.length" class="card card-pad" style="margin-bottom:16px">
            <h3 class="block-title">审批节点</h3>
            <div class="stepper">
              <template v-for="(p, i) in detail.progress" :key="i">
                <div class="step" :class="p.state">
                  <span class="step-dot">{{ stateIcon(p.state) }}</span>
                  <div class="step-body">
                    <div class="step-name">
                      {{ p.name }}
                      <span class="tag" :class="p.mode === 'countersign' ? 'warn' : 'muted'" style="margin-left:6px">
                        {{ p.mode === 'countersign' ? '会签' : '串行' }}
                      </span>
                      <span v-if="p.branch_idx !== null && p.branch_idx !== undefined" class="tag muted" style="margin-left:4px">
                        {{ branchName(p.stage_idx, p.branch_idx) }}
                      </span>
                    </div>
                    <div class="step-people">
                      <span v-for="(t, ti) in p.tasks" :key="ti" class="person" :class="t.status">
                        {{ userName(t.assignee) }}
                        <em v-if="t.status !== 'pending'">（{{ taskStatusLabel(t.status) }}）</em>
                      </span>
                    </div>
                  </div>
                </div>
                <div v-if="i < detail.progress.length - 1" class="step-line" :class="{ done: p.state === 'done' }"></div>
              </template>
            </div>
          </div>

          <!-- 审批操作 -->
          <div v-if="myTask" class="card card-pad" style="margin-bottom:16px;border-color:var(--brand)">
            <h3 class="block-title">审批操作 <span class="page-sub" style="font-weight:400">（当前身份：{{ userName(actor) }}）</span></h3>
            <textarea class="textarea" v-model="comment" placeholder="审批意见（可选）" maxlength="500"></textarea>
            <div class="action-btns">
              <button class="btn primary" :disabled="acting" @click="doApprove">✓ 通过</button>
              <button class="btn danger" :disabled="acting" @click="doReject">✕ 驳回（终态）</button>
              <button class="btn" :disabled="acting || atFirstNode" :title="atFirstNode ? '第一个节点没有上一节点' : ''"
                      @click="doReturn('previous')">↩ 退回上一节点</button>
              <button class="btn" :disabled="acting" @click="doReturn('initiator')">↩ 退回发起人（改单重提）</button>
            </div>
            <div class="hint-text">
              退回上一节点：由上一个审批节点重新审批，通过后继续往下；退回发起人：单据退回，发起人改完重新提交，从头再审。
            </div>
          </div>

          <!-- 退回后改单重提 -->
          <div v-if="canEdit" class="card card-pad" style="margin-bottom:16px;border-color:var(--danger)">
            <h3 class="block-title">修改单据 <span class="page-sub" style="font-weight:400">（仅发起人可改；改完重新提交）</span></h3>
            <DynamicForm :schema="detail.form.field_schema" v-model="editData" :errors="editErrors" />
            <div class="action-btns">
              <button class="btn" @click="resetEdit">重置为当前内容</button>
              <button class="btn primary" :disabled="resubmitting" @click="previewDiff">预览改动并重提</button>
            </div>
          </div>

          <!-- 单据内容 -->
          <div class="card card-pad">
            <h3 class="block-title">单据内容 <span class="page-sub" style="font-weight:400">（当前版本{{ editRevision }}）</span></h3>
            <div class="data-grid">
              <template v-for="f in detail.form.field_schema" :key="f.key">
                <div v-if="f.type !== 'subform'" class="data-item">
                  <div class="di-label">{{ f.label }}</div>
                  <div class="di-value">{{ formatFieldValue(detail.submission.data[f.key], f) }}</div>
                </div>
                <div v-else class="data-item full">
                  <div class="di-label">{{ f.label }}</div>
                  <table v-if="(detail.submission.data[f.key] || []).length" class="sub-table">
                    <thead>
                      <tr><th v-for="c in f.children" :key="c.key">{{ c.label }}</th></tr>
                    </thead>
                    <tbody>
                      <tr v-for="(row, ri) in detail.submission.data[f.key]" :key="ri">
                        <td v-for="c in f.children" :key="c.key">{{ formatFieldValue(row[c.key], c) }}</td>
                      </tr>
                    </tbody>
                  </table>
                  <div v-else class="di-value">（无）</div>
                </div>
              </template>
            </div>
          </div>
        </div>

        <!-- 时间线 -->
        <div class="card card-pad timeline-card">
          <h3 class="block-title">流程时间线</h3>
          <div class="timeline">
            <div v-for="(item, i) in detail.timeline" :key="i" class="tl-item">
              <template v-if="item.kind === 'action'">
                <span class="tl-dot" :class="item.action"></span>
                <div class="tl-body">
                  <div class="tl-title">
                    {{ actionLabel(item.action) }}
                    <span v-if="item.node_name" class="tl-node">@ {{ item.node_name }}</span>
                  </div>
                  <div class="tl-meta">{{ userName(item.actor) }} · {{ fmtDateTime(item.at) }}</div>
                  <div v-if="item.comment" class="tl-comment">“{{ item.comment }}”</div>
                </div>
              </template>
              <template v-else>
                <span class="tl-dot revision"></span>
                <div class="tl-body">
                  <div class="tl-title">第 {{ item.revision }} 版内容（改后重新提交）</div>
                  <div class="tl-meta">{{ userName(item.actor) }} · {{ fmtDateTime(item.at) }}</div>
                  <div v-if="item.changes?.length" class="diff-box">
                    <div v-for="(c, ci) in item.changes" :key="ci" class="diff-row">
                      <span class="diff-field">{{ c.label }}</span>
                      <span class="diff-before">{{ c.before }}</span>
                      <span class="diff-arrow">→</span>
                      <span class="diff-after">{{ c.after }}</span>
                    </div>
                  </div>
                  <div v-else class="tl-comment">内容无变化</div>
                </div>
              </template>
            </div>
          </div>

          <!-- 历次版本 -->
          <div v-if="detail.revisions.length > 1" class="revisions">
            <h3 class="block-title" style="margin-top:18px">历史版本（改前/改后）</h3>
            <div v-for="rv in [...detail.revisions].reverse()" :key="rv.id" class="rev-item">
              <div class="rev-head">
                <strong>第 {{ rv.revision }} 版</strong>
                <span class="page-sub">{{ userName(rv.created_by) }} · {{ fmtDateTime(rv.created_at) }}</span>
                <button class="btn sm" @click="showRev = showRev === rv.revision ? null : rv.revision">
                  {{ showRev === rv.revision ? '收起' : '查看内容' }}
                </button>
              </div>
              <div v-if="rv.revision > 1 && rv.change_summary?.length" class="diff-box">
                <div v-for="(c, ci) in rv.change_summary" :key="ci" class="diff-row">
                  <span class="diff-field">{{ c.label }}</span>
                  <span class="diff-before">{{ c.before }}</span>
                  <span class="diff-arrow">→</span>
                  <span class="diff-after">{{ c.after }}</span>
                </div>
              </div>
              <pre v-if="showRev === rv.revision" class="rev-json">{{ JSON.stringify(rv.data, null, 2) }}</pre>
            </div>
          </div>
        </div>
      </div>

      <!-- 重提前 diff 确认 -->
      <div v-if="diffChanges !== null" class="modal-mask" @click.self="diffChanges = null">
        <div class="modal modal-wide">
          <h3>确认改动并重新提交</h3>
          <div class="page-sub" style="margin:6px 0 10px">重提后流程从第一个节点重新审批，本次改动将留痕：</div>
          <div v-if="!diffChanges.length" class="hint-text">内容没有任何变化，仍可重新提交。</div>
          <div v-else class="diff-box big">
            <div v-for="(c, i) in diffChanges" :key="i" class="diff-row">
              <span class="diff-field">{{ c.label }}</span>
              <span class="diff-before">{{ c.before }}</span>
              <span class="diff-arrow">→</span>
              <span class="diff-after">{{ c.after }}</span>
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn" @click="diffChanges = null">取消</button>
            <button class="btn primary" :disabled="resubmitting" @click="confirmResubmit">确认重新提交</button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import DynamicForm from '../components/DynamicForm.vue';
import {
  fetchInstanceDetail, fetchUsers, approveTask, rejectTask, returnTask,
  previewResubmitDiff, resubmitForm,
} from '../api.js';
import { actorState } from '../actor.js';
import { toast } from '../toast.js';
import { applyDefaultsClient } from '../schema-utils.js';
import { fmtDateTime, fmtDuration, formatFieldValue, ACTION_LABELS } from '../flow-format.js';

const route = useRoute();
const router = useRouter();
const submissionId = route.params.id;
const actor = computed(() => actorState.current);

const loading = ref(true);
const detail = ref(null);
const users = ref([]);
const comment = ref('');
const acting = ref(false);
const editData = ref({});
const editErrors = ref([]);
const resubmitting = ref(false);
const diffChanges = ref(null);
const showRev = ref(null);

const backLink = computed(() =>
  route.query.from === 'inbox' ? '/inbox' : `/forms/${detail.value?.form.id}/approvals`);

const statusMap = {
  submitted: ['已收数', 'muted'], in_approval: ['审批中', 'warn'],
  returned: ['已退回', 'danger'], approved: ['审批通过', 'ok'], rejected: ['已驳回', 'danger'],
};
const statusLabel = computed(() => statusMap[detail.value.submission.status]?.[0] || detail.value.submission.status);
const statusCls = computed(() => statusMap[detail.value.submission.status]?.[1] || 'muted');

const flowReplaced = computed(() =>
  detail.value?.flow?.status === 'archived' && detail.value.instance?.status === 'running');

const myTaskIds = computed(() =>
  detail.value?.current?.phase === 'approving' ? detail.value.current.task_ids || [] : []);
const myTask = computed(() => {
  const cur = detail.value?.current;
  if (cur?.phase !== 'approving') return null;
  const idx = cur.assignees.indexOf(actor.value);
  if (idx < 0) return null;
  return { id: cur.task_ids[idx], assignee: actor.value };
});
const atFirstNode = computed(() => detail.value?.instance?.node_cursor <= 0);

const canEdit = computed(() =>
  detail.value?.submission?.status === 'returned'
  && detail.value.submission.created_by === actor.value);

const editRevision = computed(() => {
  const n = detail.value?.revisions.length || 0;
  return n ? `（第 ${n} 版）` : '';
});

function userName(id) { return users.value.find((u) => u.id === id)?.name || (id || '—'); }
function taskStatusLabel(s) {
  return { approved: '通过', rejected: '驳回', cancelled: '已作废', skipped: '跳过', returned: '退回', pending: '待处理' }[s] || s;
}
function stateIcon(s) { return { done: '✓', active: '…', rejected: '✕', waiting: '' }[s] || ''; }
function actionLabel(a) { return ACTION_LABELS[a] || a; }
function branchName(stageIdx, branchIdx) {
  const stage = detail.value.definition?.[stageIdx];
  return stage?.branches?.[branchIdx]?.label || '';
}

async function reload() {
  detail.value = await fetchInstanceDetail(submissionId);
  resetEdit();
}
function resetEdit() {
  if (detail.value) editData.value = applyDefaultsClient(detail.value.form.field_schema, detail.value.submission.data);
  editErrors.value = [];
}

async function afterAction(msg) {
  toast.success(msg);
  comment.value = '';
  await reload();
}
async function doApprove() {
  acting.value = true;
  try { await approveTask(myTask.value.id, comment.value); await afterAction('已通过'); }
  catch (e) { toast.error(e.message); } finally { acting.value = false; }
}
async function doReject() {
  if (!window.confirm('驳回是终态操作，单据将不能再修改提交。确认驳回？')) return;
  acting.value = true;
  try { await rejectTask(myTask.value.id, comment.value); await afterAction('已驳回'); }
  catch (e) { toast.error(e.message); } finally { acting.value = false; }
}
async function doReturn(target) {
  const tip = target === 'previous' ? '退回到上一审批节点？' : '退回发起人？发起人改单后将从头重新审批。';
  if (!window.confirm(tip)) return;
  acting.value = true;
  try { await returnTask(myTask.value.id, target, comment.value); await afterAction(target === 'previous' ? '已退回上一节点' : '已退回发起人'); }
  catch (e) { toast.error(e.message); } finally { acting.value = false; }
}

async function previewDiff() {
  try {
    diffChanges.value = await previewResubmitDiff(submissionId, editData.value);
  } catch (e) { toast.error(e.message); }
}
async function confirmResubmit() {
  resubmitting.value = true;
  try {
    await resubmitForm(submissionId, editData.value);
    diffChanges.value = null;
    toast.success('已重新提交，流程从头审批');
    await reload();
  } catch (e) {
    if (e.status === 422) {
      editErrors.value = e.data?.errors || [];
      toast.error('修改内容未通过校验，已在字段下标出');
      diffChanges.value = null;
    } else toast.error(e.message);
  } finally { resubmitting.value = false; }
}

onMounted(async () => {
  try {
    users.value = await fetchUsers();
    await reload();
  } catch (e) { toast.error(e.message); }
  finally { loading.value = false; }
});
</script>

<style scoped>
.current-card { padding: 16px 20px; display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 16px; border-left: 4px solid var(--brand); }
.current-card.returned, .current-card:has(.cc-dot.returned) { border-left-color: var(--danger); }
.cc-main { display: flex; gap: 14px; align-items: center; }
.cc-dot { width: 12px; height: 12px; border-radius: 50%; background: var(--brand); box-shadow: 0 0 0 5px var(--brand-soft); flex: none; }
.cc-dot.returned { background: var(--danger); box-shadow: 0 0 0 5px var(--danger-soft); }
.cc-dot.approved { background: var(--success); box-shadow: 0 0 0 5px #e9f8ef; }
.cc-dot.rejected { background: var(--danger); box-shadow: 0 0 0 5px var(--danger-soft); }
.cc-title { font-weight: 600; font-size: 15px; display: flex; align-items: center; gap: 6px; }
.cc-sub { color: var(--text-2); font-size: 13px; margin-top: 3px; }
.cc-wait { color: var(--text-2); font-size: 13px; white-space: nowrap; }
.cc-wait strong { color: var(--danger); font-size: 15px; }
.detail-grid { display: grid; grid-template-columns: 1.35fr 1fr; gap: 16px; align-items: start; }
.block-title { font-size: 14.5px; margin: 0 0 14px; }
.stepper .step { display: flex; gap: 12px; }
.step-dot { width: 24px; height: 24px; border-radius: 50%; background: #eef1f7; color: var(--text-3); display: inline-flex; align-items: center; justify-content: center; font-size: 12px; flex: none; font-weight: 700; }
.step.done .step-dot { background: var(--success); color: #fff; }
.step.active .step-dot { background: var(--brand); color: #fff; }
.step.rejected .step-dot { background: var(--danger); color: #fff; }
.step-body { padding-bottom: 4px; }
.step-name { font-size: 13.5px; font-weight: 500; }
.step-people { color: var(--text-3); font-size: 12.5px; margin-top: 2px; display: flex; flex-wrap: wrap; gap: 4px 12px; }
.person.approved { color: var(--success); }
.person.rejected, .person.cancelled { color: var(--text-3); text-decoration: line-through; }
.step-line { width: 2px; height: 16px; background: #dde2ec; margin: 2px 0 2px 11px; }
.step-line.done { background: var(--success); }
.action-btns { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.hint-text { font-size: 12px; color: var(--text-3); margin-top: 8px; line-height: 1.6; }
.data-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 20px; }
.data-item.full { grid-column: 1 / -1; }
.di-label { font-size: 12px; color: var(--text-3); margin-bottom: 2px; }
.di-value { font-size: 13.5px; word-break: break-word; }
.sub-table { width: 100%; border-collapse: collapse; margin-top: 4px; font-size: 12.5px; }
.sub-table th, .sub-table td { border: 1px solid var(--border); padding: 6px 9px; text-align: left; }
.sub-table th { background: #fafbfe; font-weight: 500; }
.timeline-card { position: sticky; top: 16px; }
.timeline { max-height: 520px; overflow-y: auto; }
.tl-item { display: flex; gap: 10px; position: relative; padding-bottom: 16px; }
.tl-item::before { content: ''; position: absolute; left: 5px; top: 14px; bottom: 0; width: 2px; background: #eef1f7; }
.tl-item:last-child::before { display: none; }
.tl-dot { width: 12px; height: 12px; border-radius: 50%; background: var(--brand); margin-top: 3px; flex: none; z-index: 1; }
.tl-dot.approve { background: var(--success); }
.tl-dot.reject { background: var(--danger); }
.tl-dot.return_initiator, .tl-dot.return_previous { background: #e0a800; }
.tl-dot.submit, .tl-dot.node_enter { background: #b6bdcc; }
.tl-dot.revision { background: #7a5cff; }
.tl-title { font-size: 13.5px; font-weight: 500; }
.tl-node { color: var(--text-3); font-weight: 400; font-size: 12.5px; }
.tl-meta { font-size: 12px; color: var(--text-3); margin-top: 2px; }
.tl-comment { font-size: 12.5px; color: var(--text-2); margin-top: 4px; background: #fafbfe; border-radius: 6px; padding: 5px 9px; }
.diff-box { margin-top: 6px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.diff-box.big { max-height: 50vh; overflow-y: auto; }
.diff-row { display: grid; grid-template-columns: 110px 1fr 20px 1fr; gap: 6px; font-size: 12.5px; padding: 6px 10px; border-bottom: 1px solid var(--border); align-items: start; }
.diff-row:last-child { border-bottom: none; }
.diff-field { color: var(--text-3); }
.diff-before { color: var(--danger); background: var(--danger-soft); border-radius: 5px; padding: 1px 6px; word-break: break-word; }
.diff-arrow { color: var(--text-3); text-align: center; }
.diff-after { color: var(--success); background: #e9f8ef; border-radius: 5px; padding: 1px 6px; word-break: break-word; }
.rev-item { border-top: 1px solid var(--border); padding-top: 12px; margin-top: 12px; }
.rev-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.rev-head .page-sub { flex: 1; }
.rev-json { background: #fafbfe; border-radius: 8px; padding: 10px; font-size: 11.5px; max-height: 260px; overflow: auto; margin: 8px 0 0; }
.modal-wide { max-width: 680px; }
.tag.ok { background: #e9f8ef; color: var(--success); }
@media (max-width: 1024px) { .detail-grid { grid-template-columns: 1fr; } .timeline-card { position: static; } }
</style>
