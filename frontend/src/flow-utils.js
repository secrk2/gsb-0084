// 流程前端工具：状态文案、停留时长、节点图 ⇄ 设计器「主干+分支」结构互转、字段值展示
import { OPS } from './flow-ops.js';

export const INST_STATUS = {
  running: { label: '审批中', cls: 'warn' },
  approved: { label: '已通过', cls: 'ok' },
  returned: { label: '已退回', cls: 'danger' },
};
export const SUB_STATUS = {
  submitted: { label: '已提交', cls: 'muted' },
  running: { label: '审批中', cls: 'warn' },
  approved: { label: '已通过', cls: 'ok' },
  returned: { label: '已退回', cls: 'danger' },
};
export const TASK_STATUS = {
  pending: { label: '待处理', cls: 'warn' },
  approved: { label: '已通过', cls: 'ok' },
  returned: { label: '退回', cls: 'danger' },
  cancelled: { label: '已失效', cls: 'muted' },
};
export const EVENT_LABEL = {
  start: '发起流程',
  approve: '审批通过',
  return: '退回发起人',
  resubmit: '修改后重新提交',
  auto_pass: '自动通过',
  route: '条件分支选路',
  finish: '流程完成',
};

/** 秒数 → “已停留 2 天 3 小时 / 25 分钟” */
export function duration(sec) {
  if (sec === null || sec === undefined) return '—';
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分钟`;
  return '不到 1 分钟';
}

export function fmtTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function opLabel(op) {
  return OPS.find((o) => o.value === op)?.label || op;
}

// ---------- 字段值展示（与后端 diff 的展示口径接近） ----------

export function fieldByKey(schema, key) {
  const root = String(key || '').split('.')[0];
  const find = (list) => {
    for (const f of list) {
      if (f.key === root) return f;
      if (f.children) {
        const hit = find(f.children);
        if (hit) return hit;
      }
    }
    return null;
  };
  return find(schema || []);
}

export function formatFieldValue(field, v) {
  if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) return '（空）';
  if (!field) return typeof v === 'object' ? JSON.stringify(v) : String(v);
  switch (field.type) {
    case 'select':
      return field.options?.find((o) => String(o.value) === String(v))?.label || String(v);
    case 'multiselect':
      return (v || []).map((x) => field.options?.find((o) => String(o.value) === String(x))?.label || x).join('、');
    case 'number':
      return field.unit ? `${v} ${field.unit}` : String(v);
    case 'attachment':
      return Array.isArray(v) && v.length ? `${v.length} 个附件` : '（空）';
    default:
      return String(v);
  }
}

// ---------- 设计器结构：stages（主干） ⇄ graph（节点图） ----------
// stages: [{kind:'approval', name, mode, approvers:[{type,value}]},
//          {kind:'condition', name, branches:[{label, logic, conditions:[{field,op,value}], stages:[...]}], defaultStages:[...]}]

let seq = 0;
const nid = (prefix) => `${prefix}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

export function emptyStages() {
  return [{
    kind: 'approval', key: nid('n'), name: '审批节点', mode: 'all',
    approvers: [{ type: 'user', value: '' }],
  }];
}

export function emptyBranch() {
  return {
    label: '新分支', logic: 'and',
    conditions: [{ field: '', op: 'gt', value: '' }],
    stages: [{ kind: 'approval', key: nid('n'), name: '审批节点', mode: 'all', approvers: [{ type: 'user', value: '' }] }],
  };
}

/** 设计器结构 → 后端节点图 */
export function stagesToGraph(stages, triggerRule) {
  const nodes = [
    { key: 'start', type: 'start', next: 'end' },
    { key: 'end', type: 'end' },
  ];

  function compileApproval(stage, nextKey) {
    const key = stage.key || nid('n');
    nodes.push({
      key, type: 'approval', name: stage.name, mode: stage.mode || 'all',
      approvers: (stage.approvers || []).filter((a) => a.value), next: nextKey,
    });
    return key;
  }

  // 返回该序列第一个节点的 key（空序列返回 exitKey）
  function compile(list, exitKey) {
    let cont = exitKey;
    for (let i = list.length - 1; i >= 0; i--) {
      const st = list[i];
      if (st.kind === 'approval') {
        cont = compileApproval(st, cont);
      } else {
        const key = st.key || nid('c');
        const branches = (st.branches || []).map((b) => ({
          label: b.label, logic: b.logic || 'and',
          conditions: b.conditions,
          next: compile(b.stages || [], cont),
        }));
        nodes.push({
          key, type: 'condition', name: st.name,
          branches, defaultNext: compile(st.defaultStages || [], cont),
        });
        cont = key;
      }
    }
    return cont;
  }

  const firstKey = compile(stages, 'end');
  nodes[0].next = firstKey || 'end';
  return { nodes, trigger_rule: triggerRule || null };
}

/**
 * 后端节点图 → 设计器结构。仅支持「主干串行 + 条件分支后汇合」的规范形状
 * （本平台设计器产出的均为此形状）；遇到自由连线返回 null，由调用方提示。
 */
export function graphToStages(def) {
  const nodes = def?.nodes || [];
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const start = nodes.find((n) => n.type === 'start');
  const end = nodes.find((n) => n.type === 'end');
  if (!start || !end) return null;

  const indeg = new Map(nodes.map((n) => [n.key, 0]));
  const bump = (k) => { if (k) indeg.set(k, (indeg.get(k) || 0) + 1); };
  for (const n of nodes) {
    if (n.type === 'start' || n.type === 'approval') bump(n.next);
    if (n.type === 'condition') {
      (n.branches || []).forEach((b) => bump(b.next));
      if (n.defaultNext) bump(n.defaultNext);
    }
  }

  function approvalStage(n) {
    return {
      kind: 'approval', key: n.key, name: n.name, mode: n.mode || 'all',
      approvers: (n.approvers || []).map((a) => ({ ...a })),
    };
  }

  // 从 key 沿审批链收集，直到汇合点 stopKey；路径上只允许 approval 节点
  function collectChain(key, stopKey) {
    const out = [];
    let cur = key;
    while (cur !== stopKey) {
      const n = byKey.get(cur);
      if (!n || n.type !== 'approval') return null;
      out.push(approvalStage(n));
      cur = n.next;
    }
    return out;
  }

  function parseLinear(key) {
    const stages = [];
    let cur = key;
    const guard = new Set();
    while (cur && byKey.has(cur)) {
      if (guard.has(cur)) return null;
      guard.add(cur);
      const n = byKey.get(cur);
      if (n.type === 'end') break;
      if (n.type === 'approval') {
        stages.push(approvalStage(n));
        cur = n.next;
      } else if (n.type === 'condition') {
        // 汇合点：沿第一条出边走，直到 end 或入度 >1 的节点
        const anyNext = n.branches?.[0]?.next || n.defaultNext;
        let merge = null;
        let p = anyNext;
        const seen = new Set();
        while (p && byKey.has(p) && !seen.has(p)) {
          seen.add(p);
          const pn = byKey.get(p);
          if (pn.type === 'end' || (indeg.get(p) || 0) > 1) { merge = p; break; }
          p = pn.next;
        }
        if (!merge) return null;

        const branches = [];
        for (const b of (n.branches || [])) {
          const chainStages = collectChain(b.next, merge);
          if (!chainStages) return null;
          branches.push({
            label: b.label, logic: b.logic || 'and',
            conditions: (b.conditions || []).map((c) => ({ ...c })),
            stages: chainStages,
          });
        }
        let defaultStages = [];
        if (n.defaultNext && n.defaultNext !== merge) {
          const chainStages = collectChain(n.defaultNext, merge);
          if (!chainStages) return null;
          defaultStages = chainStages;
        }
        stages.push({ kind: 'condition', key: n.key, name: n.name, branches, defaultStages });
        cur = merge; // end 或汇合后的审批节点，交回 while 继续
      } else {
        return null;
      }
    }
    return stages;
  }

  return parseLinear(start.next);
}
