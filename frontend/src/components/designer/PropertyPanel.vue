<template>
  <div>
    <div class="settings-group">
      <h4>基础</h4>
      <div class="sg-row">
        <span>字段名称</span>
        <input class="input" v-model="field.label" placeholder="给字段起个名字" />
      </div>
      <div class="sg-row">
        <span>字段标识</span>
        <input class="input" :value="field.key" disabled title="字段标识由系统生成，保存后不可修改" />
      </div>
      <div class="sg-row">
        <span>类型</span>
        <span class="tag">{{ FIELD_TYPES[field.type]?.label }}</span>
      </div>
      <label class="sg-row check">
        <span>必填 <span class="field-tip" style="margin:0">不填无法提交</span></span>
        <input type="checkbox" v-model="field.required" />
      </label>
      <label v-if="canUnique" class="sg-row check">
        <span>唯一 <span class="field-tip" style="margin:0">提交时查重，重复被拦</span></span>
        <input type="checkbox" v-model="field.unique" />
      </label>
      <div class="sg-row">
        <span>填写提示</span>
        <input class="input" v-model="field.tips" placeholder="输入框下方的浅灰提示" />
      </div>
    </div>

    <!-- 类型专属 -->
    <div v-if="field.type === 'text' || field.type === 'textarea'" class="settings-group">
      <h4>文本设置</h4>
      <div class="sg-row">
        <span>最大长度</span>
        <input class="input" type="number" min="1" v-model.number="field.maxLength" />
      </div>
      <div class="sg-row">
        <span>默认值</span>
        <input class="input" v-model="field.defaultValue" placeholder="无默认值可留空" />
      </div>
    </div>

    <div v-if="field.type === 'number'" class="settings-group">
      <h4>数字设置</h4>
      <div class="sg-row"><span>单位</span><input class="input" v-model="field.unit" placeholder="如：天 / 元 / 件" /></div>
      <div class="sg-row"><span>最小值</span><input class="input" type="number" v-model="field.min" placeholder="不限" /></div>
      <div class="sg-row"><span>最大值</span><input class="input" type="number" v-model="field.max" placeholder="不限" /></div>
      <div class="sg-row">
        <span>默认值</span>
        <input class="input" type="number" v-model="field.defaultValue" placeholder="无默认值可留空" />
      </div>
    </div>

    <div v-if="field.type === 'date'" class="settings-group">
      <h4>日期设置</h4>
      <div class="sg-row">
        <span>填写精度</span>
        <select class="select" v-model="field.datePrecision">
          <option value="day">精确到日（YYYY-MM-DD）</option>
          <option value="month">只填到月（YYYY-MM）</option>
        </select>
      </div>
      <div class="sg-row">
        <span>默认值</span>
        <input class="input" :type="field.datePrecision === 'month' ? 'month' : 'date'"
          v-model="field.defaultValue" />
      </div>
    </div>

    <div v-if="field.type === 'select' || field.type === 'multiselect'" class="settings-group">
      <h4>选项设置</h4>
      <div v-for="(o, i) in field.options" :key="i" class="option-row">
        <input class="input" v-model="o.label" placeholder="显示名" />
        <input class="input" v-model="o.value" placeholder="选项值" style="max-width:110px" />
        <button class="btn sm danger" @click="field.options.splice(i, 1)" :disabled="field.options.length <= 1">✕</button>
      </div>
      <button class="btn sm" @click="addOption" style="margin-top:4px">＋ 添加选项</button>
      <div class="sg-row" style="margin-top:10px" v-if="field.type === 'select'">
        <span>默认值</span>
        <select class="select" v-model="field.defaultValue">
          <option :value="null">无</option>
          <option v-for="o in validOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </div>
      <div class="field-tip">多选默认勾选请在画布预览中直接勾选，或保持空数组</div>
    </div>

    <div v-if="field.type === 'attachment'" class="settings-group">
      <h4>附件设置</h4>
      <div class="sg-row"><span>最多数量</span><input class="input" type="number" min="1" max="20" v-model.number="field.maxCount" /></div>
      <div class="sg-row"><span>文件类型</span><input class="input" v-model="field.accept" placeholder="如 image/* 或 .pdf（留空不限）" /></div>
    </div>

    <div v-if="field.type === 'subform'" class="settings-group">
      <h4>子字段（{{ field.children?.length || 0 }}）</h4>
      <div v-for="(c, i) in field.children" :key="c.key" class="option-row" style="grid-template-columns:1fr auto">
        <button class="input" style="text-align:left;cursor:pointer" @click="$emit('select-child', `${field.key}.${c.key}`)">
          {{ c.label }} <span class="tag muted" style="float:right">{{ FIELD_TYPES[c.type]?.label }}</span>
        </button>
        <span style="display:flex;gap:2px">
          <button class="btn sm" title="上移" @click="$emit('move-child', { path: `${field.key}.${c.key}`, dir: -1 })" :disabled="i === 0">↑</button>
          <button class="btn sm" title="下移" @click="$emit('move-child', { path: `${field.key}.${c.key}`, dir: 1 })" :disabled="i === field.children.length - 1">↓</button>
          <button class="btn sm danger" title="删除" @click="$emit('remove-child', `${field.key}.${c.key}`)">✕</button>
        </span>
      </div>
      <select class="select" v-model="childType" @change="onAddChild" style="margin-top:6px">
        <option value="">＋ 添加子字段…</option>
        <option v-for="t in childTypes" :key="t" :value="t">{{ FIELD_TYPES[t].label }}</option>
      </select>
    </div>

    <div class="settings-group">
      <h4>校验提示</h4>
      <textarea class="textarea" v-model="field.validateMessage"
        placeholder="校验不通过时展示给填写人的话，留空则使用系统默认提示（含字段名和范围）"></textarea>
      <div class="field-tip" style="margin-top:6px">
        对必填、超范围、非唯一、格式错误、选项无效等所有失败统一生效。
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { FIELD_TYPES } from '../../constants.js';

const props = defineProps({
  field: { type: Object, required: true },
});
const emit = defineEmits(['select-child', 'remove-child', 'move-child', 'add-child']);

const UNIQUEABLE = ['text', 'number', 'date', 'select'];
const canUnique = computed(() => UNIQUEABLE.includes(props.field.type));
const childTypes = ['text', 'textarea', 'number', 'date', 'select', 'multiselect'];
const childType = ref('');

const validOptions = computed(() => (props.field.options || []).filter((o) => o.label && o.value));
let optSeq = 0;
function addOption() {
  optSeq += 1;
  props.field.options.push({ label: `新选项 ${props.field.options.length + 1}`, value: `opt_new_${Date.now().toString(36)}_${optSeq}` });
}
function onAddChild(e) {
  const t = e.target.value;
  if (t) {
    // 冒泡到设计器：addChild(parentPath, type)
    emit('add-child', props.field.key, t);
  }
}
</script>
