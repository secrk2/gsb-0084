<template>
  <div class="page" style="max-width:1080px">
    <div v-if="loading" class="spinner"></div>
    <template v-else-if="inst">
      <!-- 顶部状态条 -->
      <div class="page-head">
        <div>
          <router-link to="/instances" style="font-size:13px">← 返回实例列表</router-link>
          <h2 class="page-title" style="margin-top:6px">
            {{ inst.form_name }} <span class="page-sub">#{{ inst.submission_id }}</span>
            <span class="tag" :class="INST_STATUS[inst.status]?.cls" style="margin-left:8px;vertical-align:middle">
              {{ INST_STATUS[inst.status]?.label }}
            </span>
            <span v-if="inst.round > 1" class="tag danger" style="vertical-align:middle;margin-left:4px">第 {{ inst.round }} 轮</span>
          </h2>
          <div class="page-sub">{{ inst.flow_name }} v{{ inst.flow_version }} · 发起人 {{ submitterName }} · {{ fmtTime(inst.started_at) }}</div>
        </div>
      </div>

      <div :class="['flow-statusbar', inst.status]">
        <template v-if="inst.status === 'running'">
          <strong>当前停在：{{ inst.current_node_name }}</strong>
          <span>待办：
            <span v-for="t in inst.pending_tasks" :key="t.id" class="tag" style="margin:0 3px">{{ t.name }}</span>
          </span>
          <span class="grow"></span>
          <span class="wait-pill">已停留 {{ duration(inst.waiting_seconds) }}</span>
        </template>
        <template v-else-if="inst.status === 'approved'">
          ✅ 全部节点通过，流程完成于 {{ fmtTime(inst.finished_at) }}
        </template>
        <template v-else>
          ↩ 已退回发起人{{ inst.round > 1 ? '（上一轮退回，现已重新提交）' : '' }}
          <span class="grow"></span>
          <span>{{ fmtTime(inst.returned_at) }}</span>
        </template>
      </div>

      <!-- 节点进度 -->
      <div class="card card-pad" style="margin-bottom:16px">
        <h4 style="margin-bottom:12px">流程进度</h4>
        <div class="node-pipeline">
          <FlowProgress :stages="stages" :states="nodeStates" :routes="routeHits" :decided="routeDecided"
            :submitter-name="submitterName"
            :final-state="inst.status === 'approved' ? 'done' : 'skipped'"
            :final-text="inst.status === 'approved' ? '已通过' : (inst.status === 'returned' ? '已退回' : '进行中')" />
        </div>
      </div>

      <div class="two-col-flow">
        <!-- 左：单据内容 -->
        <div>
          <div class="card card-pad" style="margin-bottom:16px">
            <h4 style="margin-bottom:10px">单据内容（{{ inst.status === 'returned' ? '退回时的版本' : '当前版本' }}）</h4>
            <div v-for="f in inst.field_schema" :key="f.key" class="read-field">
              <template v-if="f.type !== 'subform'">
                <div class="rf-label">{{ f.label }}</div>
                <div class="rf-value">
                  <template v-if="f.type === 'attachment'">
                    <span v-if="(inst.data[f.key] || []).length">
                      <a v-for="(a, i) in inst.data[f.key]" :key="i" :href="attachmentUrl(a.id)" target="_blank">
                        附件 {{ i + 1 }}
                      </a><span v-if="i < inst.data[f.key].length - 1">、</span>
                    </span>
                    <span v-else class="rf-empty">（空）</span>
                  </template>
                  <template v-else>{{ formatFieldValue(f, inst.data[f.key]) }}</template>
                </div>
              </template>
              <template v-else>
                <div class="rf-label">{{ f.label }}（{{ (inst.data[f.key] || []).length }} 行）</div>
                <table v-if="(inst.data[f.key] || []).length" class="list-table rf-sub">
                  <thead>
                    <tr><th v-for="c in f.children" :key="c.key">{{ c.label }}</th></tr>
                  </thead>
                  <tbody>
                    <tr v-for="(row, ri) in inst.data[f.key]" :key="ri">
                      <td v-for="c in f.children" :key="c.key">{{ formatFieldValue(c, row[c.key]) }}</td>
                    </tr>
                  </tbody>
                </table>
                <div v-else class="rf-empty">（无）</div>
              </template>
            </div>
          </div>

          <!-- 修改留痕 -->
          <div class="card card-pad">
            <h4>📝 修改留痕（退回后改了什么，改前改后都保留）</h4>
            <div v-if="!inst.revisions.length" class="empty" style="padding:18px 0">暂无修改记录</div>
            <div v-for="rv in inst.revisions" :key="rv.id" class="revision-card">
              <div class="revision-head">
                第 {{ rv.round }} 轮 · {{ rv.editor_name }} 修改后重新提交 · {{ fmtTime(rv.created_at) }}
                · {{ rv.changes.length }} 处变更
              </div>
              <table class="diff-table">
                <thead><tr><th style="width:26%">字段</th><th style="width:37%">改前</th><th style="width:37%">改后</th></tr></thead>
                <tbody>
                  <tr v-for="(c, i) in rv.changes" :key="i">
                    <td>{{ c.label }}</td>
                    <td class="diff-before">↩ {{ c.before }}</td>
                    <td class="diff-after">✓ {{ c.after }}</td>
                  </tr>
                </tbody>
              </table>
              <details style="padding:8px 14px;border-top:1px solid var(--border)">
                <summary style="cursor:pointer;font-size:12.5px;color:var(--text-2)">查看改前 / 改后完整数据快照</summary>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px">
                  <div>
                    <div class="page-sub" style="margin-bottom:4px">改前</div>
                    <pre class="snapshot-box">{{ JSON.stringify(rv.before_data, null, 2) }}</pre>
                  </div>
                  <div>
                    <div class="page-sub" style="margin-bottom:4px">改后</div>
                    <pre class="snapshot-box">{{ JSON.stringify(rv.after_data, null, 2) }}</pre>
                  </div>
                </div>
              </details>
            </div>
          </div>
        </div>

        <!-- 右：操作 + 时间线 -->
        <div>
          <!-- 我的待办操作 -->
          <div v-if="myTask" class="card card-pad" style="margin-bottom:16px;border-left:3px solid var(--brand)">
            <h4>🎯 需要你处理（{{ myTask.node_name }}）</h4>
            <div class="field" style="margin-top:10px">
              <label>审批意见</label>
              <textarea class="textarea" v-model="comment" placeholder="通过可留空；退回请写明需要修改什么" rows="3"></textarea>
            </div>
            <div style="display:flex;gap:10px">
              <button class="btn primary" style="flex:1" :disabled="busy" @click="act('approve')">✓ 通过</button>
              <button class="btn danger" style="flex:1" :disabled="busy" @click="act('return')">↩ 退回发起人</button>
            </div>
            <div class="fn-hint">退回后单据回到发起人手中，其修改痕迹会逐字段保留。</div>
          </div>

          <!-- 退回给我：修改重提 -->
          <div v-if="inst.status === 'returned'" class="card card-pad" style="margin-bottom:16px;border-left:3px solid var(--danger)">
            <h4>↩ 单据已被退回</h4>
            <div class="tl-comment" style="margin:8px 0">{{ inst.return_comment || '（退回人未填写意见）' }}</div>
            <router-link class="btn danger block" :to="`/submissions/${inst.submission_id}/resubmit`">
              ✏️ 修改后重新提交
            </router-link>
          </div>

          <div class="card card-pad">
            <h4 style="margin-bottom:12px">处理记录</h4>
            <ul class="timeline">
              <li v-for="e in inst.events" :key="e.id" :class="eventClass(e.action)">
                <div><strong>{{ EVENT_LABEL[e.action] || e.action }}</strong>
                  <span v-if="e.node_name" class="tag muted" style="margin-left:6px">{{ e.node_name }}</span>
                </div>
                <div class="tl-time">{{ e.actor_name || '系统' }} · {{ fmtTime(e.created_at) }}</div>
                <div v-if="e.comment" class="tl-comment">{{ e.comment }}</div>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import FlowProgress from '../components/flow/FlowProgress.vue';
import { fetchInstance, approveTask, returnTask } from '../api.js';
import { auth, userName } from '../auth.js';
import { duration, fmtTime, INST_STATUS, EVENT_LABEL, graphToStages, formatFieldValue } from '../flow-utils.js';
import { attachmentUrl } from '../api.js';
import { toast } from '../toast.js';

const route = useRoute();
const loading = ref(true);
const inst = ref(null);
const comment = ref('');
const busy = ref(false);

const submitterName = computed(() => userName(inst.value?.submitter));
const stages = computed(() => graphToStages(inst.value?.definition || { nodes: [] }) || []);
const myTask = computed(() =>
  inst.value?.pending_tasks?.find((t) => t.assignee === auth.user.id) || null);

// 本轮已经过的节点（按当前轮次任务 + 自动通过事件）
const traversed = computed(() => {
  const set = new Map(); // nodeKey → 'approve' | 'return' | 'auto'
  for (const t of inst.value?.tasks || []) {
    if (t.round === inst.value.round && t.status === 'approved') set.set(t.node_key, 'approve');
  }
  for (const e of inst.value?.events || []) {
    if (e.action === 'auto_pass') set.set(e.node_key, 'auto');
  }
  return set;
});

// 节点顺序索引（递归展平含分支内部）
const orderIndex = computed(() => {
  const m = new Map();
  let i = 0;
  const walk = (list) => {
    for (const s of list) {
      m.set(s.key, i++);
      if (s.kind === 'condition') {
        for (const b of s.branches || []) walk(b.stages || []);
        walk(s.defaultStages || []);
      }
    }
  };
  walk(stages.value);
  return m;
});

const nodeStates = computed(() => {
  const out = {};
  const curKey = inst.value?.current_node_key;
  for (const key of orderIndex.value.keys()) {
    if (key === curKey) out[key] = 'current';
    else if (traversed.value.has(key)) out[key] = 'done';
    else out[key] = 'skipped';
  }
  return out;
});

// 条件分支命中：取每个条件节点最后一条 route 事件
const routeHits = computed(() => {
  const m = {};
  for (const e of inst.value?.events || []) {
    if (e.action !== 'route') continue;
    if (e.comment?.startsWith('命中分支：')) m[e.node_key] = e.comment.slice('命中分支：'.length);
    else m[e.node_key] = null; // 默认分支或无命中
  }
  return m;
});
const routeDecided = computed(() => {
  const m = {};
  for (const k of Object.keys(routeHits.value)) m[k] = true;
  return m;
});

function eventClass(action) {
  if (action === 'approve' || action === 'finish' || action === 'auto_pass') return 'ok';
  if (action === 'return') return 'bad';
  if (action === 'resubmit' || action === 'start') return 'cur';
  return '';
}

async function load() {
  loading.value = true;
  try {
    inst.value = await fetchInstance(route.params.id);
  } catch (e) { toast.error(e.message); }
  finally { loading.value = false; }
}

async function act(kind) {
  if (kind === 'return' && !comment.value.trim()) return toast.error('退回必须填写意见，告诉发起人要改什么');
  busy.value = true;
  try {
    if (kind === 'approve') await approveTask(myTask.value.id, auth.user.id, comment.value.trim());
    else await returnTask(myTask.value.id, auth.user.id, comment.value.trim());
    toast.success(kind === 'approve' ? '已通过' : '已退回发起人');
    comment.value = '';
    await load();
  } catch (e) { toast.error(e.message); }
  finally { busy.value = false; }
}

onMounted(load);
</script>

<style scoped>
.read-field { padding: 8px 0; border-bottom: 1px dashed var(--border); }
.read-field:last-child { border-bottom: none; }
.rf-label { font-size: 12px; color: var(--text-3); margin-bottom: 2px; }
.rf-value { font-size: 13.5px; white-space: pre-wrap; word-break: break-word; }
.rf-empty { color: var(--text-3); }
.rf-sub { margin-top: 6px; border: 1px solid var(--border); border-radius: 8px; }
.rf-sub th, .rf-sub td { padding: 6px 10px; font-size: 12.5px; }
.snapshot-box { background: #fafbfe; border: 1px solid var(--border); border-radius: 8px; padding: 10px; font-size: 11.5px; max-height: 280px; overflow: auto; margin: 0; }
</style>
