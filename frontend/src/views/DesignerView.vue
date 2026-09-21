<template>
  <div>
    <!-- 手机端拦截：能填不能设计 -->
    <div class="mobile-block">
      <div style="font-size:48px">📱</div>
      <h3 style="margin:14px 0 8px">手机端仅支持填报</h3>
      <p style="color:var(--text-2)">表单设计需要更大的屏幕，请在桌面端（≥1024px）或平板横屏下进行设计。</p>
      <router-link class="btn primary" :to="`/forms/${formId}/fill`">前往预览填报 →</router-link>
    </div>

    <div v-if="form" class="designer">
      <!-- 左：字段库 -->
      <aside class="pane">
        <div style="padding:14px 14px 6px;font-weight:600;font-size:13px;color:var(--text-2)">字段库（点击/拖入）</div>
        <div
          v-for="t in TYPE_ORDER" :key="t"
          class="palette-item" draggable="true"
          @click="addField(t)"
          @dragstart="onPaletteDrag($event, t)">
          <span class="pi-icon">{{ FIELD_TYPES[t].icon }}</span>
          <span>{{ FIELD_TYPES[t].label }}</span>
        </div>
        <div style="padding:10px 16px;color:var(--text-3);font-size:12px;line-height:1.6">
          提示：拖动画布字段左侧 ⠿ 可排序；删除被流程/视图引用的字段会被拦截。
        </div>
      </aside>

      <!-- 中：画布 -->
      <main class="canvas-wrap" @dragover.prevent @drop="dropAt(null, $event)">
        <div class="canvas-form card card-pad" style="padding-bottom:24px">
          <input v-model="formName" class="input" style="font-size:18px;font-weight:600;border:none;padding:4px 0"
            placeholder="表单名称" />
          <input v-model="formDesc" class="input" style="border:none;padding:2px 0;color:var(--text-2);margin-bottom:14px"
            placeholder="表单说明（选填）" />

          <div v-if="!schema.length" class="empty" style="padding:36px 0"
            @dragover.prevent>
            从左侧点选或拖入字段，开始设计
          </div>

          <template v-for="(f, idx) in schema" :key="f.key">
            <div v-if="dragOverIdx === idx" class="drag-placeholder"></div>
            <div class="canvas-field" :class="{ selected: selected === f.key }"
              draggable="true"
              @click.stop="selected = f.key"
              @dragstart="onFieldDrag($event, f.key)"
              @dragover.stop.prevent="dragOverIdx = idx"
              @drop.stop="dropAt(idx, $event)">
              <div class="cf-toolbar">
                <span class="cf-btn move" title="拖动排序">⠿</span>
                <button class="cf-btn" title="复制" @click.stop="duplicateField(f.key)">⧉</button>
                <button class="cf-btn" title="删除" @click.stop="askRemove(f.key)">✕</button>
              </div>
              <CanvasField :field="f" :selected-path="selected" @select-child="selected = $event"
                @remove-child="(p) => askRemove(p)" @duplicate-child="duplicateField"
                @add-child="(p, t) => addChild(p, t)" />
            </div>
          </template>
          <div v-if="dragOverIdx === schema.length" class="drag-placeholder"></div>
        </div>

        <div class="designer-foot" style="position:static;max-width:680px;margin:12px auto 0;border:none;padding:0">
          <span style="flex:1;align-self:center;color:var(--text-3);font-size:12.5px">
            {{ dirty ? '● 有未保存的修改' : '已保存' }} · 共 {{ schema.length }} 个字段
          </span>
          <button class="btn" :disabled="saving" @click="save(false)">保存</button>
          <button class="btn primary" :disabled="saving" @click="save(true)">保存并预览填报 →</button>
        </div>
      </main>

      <!-- 右：属性设置 -->
      <aside class="pane right">
        <PropertyPanel v-if="selectedField" :key="selected" :field="selectedField"
          @add-child="addChild" @select-child="(p) => (selected = p)"
          @remove-child="(p) => askRemove(p)" @move-child="onMoveChild" />
        <div v-else style="padding:30px 18px;color:var(--text-3);font-size:13px;text-align:center">
          点击画布中的字段，在这里设置<br />必填、唯一、默认值、校验提示等
        </div>
      </aside>
    </div>

    <!-- 删除引用拦截弹窗 -->
    <div v-if="refModal.show" class="modal-mask">
      <div class="modal">
        <h3>⛔ 字段不能删除{{ refModal.fieldLabel ? `：「${refModal.fieldLabel}」` : '' }}</h3>
        <p style="color:var(--text-2);font-size:13.5px;margin:0">
          该字段正被以下流程或视图引用，请先解除引用后再删除：
        </p>
        <ul class="ref-list">
          <li v-for="(r, i) in refModal.references" :key="i">
            <span class="tag" :class="r.kind === '流程' ? 'warn' : ''">{{ r.kind }}</span>
            <span>{{ r.reason }}</span>
          </li>
        </ul>
        <div class="modal-foot">
          <button class="btn primary" @click="refModal.show = false">我知道了</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import CanvasField from '../components/designer/CanvasField.vue';
import PropertyPanel from '../components/designer/PropertyPanel.vue';
import { checkDeleteField, fetchForm, removeField, updateForm } from '../api.js';
import { FIELD_TYPES, TYPE_ORDER, childField, newFieldMeta } from '../constants.js';
import { cloneField } from '../schema-utils.js';
import { toast } from '../toast.js';

const route = useRoute();
const router = useRouter();
const formId = route.params.id;

const form = ref(null);
const formName = ref('');
const formDesc = ref('');
const schema = ref([]);
const savedSnapshot = ref(''); // 最近一次与服务端一致的 schema
const selected = ref('');
const saving = ref(false);
const dragOverIdx = ref(-1);
const refModal = reactive({ show: false, fieldLabel: '', references: [] });

const selectedField = computed(() => findByPath(schema.value, selected.value));
const dirty = computed(() => JSON.stringify(schema.value) !== savedSnapshot.value
  || formName.value !== form.value?.name || formDesc.value !== (form.value?.description || ''));

function findByPath(list, path) {
  if (!path) return null;
  const parts = path.split('.');
  let node = null;
  let cur = list;
  for (const p of parts) {
    node = cur.find((f) => f.key === p);
    if (!node) return null;
    cur = node.children || [];
  }
  return node;
}
function parentList(path) {
  const parts = path.split('.');
  let cur = schema.value;
  for (let i = 0; i < parts.length - 1; i++) {
    const n = cur.find((f) => f.key === parts[i]);
    if (!n) return null;
    cur = n.children;
  }
  return cur;
}
function uniqueKey(base) {
  const used = new Set();
  const walk = (fs) => fs.forEach((f) => { used.add(f.key); f.children && walk(f.children); });
  walk(schema.value);
  let k = base, i = 1;
  while (used.has(k)) k = `${base}_${++i}`;
  return k;
}

function addField(type) {
  const f = newFieldMeta(type);
  f.key = uniqueKey(f.key);
  schema.value.push(f);
  selected.value = f.key;
}
function addChild(parentPath, type) {
  const parent = findByPath(schema.value, parentPath);
  if (!parent) return;
  parent.children ||= [];
  const c = childField(type);
  c.key = uniqueKey(c.key);
  parent.children.push(c);
  selected.value = `${parentPath}.${c.key}`;
}
function moveChild(path, dir) {
  const childKey = path.split('.').pop();
  const list = parentList(path);
  const i = list.findIndex((f) => f.key === childKey);
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
}
// PropertyPanel 以 {path, dir} 对象形式上抛
function onMoveChild({ path, dir }) { moveChild(path, dir); }
function removeLocal(path) {
  const list = parentList(path);
  const key = path.split('.').pop();
  const i = list.findIndex((f) => f.key === key);
  if (i !== -1) list.splice(i, 1);
  if (selected.value === path || selected.value.startsWith(`${path}.`)) selected.value = '';
}
function duplicateField(path) {
  const list = parentList(path);
  const key = path.split('.').pop();
  const f = list.find((x) => x.key === key);
  if (!f) return;
  const copy = cloneField(f);
  const rekey = (node, depth = 0) => {
    node.key = uniqueKey(depth === 0 ? `${f.key}_copy` : node.key);
    node.label = `${node.label}副本`;
    (node.children || []).forEach((c) => rekey(c, depth + 1));
  };
  rekey(copy);
  list.splice(list.indexOf(f) + 1, 0, copy);
  selected.value = buildPath(list, copy.key);
}
function buildPath(list, key) {
  // 仅顶层复制需要；子项复制路径由调用处上下文拼接
  for (const f of schema.value) {
    if (f.key === key) return key;
    const hit = (f.children || []).find((c) => c.key === key);
    if (hit) return `${f.key}.${key}`;
  }
  return key;
}

async function askRemove(path) {
  const field = findByPath(schema.value, path);
  if (!field) return;
  // 未保存过的新字段：不可能被引用，直接本地删除
  const existedOnServer = !!findByPath(JSON.parse(savedSnapshot.value || '[]'), path);
  if (existedOnServer) {
    try {
      const res = await checkDeleteField(formId, path);
      if (res.blocked) {
        refModal.fieldLabel = res.fieldLabel;
        refModal.references = res.references;
        refModal.show = true;
        return;
      }
    } catch (e) {
      toast.error(e.message);
      return;
    }
  }
  if (!window.confirm(`确定删除字段「${field.label}」？其历史数据仍会保留在已提交记录中。`)) return;
  // 若还有其它未保存改动，只做本地删除（保存时服务端再统一校验引用）；否则直接走服务端删除
  if (!dirty.value && existedOnServer) {
    try {
      const r = await removeField(formId, path);
      schema.value = r.form.field_schema;
      savedSnapshot.value = JSON.stringify(schema.value);
      selected.value = '';
      toast.success('字段已删除');
      return;
    } catch (e) {
      if (e.status === 409) {
        refModal.fieldLabel = field.label;
        refModal.references = e.data.references || [];
        refModal.show = true;
        return;
      }
      throw e;
    }
  }
  removeLocal(path);
}

// ---- 拖拽：字段库新增 / 画布排序 ----
let dragPayload = null;
function onPaletteDrag(e, type) {
  dragPayload = { kind: 'new', type };
  e.dataTransfer.effectAllowed = 'copy';
}
function onFieldDrag(e, path) {
  dragPayload = { kind: 'move', path };
  e.dataTransfer.effectAllowed = 'move';
}
function dropAt(targetIdx, e) {
  e.preventDefault();
  dragOverIdx.value = -1;
  if (!dragPayload || targetIdx === null) {
    if (dragPayload?.kind === 'new') addField(dragPayload.type);
    dragPayload = null;
    return;
  }
  if (dragPayload.kind === 'new') {
    const f = newFieldMeta(dragPayload.type);
    f.key = uniqueKey(f.key);
    schema.value.splice(targetIdx, 0, f);
    selected.value = f.key;
  } else {
    const list = parentList(dragPayload.path);
    if (list !== schema.value) { dragPayload = null; return; } // 仅顶层支持拖拽排序
    const key = dragPayload.path;
    const from = schema.value.findIndex((f) => f.key === key);
    if (from === -1 || from === targetIdx) { dragPayload = null; return; }
    const [moved] = schema.value.splice(from, 1);
    schema.value.splice(targetIdx > from ? targetIdx - 1 : targetIdx, 0, moved);
  }
  dragPayload = null;
}

async function save(thenPreview) {
  saving.value = true;
  try {
    const updated = await updateForm(formId, {
      name: formName.value.trim() || '未命名表单',
      description: formDesc.value,
      field_schema: schema.value,
    });
    schema.value = updated.field_schema;
    savedSnapshot.value = JSON.stringify(schema.value);
    formName.value = updated.name;
    formDesc.value = updated.description || '';
    toast.success('已保存');
    if (thenPreview) router.push(`/forms/${formId}/fill`);
  } catch (e) {
    if (e.status === 409 && e.data?.references) {
      refModal.fieldLabel = '';
      refModal.references = e.data.references;
      refModal.show = true;
    } else {
      toast.error(e.message);
    }
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  try {
    const f = await fetchForm(formId);
    form.value = f;
    formName.value = f.name;
    formDesc.value = f.description || '';
    schema.value = f.field_schema || [];
    savedSnapshot.value = JSON.stringify(schema.value);
    if (schema.value.length) selected.value = schema.value[0].key;
  } catch (e) {
    toast.error(e.message);
  }
});

// 离开页面前提醒未保存
window.addEventListener('beforeunload', (e) => {
  if (dirty.value) { e.preventDefault(); e.returnValue = ''; }
});
</script>
