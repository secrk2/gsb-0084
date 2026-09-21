<template>
  <div class="page flow-design-page">
    <div v-if="loading" class="spinner"></div>
    <template v-else-if="form">
      <div class="page-head">
        <div>
          <router-link :to="`/apps/${form.app_id}/forms`" style="font-size:13px">← 返回表单列表</router-link>
          <h2 class="page-title" style="margin-top:6px">
            🔀 {{ form.name }} · 流程设计
          </h2>
          <div class="page-sub">
            一张表单挂一条生效审批流；支持串行、条件分支、并行会签、退回
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <span v-if="published" class="tag ok">生效中 · v{{ published.version }}</span>
          <span v-else class="tag muted">尚未发布生效流程</span>
          <span v-if="dirty" class="tag warn">草稿有未保存修改</span>
        </div>
      </div>

      <div class="flow-layout">
        <!-- 左：流程画布 -->
        <div class="card card-pad flow-canvas">
          <!-- 触发条件 -->
          <div class="trigger-box">
            <div class="trigger-title">🚦 触发条件</div>
            <label class="trigger-opt">
              <input type="radio" :checked="!triggerEnabled" @change="triggerEnabled = false" />
              所有提交都走这条流程
            </label>
            <label class="trigger-opt">
              <input type="radio" :checked="triggerEnabled" @change="enableTrigger" />
              仅满足条件时发起
            </label>
            <div v-if="triggerEnabled" class="cond-row" style="margin-top:8px">
              <select class="select cond-field" v-model="trigger.field">
                <option value="" disabled>选择字段</option>
                <option v-for="f in scalarFields" :key="f.key" :value="f.key">{{ f.label }}</option>
              </select>
              <select class="select cond-op" v-model="trigger.op">
                <option v-for="o in DESIGNER_OPS" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
              <select v-if="triggerOptionField" class="select cond-val" v-model="trigger.value">
                <option value="" disabled>选择值</option>
                <option v-for="o in triggerOptionField.options" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
              <input v-else-if="triggerNumberField" class="input cond-val" type="number" v-model="trigger.value" placeholder="数值" />
              <input v-else-if="!triggerNoValue" class="input cond-val" v-model="trigger.value" placeholder="比较值" />
              <span v-else class="cond-val noop">—</span>
            </div>
            <div class="fn-hint">不满足触发条件的提交作为普通数据入库，不产生审批任务。</div>
          </div>

          <!-- 开始 -->
          <div class="flow-terminal start">● 开始（发起人提交）</div>

          <StageList :stages="stages" :users="users" :fields="form.field_schema" />

          <!-- 结束 -->
          <div class="flow-terminal end">● 结束（审批通过）</div>
        </div>

        <!-- 右：说明 / 发布 -->
        <aside class="flow-side">
          <div class="card card-pad">
            <h4 style="margin-bottom:10px">流程名称</h4>
            <input class="input" v-model="flowName" placeholder="如：销售订单审批流" />
          </div>

          <div class="card card-pad">
            <h4>发布与换流程口径</h4>
            <ul class="policy-list">
              <li>一张表单同时只有 <strong>一条生效流程</strong>；保存的是草稿，发布后才对新提交生效。</li>
              <li><strong>换流程</strong>（重新发布）后，已经在跑的单据<strong>仍按发起时的旧版定义走完</strong>，不会中途改道；之后的新提交才走新版。</li>
              <li>退回<strong>一律退回发起人</strong>；发起人改完重新提交后，<strong>从第一个审批节点重新走</strong>，修改内容逐字段留痕（改前改后均可查）。</li>
            </ul>
            <div v-if="published" class="version-line">
              当前生效 v{{ published.version }}
              <span v-if="published.running_count > 0">· 有 {{ published.running_count }} 条在途单据将继续按旧版走完</span>
            </div>
          </div>

          <div class="card card-pad flow-actions">
            <button class="btn block" :disabled="saving" @click="save(false)">💾 保存草稿</button>
            <button class="btn primary block" :disabled="saving" @click="save(true)">🚀 保存并发布</button>
            <button v-if="published" class="btn danger block" :disabled="saving" @click="unpublish">停用生效流程</button>
          </div>
        </aside>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import StageList from '../components/flow/StageList.vue';
import {
  fetchFlowDesign, saveFlowDraft, publishFlow, unpublishFlow, fetchFlows, fetchForm, fetchUsers,
} from '../api.js';
import { DESIGNER_OPS } from '../flow-ops.js';
import { emptyStages, graphToStages, stagesToGraph } from '../flow-utils.js';
import { toast } from '../toast.js';

const route = useRoute();
const router = useRouter();
const formId = route.params.id;

const loading = ref(true);
const saving = ref(false);
const form = ref(null);
const users = ref([]);
const flowName = ref('');
const stages = ref([]);
const draftId = ref(null);
const trigger = ref({ field: '', op: 'gt', value: '' });
const triggerEnabled = ref(false);
const published = ref(null);
let savedSnapshot = '';
const dirty = ref(false);

const scalarFields = computed(() => (form.value?.field_schema || []).filter((f) => f.type !== 'subform'));
const triggerField = computed(() => scalarFields.value.find((x) => x.key === trigger.value.field) || null);
const triggerOptionField = computed(() => {
  const f = triggerField.value;
  return f && ['select', 'multiselect'].includes(f.type) ? f : null;
});
const triggerNumberField = computed(() => triggerField.value?.type === 'number');
const triggerNoValue = computed(() => ['empty', 'not_empty'].includes(trigger.value.op));

function enableTrigger() {
  triggerEnabled.value = true;
  if (!trigger.value.op) trigger.value = { field: '', op: 'gt', value: '' };
}

function loadStages(def) {
  const parsed = graphToStages(def);
  if (parsed === null) {
    stages.value = emptyStages();
    toast.error('该流程含设计器不支持的自由连线，已按空白打开，发布前请重新编排');
  } else if (!parsed.length) {
    stages.value = emptyStages();
  } else {
    stages.value = parsed;
  }
  savedSnapshot = JSON.stringify(stages.value);
  stopWatch?.();
  stopWatch = watch(stages, () => { dirty.value = true; }, { deep: true });
}

let stopWatch = null;

async function buildPayload() {
  const { nodes } = stagesToGraph(stages.value, null);
  const triggerRule = triggerEnabled.value && trigger.value.field
    ? { field: trigger.value.field, op: trigger.value.op, value: triggerNoValue.value ? null : trigger.value.value }
    : null;
  return { name: flowName.value.trim() || '未命名审批流', definition: { nodes }, trigger_rule: triggerRule };
}

async function save(thenPublish) {
  saving.value = true;
  try {
    const payload = await buildPayload();
    const draft = await saveFlowDraft(formId, payload);
    draftId.value = draft.id;
    savedSnapshot = JSON.stringify(stages.value);
    dirty.value = false;
    if (!thenPublish) { toast.success('草稿已保存'); return; }

    if (!window.confirm(
      '发布后该流程立即对新提交生效。\n\n'
      + '· 已经在跑的单据仍按旧版流程走完，不会中途改道；\n'
      + '· 之后的新提交一律走新版。\n\n确认发布？',
    )) return;
    await publishFlow(draft.id);
    toast.success('流程已发布生效');
    await refreshPublished();
    router.replace(`/forms/${formId}/flow`);
  } catch (e) {
    if (e.status === 400 && e.data?.problems) {
      toast.error(e.data.message || '流程设计有问题');
      window.alert('请修正以下问题后再发布：\n\n' + e.data.problems.map((p, i) => `${i + 1}. ${p}`).join('\n'));
    } else {
      toast.error(e.message);
    }
  } finally {
    saving.value = false;
  }
}

async function unpublish() {
  if (!window.confirm('停用后新提交不再发起审批；在途单据仍会按当前版本走完。确认停用？')) return;
  try {
    await unpublishFlow(published.value.id);
    toast.success('生效流程已停用');
    published.value = null;
  } catch (e) { toast.error(e.message); }
}

async function refreshPublished() {
  const list = await fetchFlows(formId);
  published.value = list.find((f) => f.status === 'published') || null;
}

onMounted(async () => {
  try {
    const [f, design, allUsers] = await Promise.all([fetchForm(formId), fetchFlowDesign(formId), fetchUsers()]);
    form.value = f;
    users.value = allUsers;
    flowName.value = design.name || `${f.name}审批流`;
    draftId.value = design.id;
    if (design.trigger_rule) {
      triggerEnabled.value = true;
      trigger.value = { field: design.trigger_rule.field, op: design.trigger_rule.op, value: design.trigger_rule.value ?? '' };
    }
    loadStages(design.definition);
    await refreshPublished();
  } catch (e) {
    toast.error(e.message);
  } finally {
    loading.value = false;
  }
});
</script>
