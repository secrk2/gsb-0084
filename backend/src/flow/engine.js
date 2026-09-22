// 审批流引擎：纯逻辑，不碰数据库，便于单测。
//
// ── 流程定义 definition 结构 ─────────────────────────────────────────────
// 阶段数组，自上而下执行。阶段有两种：
//
// 1) 审批阶段 { kind: 'approval', node: <审批节点> }
// 2) 条件分支阶段 { kind: 'branch', branches: [ { label, when:{field,op,value}, nodes:[<审批节点>...] }, ... ] }
//    自上而下取第一个满足 when 的分支；都不满足且存在 default 分支（when 为 null）则走它；
//    若没有可命中的分支，该阶段整体跳过（视为自动通过）。
//
// 审批节点：
// {
//   id: 'n_xxx',
//   name: '部门主管审批',
//   mode: 'serial' | 'countersign',   // serial=串行逐个；countersign=并行会签，全员通过
//   approver_type: 'fixed' | 'field', // fixed=指定人员；field=取表单某字段值作为审批人
//   approvers: ['u_zhangsan'],         // fixed：人员 id 数组（serial 按此顺序）
//   field: 'f_dept'                    // field：表单字段 key（select/multiselect/text 均可）
// }
//
// 会签口径：节点内所有审批人都通过，节点才算通过；任一人退回/驳回，整批 pending 任务作废。
// 串行口径：按 approvers 顺序一次只生成一个任务，通过后生成下一个。
//
// ── 退回口径 ────────────────────────────────────────────────────────────
// 退回发起人(return_initiator)：实例 current_stage=-1，单据 status=returned，
//   发起人可改单后重新提交；重提视为「重新走一遍」：清空原任务，从第一个阶段重新判定条件。
//   每次重提落一条 revision 快照 + 字段级 diff，时间线全程可见。
// 退回上一节点(return_previous)：不终止流程，激活「上一个实际产生过审批任务的节点」，
//   原当前批次任务作废；上节点通过后继续向下。第一个审批节点没有更上游，只能退回发起人。

export const OPS = [
  { value: 'eq', label: '等于' },
  { value: 'ne', label: '不等于' },
  { value: 'gt', label: '大于' },
  { value: 'gte', label: '大于等于' },
  { value: 'lt', label: '小于' },
  { value: 'lte', label: '小于等于' },
  { value: 'in', label: '属于' },
  { value: 'not_in', label: '不属于' },
  { value: 'empty', label: '为空' },
  { value: 'not_empty', label: '不为空' },
];

export function newNodeId() {
  return `n_${Math.random().toString(36).slice(2, 9)}`;
}

/** 新建一个审批节点的默认结构 */
export function newApprovalNode(partial = {}) {
  return {
    id: newNodeId(),
    name: '审批节点',
    mode: 'serial',
    approver_type: 'fixed',
    approvers: [],
    field: null,
    ...partial,
  };
}

/** 新建条件分支阶段：一个条件分支 + 一个默认分支 */
export function newBranchStage() {
  return {
    kind: 'branch',
    branches: [
      {
        label: '条件一',
        when: { field: null, op: 'gt', value: '' },
        nodes: [newApprovalNode({ name: '审批节点' })],
      },
      { label: '其他情况', when: null, nodes: [] },
    ],
  };
}

// ---------- 定义校验（保存/发布前调用） ----------

/**
 * 校验流程定义，同时借助表单字段元数据检查条件字段/字段审批人是否存在。
 * @param {{strict?: boolean}} [opts] strict=true（发布前）审批人/条件值/节点名必须完整；
 *   strict=false（保存草稿）只查结构与字段引用，允许半成品
 * @returns {string[]} 中文问题列表；空数组 = 合法
 */
export function validateDefinition(definition, fieldSchema = [], opts = { strict: true }) {
  const strict = opts.strict !== false;
  const problems = [];
  if (!Array.isArray(definition)) return ['流程定义必须是阶段数组'];

  const fieldMap = new Map();
  const walk = (fields) => {
    for (const f of fields || []) {
      fieldMap.set(f.key, f);
      if (f.children?.length) walk(f.children);
    }
  };
  walk(fieldSchema);

  const nodeIds = new Set();
  function checkNode(node, where) {
    if (!node?.id) { problems.push(`${where}：节点缺少 id`); return; }
    if (nodeIds.has(node.id)) problems.push(`节点 id「${node.id}」重复`);
    nodeIds.add(node.id);
    if (strict && !node.name?.trim()) problems.push(`${where}：节点未命名`);
    if (!['serial', 'countersign'].includes(node.mode)) {
      problems.push(`节点「${node.name || node.id}」的审批方式无效`);
    }
    if (node.approver_type === 'fixed') {
      if (strict && (!Array.isArray(node.approvers) || !node.approvers.filter(Boolean).length)) {
        problems.push(`节点「${node.name || node.id}」未指定审批人`);
      }
    } else if (node.approver_type === 'field') {
      if (!node.field) {
        if (strict) problems.push(`节点「${node.name || node.id}」未选择取审批人的表单字段`);
      } else if (!fieldMap.has(node.field)) {
        problems.push(`节点「${node.name || node.id}」引用的字段「${node.field}」已不存在`);
      }
    } else {
      problems.push(`节点「${node.name || node.id}」的审批人类型无效`);
    }
  }

  definition.forEach((stage, si) => {
    const where = `第 ${si + 1} 个阶段`;
    if (!stage || (stage.kind !== 'approval' && stage.kind !== 'branch')) {
      problems.push(`${where}：阶段类型无效`);
      return;
    }
    if (stage.kind === 'approval') {
      checkNode(stage.node, where);
    } else {
      if (!Array.isArray(stage.branches) || stage.branches.length < 1) {
        problems.push(`${where}：至少要有一个分支`);
        return;
      }
      let hasDefault = false;
      stage.branches.forEach((b, bi) => {
        if (!b.when) { hasDefault = true; }
        else {
          if (strict && !b.when.field) problems.push(`${where} 分支「${b.label || bi + 1}」未选择条件字段`);
          else if (b.when.field && !fieldMap.has(b.when.field)) {
            problems.push(`${where} 分支「${b.label || bi + 1}」的条件字段「${b.when.field}」已不存在`);
          }
          if (!OPS.some((o) => o.value === b.when.op)) {
            problems.push(`${where} 分支「${b.label || bi + 1}」的比较方式无效`);
          }
          if (strict && ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in'].includes(b.when.op)
              && (b.when.value === '' || b.when.value === null || b.when.value === undefined)) {
            problems.push(`${where} 分支「${b.label || bi + 1}」的条件值未填写`);
          }
        }
        if (!Array.isArray(b.nodes)) {
          problems.push(`${where} 分支「${b.label || bi + 1}」的节点必须是数组`);
        } else {
          b.nodes.forEach((n) => checkNode(n, `${where} 分支「${b.label || bi + 1}」`));
        }
      });
      if (!hasDefault && stage.branches.length) {
        // 没有默认分支不算错误（条件都不命中时整段跳过），但给设计器提示由前端负责
      }
    }
  });
  return problems;
}

/** 收集定义里引用到的全部表单字段 key（条件字段 + 字段审批人） */
export function collectDefinitionFields(definition) {
  const keys = new Set();
  for (const stage of definition || []) {
    if (stage.kind === 'approval') {
      if (stage.node?.approver_type === 'field' && stage.node.field) keys.add(stage.node.field);
    } else if (stage.kind === 'branch') {
      for (const b of stage.branches || []) {
        if (b.when?.field) keys.add(b.when.field);
      }
    }
  }
  return keys;
}

// ---------- 条件求值 ----------

function toNum(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined || v === '') return [];
  return [v];
}

/** 按点路径取单据数据（子表单字段按行求值；多选等数组字段整体返回） */
export function getDataValue(data, path) {
  const parts = String(path || '').split('.');
  let cur = data;
  for (let i = 0; i < parts.length; i++) {
    if (cur === null || cur === undefined) return null;
    cur = cur[parts[i]];
    // 进入子表：仅当还有后续路径时，才把数组当作行集合逐行求值
    if (Array.isArray(cur) && i < parts.length - 1) {
      const rest = parts.slice(i + 1);
      const vals = cur.map((row) => getDataValue(row, rest.join('.'))).filter(
        (v) => v !== null && v !== undefined && v !== '',
      );
      return vals.length ? vals[0] : null;
    }
  }
  return cur === undefined ? null : cur;
}

/**
 * 单个条件求值。in/not_in 的 value 支持逗号分隔多值或数组。
 */
export function evalCondition(when, data) {
  if (!when?.field) return false;
  const actual = getDataValue(data, when.field);
  const op = when.op;
  if (op === 'empty') return actual === null || actual === undefined || actual === ''
    || (Array.isArray(actual) && actual.length === 0);
  if (op === 'not_empty') return !(actual === null || actual === undefined || actual === ''
    || (Array.isArray(actual) && actual.length === 0));

  const wanted = Array.isArray(when.value) ? when.value : when.value;
  if (op === 'in' || op === 'not_in') {
    const set = new Set(asArray(typeof wanted === 'string' ? wanted.split(',').map((s) => s.trim()).filter(Boolean) : wanted));
    const hit = asArray(actual).some((v) => set.has(String(v)));
    return op === 'in' ? hit : !hit;
  }
  if (op === 'eq' || op === 'ne') {
    const eq = String(actual ?? '') === String(wanted ?? '');
    return op === 'eq' ? eq : !eq;
  }
  // 数值比较；数字无法解析时退化为定宽字符串比较（支持 YYYY-MM / YYYY-MM-DD 日期）
  const a = toNum(actual);
  const b = toNum(wanted);
  if (!Number.isNaN(a) && !Number.isNaN(b)) {
    if (op === 'gt') return a > b;
    if (op === 'gte') return a >= b;
    if (op === 'lt') return a < b;
    if (op === 'lte') return a <= b;
    return false;
  }
  const sa = String(actual ?? '');
  const sb = String(wanted ?? '');
  // 仅对定宽 ISO 日期（YYYY-MM / YYYY-MM-DD）退化为字典序比较；普通文本不做大小比较
  const dateRe = /^\d{4}-\d{2}(-\d{2})?$/;
  if (dateRe.test(sa) && dateRe.test(sb)) {
    if (op === 'gt') return sa > sb;
    if (op === 'gte') return sa >= sb;
    if (op === 'lt') return sa < sb;
    if (op === 'lte') return sa <= sb;
  }
  return false;
}

/**
 * 条件分支阶段选路：返回命中分支下标；都不命中返回 -1（含默认分支 when=null 时命中默认分支）。
 */
export function pickBranch(stage, data) {
  let defaultIdx = -1;
  stage.branches.forEach((b, i) => {
    if (!b.when) defaultIdx = i;
  });
  for (let i = 0; i < stage.branches.length; i++) {
    const b = stage.branches[i];
    if (b.when && evalCondition(b.when, data)) return i;
  }
  return defaultIdx;
}

// ---------- 审批人解析 ----------

/**
 * 把节点解析为具体审批人 id 列表（按顺序）。field 类型从单据数据取值：
 * 标量 → 单人；数组（multiselect）→ 多人。取不到人返回空数组（运行时该节点直接判错）。
 */
export function resolveApprovers(node, data) {
  if (node.approver_type === 'fixed') {
    return [...(node.approvers || [])].filter(Boolean);
  }
  if (node.approver_type === 'field') {
    const v = getDataValue(data, node.field);
    if (Array.isArray(v)) return v.filter((x) => x !== null && x !== '').map(String);
    if (v === null || v === undefined || v === '') return [];
    return [String(v)];
  }
  return [];
}

/**
 * 展开流程定义在给定数据下的实际执行路径（用于启动/重走）。
 * 返回 [{stage_idx, branch_idx|null, node}]，仅包含会实际执行的节点。
 */
export function expandPath(definition, data) {
  const path = [];
  definition.forEach((stage, stageIdx) => {
    if (stage.kind === 'approval') {
      path.push({ stage_idx: stageIdx, branch_idx: null, node: stage.node });
    } else {
      const bi = pickBranch(stage, data);
      if (bi >= 0) {
        for (const node of stage.branches[bi].nodes || []) {
          path.push({ stage_idx: stageIdx, branch_idx: bi, node });
        }
      }
    }
  });
  return path;
}

// ---------- 改单 diff ----------

function isPlainObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function displayVal(v) {
  if (v === null || v === undefined) return '（空）';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * 计算两版单据数据的字段级差异，借助表单 schema 补字段中文名。
 * 顶层标量字段逐字段比；子表单按行展开（第 N 行 / 子字段），增删行也报。
 * @returns {Array<{path:string,label:string,before:string,after:string,kind:string}>}
 */
export function diffData(before, after, fieldSchema = []) {
  const changes = [];
  const labelOf = new Map();
  const walk = (fields, prefix = '') => {
    for (const f of fields || []) {
      labelOf.set(prefix ? `${prefix}.${f.key}` : f.key, f.label);
      if (f.children?.length) walk(f.children, prefix ? `${prefix}.${f.key}` : f.key);
    }
  };
  walk(fieldSchema);
  const label = (path, fallback) => labelOf.get(path) || fallback || path;

  const b = before || {};
  const a = after || {};
  for (const field of fieldSchema || []) {
    const key = field.key;
    const bv = b[key];
    const av = a[key];
    if (field.type === 'subform') {
      const brow = Array.isArray(bv) ? bv : [];
      const arow = Array.isArray(av) ? av : [];
      const n = Math.max(brow.length, arow.length);
      for (let i = 0; i < n; i++) {
        const rowB = brow[i];
        const rowA = arow[i];
        if (!rowB && rowA) {
          changes.push({ path: `${key}[${i}]`, label: `${field.label} 第 ${i + 1} 行`, kind: 'row_added', before: '（无）', after: '（新增一行）' });
          continue;
        }
        if (rowB && !rowA) {
          changes.push({ path: `${key}[${i}]`, label: `${field.label} 第 ${i + 1} 行`, kind: 'row_removed', before: '（一行）', after: '（已删除）' });
          continue;
        }
        for (const child of field.children || []) {
          const cvB = rowB[child.key];
          const cvA = rowA[child.key];
          if (JSON.stringify(cvB ?? null) !== JSON.stringify(cvA ?? null)) {
            changes.push({
              path: `${key}[${i}].${child.key}`,
              label: `${field.label} 第 ${i + 1} 行 / ${child.label}`,
              kind: 'changed',
              before: displayVal(cvB),
              after: displayVal(cvA),
            });
          }
        }
      }
    } else if (JSON.stringify(bv ?? null) !== JSON.stringify(av ?? null)) {
      changes.push({ path: key, label: label(key, field.label), kind: 'changed', before: displayVal(bv), after: displayVal(av) });
    }
  }
  // schema 中已删但旧数据里还有的键，也不丢
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if ((fieldSchema || []).some((f) => f.key === key)) continue;
    if (JSON.stringify(b[key] ?? null) !== JSON.stringify(a[key] ?? null)) {
      changes.push({ path: key, label: key, kind: 'changed', before: displayVal(b[key]), after: displayVal(a[key]) });
    }
  }
  return changes;
}

/** 派生旧版引用拦截字段（trigger/condition/approver），供 findReferences 复用 */
export function legacyRefFields(definition) {
  let condition = null;
  let approver = null;
  for (const stage of definition || []) {
    if (stage.kind === 'approval' && stage.node?.approver_type === 'field' && !approver) {
      approver = stage.node.field;
    }
    if (stage.kind === 'branch') {
      const f = stage.branches?.find((x) => x.when?.field)?.when?.field;
      if (f && !condition) condition = f;
    }
  }
  return { trigger_field: condition, condition_field: condition, approver_field: approver };
}

export function _isPlainObj(v) { return isPlainObj(v); }
