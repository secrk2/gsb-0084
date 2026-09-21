<template>
  <div class="page" style="max-width:820px">
    <div v-if="loading" class="spinner"></div>
    <template v-else-if="submission">
      <div class="page-head">
        <div>
          <router-link :to="instanceId ? `/instances/${instanceId}` : '/approvals'" style="font-size:13px">← 返回</router-link>
          <h2 class="page-title" style="margin-top:6px">
            ✏️ 修改退回单据
            <span class="tag danger" style="margin-left:8px;vertical-align:middle">已退回 · 第 {{ round }} 轮</span>
          </h2>
          <div class="page-sub">{{ form.name }} #{{ submission.id }} · 修改后重新提交，将从第一个审批节点重新走</div>
        </div>
      </div>

      <div class="card card-pad" style="border-left:3px solid var(--danger);margin-bottom:14px">
        <strong>退回意见：</strong>{{ returnComment || '（退回人未填写意见）' }}
      </div>

      <div v-if="submitError" class="card" style="border-color:var(--danger);margin-bottom:14px;background:var(--danger-soft)">
        <div style="padding:12px 16px;font-size:13.5px;color:var(--danger)">
          ⚠ {{ submitError }}
          <span v-if="errors.length" style="display:block;margin-top:4px;color:var(--text-2)">
            共 {{ errors.length }} 处问题，已在对应字段下方标出。
          </span>
        </div>
      </div>

      <div class="card card-pad">
        <DynamicForm :schema="form.field_schema" v-model="formData" :errors="errors" />
        <div class="submit-bar">
          <router-link class="btn" :to="instanceId ? `/instances/${instanceId}` : '/approvals'">取消</router-link>
          <button class="btn primary" :disabled="submitting" @click="submit">
            {{ submitting ? '提交中…' : '改完了，重新提交' }}
          </button>
        </div>
      </div>

      <div class="card card-pad" style="margin-top:14px">
        <div class="page-sub" style="margin-bottom:6px">本次改动会逐字段留痕（改前 → 改后），审批人可在详情页对照查看。</div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import DynamicForm from '../components/DynamicForm.vue';
import { fetchSubmission, fetchForm, fetchInstance, resubmitForm } from '../api.js';
import { applyDefaultsClient } from '../schema-utils.js';
import { auth } from '../auth.js';
import { toast } from '../toast.js';

const route = useRoute();
const router = useRouter();
const id = route.params.id;

const loading = ref(true);
const submitting = ref(false);
const submission = ref(null);
const form = ref(null);
const formData = ref({});
const errors = ref([]);
const submitError = ref('');
const instanceId = ref(null);
const returnComment = ref('');
const round = ref(1);

async function submit() {
  submitting.value = true;
  errors.value = [];
  submitError.value = '';
  try {
    await resubmitForm(id, formData.value, auth.user.id);
    toast.success('已重新提交，审批从头开始');
    router.push(instanceId.value ? `/instances/${instanceId.value}` : '/approvals');
  } catch (e) {
    if (e.status === 422) {
      submitError.value = e.data?.message || '提交内容未通过校验';
      errors.value = e.data?.errors || [];
      setTimeout(() => document.querySelector('.field.invalid')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
    } else {
      toast.error(e.message);
    }
  } finally {
    submitting.value = false;
  }
}

onMounted(async () => {
  try {
    submission.value = await fetchSubmission(id);
    if (submission.value.status !== 'returned') {
      toast.error('该单据不在退回状态，不能修改重提');
      router.replace(submission.value.instance_id ? `/instances/${submission.value.instance_id}` : '/instances');
      return;
    }
    instanceId.value = submission.value.instance_id;
    form.value = await fetchForm(submission.value.form_id);
    formData.value = applyDefaultsClient(form.value.field_schema, submission.value.data);
    if (instanceId.value) {
      const inst = await fetchInstance(instanceId.value);
      returnComment.value = inst.return_comment || '';
      round.value = inst.round;
    }
  } catch (e) {
    toast.error(e.message);
  } finally {
    loading.value = false;
  }
});
</script>
