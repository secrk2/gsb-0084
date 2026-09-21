<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">应用动态</h2>
        <div class="page-sub">全平台搭建与填报情况一览</div>
      </div>
      <button class="btn" @click="load">↻ 刷新</button>
    </div>

    <div v-if="loading" class="spinner"></div>
    <template v-else-if="ov">
      <!-- KPI -->
      <div class="kpi-grid">
        <div class="card kpi">
          <div class="name">🧩 应用数</div>
          <div class="val">{{ ov.app_count }}</div>
          <div class="delta">已搭建的业务应用</div>
        </div>
        <div class="card kpi">
          <div class="name">📋 表单数</div>
          <div class="val">{{ ov.form_count }}</div>
          <div class="delta">在线动态表单</div>
        </div>
        <div class="card kpi">
          <div class="name">📥 今日提交量</div>
          <div class="val" style="color:var(--brand)">{{ ov.today_submission_count }}</div>
          <div class="delta">累计提交 {{ ov.submission_count }} 条</div>
        </div>
        <div class="card kpi">
          <div class="name">⚠️ 今日校验失败</div>
          <div class="val" :style="{ color: ov.today_error_count ? 'var(--danger)' : 'var(--success)' }">
            {{ ov.today_error_count }}
          </div>
          <div class="delta">未通过即被拦截，未入库</div>
        </div>
      </div>

      <div class="two-col">
        <!-- 校验失败热点字段 -->
        <div class="card card-pad">
          <h3 style="margin-bottom:4px">校验失败集中字段 <span class="tag danger" style="margin-left:6px">近 7 天</span></h3>
          <div class="page-sub" style="margin-bottom:14px">条形越长，说明用户越常在这个字段填错，应优化提示或放宽规则</div>
          <div v-if="!ov.fieldHotspots.length" class="empty">近 7 天没有校验失败</div>
          <div v-for="(h, i) in ov.fieldHotspots" :key="h.form_id + h.field_key" class="bar-row">
            <div class="bar-name" :title="`${h.form_name} · ${h.field_label}`">
              <span class="tag muted" style="margin-right:4px">{{ shortForm(h.form_name) }}</span>{{ h.field_label }}
            </div>
            <div class="bar-track"><div class="bar-fill" :class="{ hot: i < 3 }" :style="{ width: barW(h.error_count) }"></div></div>
            <div class="bar-count">{{ h.error_count }}</div>
          </div>
        </div>

        <div style="display:flex;flex-direction:column;gap:16px">
          <!-- 7 日趋势 -->
          <div class="card card-pad">
            <h3 style="margin-bottom:10px">近 7 天提交趋势</h3>
            <div class="trend-bars">
              <div v-for="t in ov.trend" :key="t.label" class="trend-col" :title="`提交 ${t.submission_count}，失败 ${t.error_count}`">
                <div class="trend-num">{{ t.submission_count }}</div>
                <div class="trend-stack" :style="{ height: trendH(t) }">
                  <div v-if="t.error_count" class="trend-sub" :style="{ height: segH(t, 'err') }" title="校验失败"></div>
                  <div class="trend-ok" :style="{ height: segH(t, 'ok'), borderTop: t.error_count ? '2px solid #fff' : 'none' }"></div>
                </div>
                <div class="trend-label">{{ t.label }}</div>
              </div>
            </div>
            <div style="display:flex;gap:14px;margin-top:10px;font-size:12px;color:var(--text-2)">
              <span><i style="display:inline-block;width:10px;height:10px;background:var(--brand);border-radius:2px;margin-right:4px"></i>提交量</span>
              <span><i style="display:inline-block;width:10px;height:10px;background:#ffd5d6;border-radius:2px;margin-right:4px"></i>校验失败 {{ weekErrorTotal }} 次</span>
            </div>
          </div>

          <!-- 各应用今日 -->
          <div class="card card-pad">
            <h3 style="margin-bottom:10px">各应用今日提交</h3>
            <div v-for="a in ov.perAppToday" :key="a.id" class="bar-row">
              <div class="bar-name">{{ a.name }}</div>
              <div class="bar-track"><div class="bar-fill" :style="{ width: perAppW(a.today_count) }"></div></div>
              <div class="bar-count" style="color:var(--brand)">{{ a.today_count }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 最近提交 -->
      <div class="card" style="margin-top:16px">
        <div style="padding:16px 20px 0"><h3>最近提交</h3></div>
        <div style="overflow-x:auto">
          <table class="list-table">
            <thead><tr><th>#</th><th>应用</th><th>表单</th><th>摘要</th><th>提交时间</th></tr></thead>
            <tbody>
              <tr v-for="r in recent" :key="r.id">
                <td>{{ r.id }}</td>
                <td>{{ r.app_name }}</td>
                <td><span class="tag">{{ r.form_name }}</span></td>
                <td style="max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-2)">
                  {{ summarize(r.data) }}
                </td>
                <td style="white-space:nowrap;color:var(--text-2)">{{ fmtTime(r.created_at) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { fetchOverview, fetchRecent } from '../api.js';
import { toast } from '../toast.js';

const ov = ref(null);
const recent = ref([]);
const loading = ref(true);

const maxErr = computed(() => Math.max(1, ...(ov.value?.fieldHotspots || []).map((h) => h.error_count)));
const maxTrend = computed(() => Math.max(1, ...(ov.value?.trend || []).map((t) => t.submission_count + (t.error_count || 0))));
const maxApp = computed(() => Math.max(1, ...(ov.value?.perAppToday || []).map((a) => a.today_count)));
const weekErrorTotal = computed(() => (ov.value?.trend || []).reduce((s, t) => s + (t.error_count || 0), 0));

function barW(n) { return `${Math.max(4, (n / maxErr.value) * 100)}%`; }
function trendH(t) {
  const total = t.submission_count + (t.error_count || 0);
  return `${Math.max(3, (total / maxTrend.value) * 110)}px`;
}
function segH(t, kind) {
  const total = t.submission_count + (t.error_count || 0) || 1;
  const pct = kind === 'err' ? (t.error_count / total) * 100 : (t.submission_count / total) * 100;
  return `${pct}%`;
}
function perAppW(n) { return `${Math.max(3, (n / maxApp.value) * 100)}%`; }
function shortForm(name) { return name.length > 4 ? name.slice(0, 4) : name; }

function summarize(data) {
  const vals = Object.entries(data || {})
    .filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => (Array.isArray(v) ? `[${v.length}项]` : String(v)))
    .filter((s) => s && !s.startsWith('f_'))
    .slice(0, 3);
  return vals.join(' · ') || '—';
}
function fmtTime(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function load() {
  loading.value = true;
  try {
    const [o, r] = await Promise.all([fetchOverview(), fetchRecent()]);
    ov.value = o;
    recent.value = r;
  } catch (e) {
    toast.error(e.message);
  } finally {
    loading.value = false;
  }
}
onMounted(load);
</script>
