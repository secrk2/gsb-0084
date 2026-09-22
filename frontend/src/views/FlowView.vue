<template>
  <div class="page">
    <!-- 手机端不提供设计（与表单设计器同口径） -->
    <div class="mobile-block">
      <div class="card card-pad">
        <h3>📱 手机端仅支持审批与填报</h3>
        <p class="page-sub" style="margin:8px 0 14px">流程设计请在桌面或平板上进行。</p>
        <router-link class="btn primary block" to="/inbox">去审批中心</router-link>
      </div>
    </div>
    <div class="desktop-flow">
    <div v-if="loading" class="spinner"></div>
    <template v-else>
      <div class="page-head">
        <div>
          <router-link :to="`/apps/${form.app_id}/forms`" style="font-size:13px">← 返回表单列表</router-link>
          <h2 class="page-title" style="margin-top:6px">{{ form.name }} · 流程设计</h2>
          <div class="page-sub">一张表单挂一条生效审批流；支持串行、条件分支、并行会签与退回</div>
        </div>
        <div class="head-actions">
          <router-link class="btn" :to="`/forms/${formId}/fill`">👁 预览填报</router-link>
          <router-link class="btn" :to="`/forms/${formId}/approvals`">📋 单据与审批</router-link>
        </div>
      </div>

      <!-- 版本条 -->
      <div class="card version-bar">
        <div class="vb-title">流程版本</div>
        <div class="vb-list">
          <span v-for="f in versions" :key="f.id" class="vb-item" :class="{ active: editing && editing.id === f.id }">
            <button class="vb-btn" @click="openVersion(f)">
              <strong>v{{ f.version }} {{ f.name }}</strong>
              <span class="tag" :class="statusTag(f.status)">{{ statusLabel(f.status) }}</span>
            </button>
          </span>
          <span v-if="!versions.length" class="page-sub">还没有流程，在下方搭建后发布</span>
        </div>
        <div class="vb-ops">
          <button class="btn sm" @click="createDraft(null)" :disabled="editing && editing.status === 'draft'">＋ 新建草稿</button>
          <button v-if="activeFlow" class="btn sm" @click="createDraft(activeFlow.id)">基于生效版新建版本</button>
          <button v-if="activeFlow" class="btn sm danger" @click="disableActive">停用生效流程</button>
        </div>
      </div>

      <div v-if="!editing" class="card card-pad empty" style="margin-top:16px">
        {{ activeFlow ? `当前生效：v${activeFlow.version}。生效中的流程不可直接修改，点「基于生效版新建版本」` : '选择「新建草稿」开始设计审批流' }}
      </div>

      <template v-else>
        <div class="flow-layout">
          <!-- 画布 -->
          <div class="card canvas-card">
            <div class="canvas-top">
              <input class="input flow-name" v-model="editing.name" placeholder="流程名称，如：请假审批流" />
              <span class="tag" :class="statusTag(editing.status)">{{ statusLabel(editing.status) }} · v{{ editing.version }}</span>
            </div>

            <div class="stage-canvas" :class="{ readonly: editing.status !== 'draft' }">
              <div v-if="editing.status !== 'draft'" class="readonly-tip">
                该版本为「{{ statusLabel(editing.status) }}」，内容只读。要调整请点顶部「基于生效版新建版本」。
              </div>
              <div class="endpoint">🚩 发起人提交</div>

              <template v-for="(stage, si) in definition" :key="si">
                <div class="arrow-down">▼</div>

                <!-- 普通审批阶段 -->
                <div v-if="stage.kind === 'approval'" class="stage-block">
                  <div class="stage-tool">
                    <span class="stage-kind">审批节点</span>
                    <button class="btn sm danger" @click="removeStage(si)">删除该阶段</button>
                  </div>
                  <NodeCard :node="stage.node" :schema="form.field_schema" :users="users" />
                </div>

                <!-- 条件分支 -->
                <div v-else class="stage-block branch-block">
                  <div class="branch-head">
                    <span class="branch-title">🔀 条件分支</span>
                    <button class="btn sm" @click="addBranch(stage)">＋ 添加分支</button>
                    <button class="btn sm danger" @click="removeStage(si)">删除整个分支</button>
                  </div>
                  <div class="branches">
                    <div v-for="(b, bi) in stage.branches" :key="bi" class="branch-col">
                      <div class="branch-cond">
                        <template v-if="b.when">
                          <div class="cond-line">
                            <span class="cond-label">如果</span>
                            <select class="select mini-sel" v-model="b.when.field">
                              <option :value="null" disabled>字段</option>
                              <option v-for="f in conditionableFields(form.field_schema)" :key="f.key" :value="f.key">{{ f.label }}</option>
                            </select>
                            <select class="select mini-sel" v-model="b.when.op">
                              <option v-for="o in OP_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
                            </select>
                            <input v-if="needsValue(b.when.op)" class="input mini-in" v-model="b.when.value" placeholder="比较值" />
                          </div>
                          <input class="input branch-label-in" v-model="b.label" placeholder="分支名称，如：金额超 1 万" />
                        </template>
                        <div v-else class="default-branch">
                          <span class="tag muted">默认分支（以上条件都不满足时）</span>
                          <input class="input branch-label-in" v-model="b.label" placeholder="分支名称" />
                        </div>
                        <button v-if="stage.branches.length > 1" class="mini danger" @click="removeBranch(stage, bi)">删分支</button>
                      </div>
                      <div class="branch-nodes">
                        <NodeCard v-for="(n, ni) in b.nodes" :key="n.id" :node="n"
                                  :schema="form.field_schema" :users="users" removable
                                  @remove="b.nodes.splice(ni, 1)" />
                        <p v-if="!b.nodes.length" class="hint">该分支无审批节点（命中后直接进入下一阶段）</p>
                        <button class="btn sm block add-node-btn" @click="addNode(b.nodes)">＋ 审批节点</button>
                      </div>
                    </div>
                  </div>
                  <div class="branch-merge">⇲ 分支汇合</div>
                </div>
              </template>

              <div class="arrow-down">▼</div>
              <div class="endpoint done-end">🏁 流程结束（单据通过）</div>
            </div>

            <div class="canvas-add" v-if="editing.status === 'draft'">
              <button class="btn" @click="addApprovalStage">＋ 串行/会签审批节点</button>
              <button class="btn" @click="addBranchStage">＋ 条件分支</button>
            </div>
          </div>
        </div>

        <div class="action-bar">
          <span class="page-sub" v-if="editing.status === 'draft'">草稿不会影响在跑单据；发布后新提交的单据才走本版本</span>
          <span class="page-sub" v-else>该版本为 {{ statusLabel(editing.status) }}，不可编辑</span>
          <div>
            <button class="btn" :disabled="saving || editing.status !== 'draft'" @click="saveDraft">保存草稿</button>
            <button class="btn primary" :disabled="saving || editing.status !== 'draft'" @click="publish">发布生效</button>
          </div>
        </div>
      </template>
    </template>

    <!-- 发布确认 -->
    <div v-if="showPublish" class="modal-mask" @click.self="showPublish = false">
      <div class="modal">
        <h3>发布「{{ editing.name }} v{{ editing.version }}」？</h3>
        <ul class="rule-list">
          <li>同一表单只允许一条生效流程：发布后当前生效版本（如有）自动<strong>归档</strong>。</li>
          <li><strong>已经在审批中的单据不受影响</strong>：它们绑定提交时的流程版本，按旧定义走到结束，不迁移、不追溯。</li>
          <li>发布之后<strong>新提交</strong>的单据按本版本执行。</li>
        </ul>
        <div v-if="publishProblems.length" class="card" style="border-color:var(--danger);background:var(--danger-soft);margin:10px 0">
          <div v-for="(p, i) in publishProblems" :key="i" style="color:var(--danger);font-size:13px">• {{ p }}</div>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="showPublish = false">再看看</button>
          <button class="btn primary" :disabled="!!publishProblems.length || publishing" @click="confirmPublish">确认发布</button>
        </div>
      </div>
    </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import NodeCard from '../components/flow/NodeCard.vue';
import {
  fetchForm, fetchUsers, fetchFlows, fetchFlow, createFlow, updateFlow,
  publishFlow, disableFlow, newFlowVersion,
} from '../api.js';
import { toast } from '../toast.js';
import { conditionableFields, OP_OPTIONS } from '../flow-format.js';

const route = useRoute();
const formId = route.params.id;
const loading = ref(true);
const saving = ref(false);
const publishing = ref(false);
const form = ref({ field_schema: [] });
const users = ref([]);
const versions = ref([]);
const activeFlow = ref(null);
const editing = ref(null); // 正在编辑/查看的流程（草稿可改）
const definition = ref([]);
const showPublish = ref(false);
const publishProblems = ref([]);

function statusLabel(s) { return { draft: '草稿', active: '生效中', archived: '已归档' }[s] || s; }
function statusTag(s) { return s === 'active' ? '' : 'muted'; }
function needsValue(op) { return !['empty', 'not_empty'].includes(op); }

function newNode() {
  return {
    id: `n_${Math.random().toString(36).slice(2, 9)}`,
    name: '审批节点', mode: 'serial', approver_type: 'fixed', approvers: [], field: null,
  };
}
function addNode(list) { list.push(newNode()); }
function addApprovalStage() { definition.value.push({ kind: 'approval', node: newNode() }); }
function addBranchStage() {
  definition.value.push({
    kind: 'branch',
    branches: [
      { label: '条件一', when: { field: conditionableFields(form.value.field_schema)[0]?.key || null, op: 'gt', value: '' }, nodes: [newNode()] },
      { label: '其他情况', when: null, nodes: [] },
    ],
  });
}
function addBranch(stage) {
  const idx = stage.branches.findIndex((b) => !b.when);
  const b = { label: `条件 ${stage.branches.length}`, when: { field: null, op: 'eq', value: '' }, nodes: [] };
  if (idx >= 0) stage.branches.splice(idx, 0, b); else stage.branches.push(b);
}
function removeBranch(stage, bi) { stage.branches.splice(bi, 1); }
function removeStage(si) { definition.value.splice(si, 1); }

async function loadVersions() {
  versions.value = await fetchFlows(formId);
  activeFlow.value = versions.value.find((f) => f.status === 'active') || null;
}

async function openVersion(f) {
  const full = await fetchFlow(f.id);
  editing.value = full;
  definition.value = JSON.parse(JSON.stringify(full.definition || []));
}

async function createDraft(copyFromId) {
  try {
    let draft;
    if (copyFromId) {
      draft = await newFlowVersion(copyFromId);
      toast.success('已基于生效版创建新草稿');
    } else {
      draft = await createFlow({
        form_id: Number(formId),
        name: '新审批流',
        definition: [
          { kind: 'approval', node: { ...newNode(), name: '审批节点' } },
        ],
      });
    }
    await loadVersions();
    await openVersion(draft);
  } catch (e) { toast.error(e.message); }
}

async function saveDraft(silent = false) {
  saving.value = true;
  try {
    const updated = await updateFlow(editing.value.id, {
      name: editing.value.name,
      definition: definition.value,
    });
    editing.value = updated;
    await loadVersions();
    if (!silent) toast.success('草稿已保存');
    return true;
  } catch (e) {
    toast.error(e.message);
    return false;
  } finally { saving.value = false; }
}

async function publish() {
  // 发布前先存一次（拿到后端校验）
  const ok = await saveDraft(true);
  if (!ok) return;
  // 后端保存时已校验；这里再拉一次问题用于弹窗展示
  publishProblems.value = await clientValidate();
  showPublish.value = true;
}

// 前端侧轻校验（权威以后端为准；发布失败仍会提示后端错误）
async function clientValidate() {
  const problems = [];
  if (!editing.value.name?.trim()) problems.push('流程名称必填');
  if (!definition.value.length) problems.push('至少要有一个审批阶段');
  definition.value.forEach((stage, si) => {
    if (stage.kind === 'approval') {
      checkNode(stage.node, `第 ${si + 1} 阶段`, problems);
    } else {
      stage.branches.forEach((b, bi) => {
        if (b.when) {
          if (!b.when.field) problems.push(`第 ${si + 1} 阶段分支「${b.label || bi + 1}」未选条件字段`);
          if (needsValue(b.when.op) && (b.when.value === '' || b.when.value === null)) {
            problems.push(`第 ${si + 1} 阶段分支「${b.label || bi + 1}」未填比较值`);
          }
        }
        b.nodes.forEach((n) => checkNode(n, `第 ${si + 1} 阶段分支「${b.label || bi + 1}」`, problems));
      });
    }
  });
  return problems;
}
function checkNode(n, where, problems) {
  if (!n.name?.trim()) problems.push(`${where} 有节点未命名`);
  if (n.approver_type === 'fixed' && !(n.approvers || []).length) {
    problems.push(`${where} 节点「${n.name || '?'}」未指定审批人`);
  }
  if (n.approver_type === 'field' && !n.field) {
    problems.push(`${where} 节点「${n.name || '?'}」未选取审批人字段`);
  }
}

async function confirmPublish() {
  publishing.value = true;
  try {
    const r = await publishFlow(editing.value.id);
    toast.success(`已发布 v${r.flow.version}；有 ${r.running_on_previous} 条在跑单据继续按旧版本审批`);
    showPublish.value = false;
    await loadVersions();
    await openVersion(r.flow);
  } catch (e) { toast.error(e.message); }
  finally { publishing.value = false; }
}

async function disableActive() {
  if (!activeFlow.value) return;
  if (!window.confirm('停用后，新提交的单据不再走审批（直接收数）；已经在审批中的单据不受影响。确认停用？')) return;
  try {
    await disableFlow(activeFlow.value.id);
    toast.success('流程已停用');
    editing.value = null;
    await loadVersions();
  } catch (e) { toast.error(e.message); }
}

onMounted(async () => {
  try {
    const [f, u] = await Promise.all([fetchForm(formId), fetchUsers()]);
    form.value = f;
    users.value = u;
    await loadVersions();
    // 默认打开：草稿 > 生效版 > 第一条
    const draft = versions.value.find((x) => x.status === 'draft');
    const target = draft || activeFlow.value || versions.value[0];
    if (target) await openVersion(target);
  } catch (e) {
    toast.error(e.message);
  } finally { loading.value = false; }
});
</script>

<style scoped>
.head-actions { display: flex; gap: 8px; }
.version-bar { padding: 14px 18px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.vb-title { font-weight: 600; font-size: 13.5px; color: var(--text-2); }
.vb-list { display: flex; gap: 8px; flex-wrap: wrap; flex: 1; }
.vb-item .vb-btn { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--border); background: #fff; border-radius: 8px; padding: 5px 12px; cursor: pointer; font-size: 13px; }
.vb-item.active .vb-btn { border-color: var(--brand); background: var(--brand-soft); }
.vb-ops { display: flex; gap: 8px; }
.canvas-card { margin-top: 16px; padding: 18px; }
.canvas-top { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
.flow-name { max-width: 320px; font-weight: 600; }
.stage-canvas { max-width: 760px; margin: 0 auto; }
.readonly-tip { background: #f0f2f7; border-radius: 8px; padding: 8px 12px; font-size: 12.5px; color: var(--text-2); margin-bottom: 12px; }
.stage-canvas.readonly input,
.stage-canvas.readonly select,
.stage-canvas.readonly button { pointer-events: none; }
.stage-canvas.readonly .node-card,
.stage-canvas.readonly .branch-col,
.stage-canvas.readonly .branch-block { opacity: .75; }
.endpoint { background: #eef1f7; border: 1px dashed var(--border); border-radius: 999px; text-align: center; padding: 10px; font-weight: 600; color: var(--text-2); font-size: 13.5px; }
.endpoint.done-end { background: #e9f8ef; border-color: #b7e2c6; color: var(--success); }
.arrow-down { text-align: center; color: var(--text-3); font-size: 11px; margin: 2px 0; }
.stage-block { position: relative; }
.stage-tool { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.stage-kind { font-size: 12px; color: var(--text-3); }
.branch-block { border: 1px solid var(--border); border-radius: 12px; background: #fcfcfe; padding: 12px; }
.branch-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.branch-title { font-weight: 600; font-size: 13.5px; }
.branches { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
.branch-col { border: 1px solid var(--border); border-radius: 10px; background: #fff; padding: 10px; display: flex; flex-direction: column; }
.branch-cond { border-bottom: 1px dashed var(--border); padding-bottom: 8px; margin-bottom: 8px; position: relative; }
.cond-line { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.cond-label { font-size: 12.5px; color: var(--text-3); }
.mini-sel { padding: 5px 8px; font-size: 12.5px; width: auto; min-width: 96px; }
.mini-in { padding: 5px 8px; font-size: 12.5px; width: 110px; }
.branch-label-in { margin-top: 6px; padding: 5px 10px; font-size: 12.5px; }
.default-batch { margin-bottom: 4px; }
.branch-merge { text-align: center; color: var(--text-3); font-size: 12px; margin-top: 10px; }
.branch-nodes { flex: 1; }
.add-node-btn { margin-top: 8px; }
.canvas-add { display: flex; gap: 10px; justify-content: center; margin-top: 18px; }
.action-bar { position: sticky; bottom: 12px; margin-top: 16px; background: #fff; border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow);
  padding: 12px 18px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.rule-list { margin: 12px 0 0; padding-left: 20px; font-size: 13.5px; color: var(--text-2); line-height: 1.9; }
.mini.danger { color: var(--danger); border-color: #f2c2c4; }
.hint { font-size: 12.5px; color: var(--text-3); text-align: center; padding: 8px 0; }
</style>
