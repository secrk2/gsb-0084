// 流程定义：纯逻辑（无数据库依赖），可单测
// 定义结构（flows.definition JSONB）：
// {
//   nodes: [
//     { key:'start', type:'start', next:'n1' },
//     { key:'n1', type:'approval', name:'直属主管审批', mode:'all',
//       approvers:[{type:'user', value:'u_li'}], next:'c1' },
//     { key:'c1', type:'condition', name:'金额分支',
//       branches:[{ label:'金额 > 10000', logic:'and',
//                   conditions:[{field:'f_amount', op:'gt', value:10000}], next:'n2' }],
//       defaultNext:'n3' },
//     { key:'n2', type:'approval', name:'总监审批', mode:'all',
//       approvers:[{type:'user', value:'u_zhang'}], next:'end' },
//     { key:'end', type:'end' }
//   ]
// }
// approvers: [{type:'user', value:'账号'} | {type:'field', value:'字段key'}]
// mode: 'all' = 会签（所有人通过） | 'any' = 或签（任一人通过即可）

export const NODE_TYPES = {
  start: { label: '开始' },
  approval: { label: '审批节点' },
  condition: { label: '条件分支' },
  end: { label: '结束' },
};

export const OPS = [
  { value: 'gt', label: '大于', numeric: true },
  { value: 'gte', label: '大于等于', numeric: true },
  { value: 'lt', label: '小于', numeric: true },
  { value: 'lte', label: '小于等于', numeric: true },
  { value: 'eq', label: '等于' },
  { value: 'ne', label: '不等于' },
  { value: 'in', label: '属于', multi: true },
  { value: 'not_in', label: '不属于', multi: true },
  { value: 'contains', label: '包含（多选）', multiField: true },
  { value: 'not_contains', label: '不包含（多选）', multiField: true },
  { value: 'empty', label: '为空', noValue: true },
  { value: 'not_empty', label: '不为空', noValue: true },
];

const NUMERIC_OPS = new Set(['gt', 'gte', 'lt', 'lte']);

function isEmptyVal(v) {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
}

/** 单个条件运算 */
export function evalOp(value, op, target) {
  if (op === 'empty') return isEmptyVal(value);
  if (op === 'not_empty') return !isEmptyVal(value);
  if (isEmptyVal(value)) return false;

  if (op === 'contains') return Array.isArray(value) ? value.includes(target) : String(value) === String(target);
  if (op === 'not_contains') return !(Array.isArray(value) ? value.includes(target) : String(value) === String(target));
  if (op === 'in') return Array.isArray(target) && target.map(String).includes(String(value));
  if (op === 'not_in') return !(Array.isArray(target) && target.map(String).includes(String(value)));

  if (NUMERIC_OPS.has(op)) {
    const n = Number(value);
    const t = Number(target);
    if (!Number.isFinite(n) || !Number.isFinite(t)) return false;
    if (op === 'gt') return n > t;
    if (op === 'gte') return n >= t;
    if (op === 'lt') return n < t;
    return n <= t;
  }
  if (op === 'eq') return String(value) === String(target);
  if (op === 'ne') return String(value) !== String(target);
  return false;
}

/** 条件组：{logic:'and'|'or', conditions:[{field,op,value}]}，field 支持点路径（子表单取首行） */
export function evaluateGroup(group, data) {
  const conds = group?.conditions || [];
  if (!conds.length) return true;
  const logic = group.logic === 'or' ? 'or' : 'and';
  const results = conds.map((c) => evalOp(readPath(data, c.field), c.op, c.value));
  return logic === 'or' ? results.some(Boolean) : results.every(Boolean);
}

/** 触发规则（单组条件），null/空规则视为全部触发 */
export function evaluateTrigger(rule, data) {
  if (!rule || !rule.field || !rule.op) return true;
  return evaluateGroup({ logic: 'and', conditions: [rule] }, data);
}

/** 条件节点选路：自上而下第一条命中的分支；都不命中走 defaultNext（可能为 null → 直接结束） */
export function routeCondition(node, data) {
  for (const b of node.branches || []) {
    if (evaluateGroup(b, data)) return b.next;
  }
  return node.defaultNext || null;
}

function readPath(data, path) {
  if (!path) return undefined;
  const parts = String(path).split('.');
  let cur = data;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

// ---------- 审批人解析 ----------

/**
 * 解析节点在某份数据下的实际审批人账号（去重、去空）。
 * type=field 时：字段值为字符串直接用；多选字段为数组；兼容逗号分隔。
 */
export function resolveAssignees(node, data) {
  const out = [];
  for (const a of node.approvers || []) {
    if (a.type === 'user') {
      if (a.value) out.push(String(a.value));
    } else if (a.type === 'field') {
      const v = readPath(data, a.value);
      if (Array.isArray(v)) out.push(...v.map(String));
      else if (v !== null && v !== undefined && v !== '') out.push(...String(v).split(/[,，]/).map((s) => s.trim()).filter(Boolean));
    }
  }
  return [...new Set(out.filter(Boolean))];
}

// ---------- 定义结构校验 ----------

/** 字段 key → {field, parents} 的索引（key 全表唯一） */
export function fieldMapOfSchema(schema) {
  const map = new Map();
  const walk = (fields, parents = []) => {
    for (const f of fields || []) {
      map.set(f.key, { field: f, parents });
      if (f.children?.length) walk(f.children, [...parents, f.key]);
    }
  };
  walk(schema);
  return map;
}

/** 校验条件字段/取值合法，返回错误信息数组（空=通过） */
export function validateRule(rule, fieldMap, where) {
  const problems = [];
  if (!rule || !rule.op) return problems;
  if (!rule.field) { problems.push(`${where}缺少判断字段`); return problems; }
  const hit = fieldMap.get(rule.field.split('.')[0]);
  if (!hit) { problems.push(`${where}引用了已不存在的字段「${rule.field}」`); return problems; }
  const op = OPS.find((o) => o.value === rule.op);
  if (!op) { problems.push(`${where}的比较方式不支持：${rule.op}`); return problems; }
  if (op.numeric && hit.field.type !== 'number') {
    problems.push(`${where}对「${hit.field.label}」使用了大小比较，但该字段不是数字字段`);
  }
  if (!op.noValue && (rule.value === undefined || rule.value === '' ||
      (Array.isArray(rule.value) && !rule.value.length))) {
    problems.push(`${where}缺少比较值`);
  }
  return problems;
}

/** 校验整份流程定义，返回中文问题数组（空数组=合法） */
export function validateFlowDefinition(def, schema = []) {
  const problems = [];
  const nodes = def?.nodes;
  if (!Array.isArray(nodes) || nodes.length < 2) return ['流程至少需要「开始」和「结束」两个节点'];
  const fieldMap = fieldMapOfSchema(schema);

  const keys = new Set();
  const starts = [];
  const ends = [];
  for (const n of nodes) {
    if (!n || typeof n !== 'object') { problems.push('存在非法节点'); continue; }
    if (!n.key) { problems.push('存在没有标识的节点'); continue; }
    if (keys.has(n.key)) problems.push(`节点标识「${n.key}」重复`);
    keys.add(n.key);
    if (n.type === 'start') starts.push(n);
    if (n.type === 'end') ends.push(n);
    if (!NODE_TYPES[n.type]) problems.push(`节点「${n.name || n.key}」类型未知：${n.type}`);
  }
  if (starts.length !== 1) problems.push(`流程必须有且仅有一个「开始」节点（当前 ${starts.length} 个）`);
  if (ends.length !== 1) problems.push(`流程必须有且仅有一个「结束」节点（当前 ${ends.length} 个）`);

  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const mustExist = (key, where) => {
    if (!key) { problems.push(`${where}没有连接下一节点`); return false; }
    if (!byKey.has(key)) { problems.push(`${where}指向了不存在的节点「${key}」`); return false; }
    return true;
  };

  for (const n of nodes) {
    if (n.type === 'start') {
      mustExist(n.next, '开始节点');
    } else if (n.type === 'end') {
      if (n.next) problems.push('结束节点后不能再连接节点');
    } else if (n.type === 'approval') {
      if (!n.name?.trim()) problems.push(`节点「${n.key}」缺少节点名称`);
      if (n.mode && !['all', 'any'].includes(n.mode)) problems.push(`节点「${n.name}」的会签模式不合法`);
      const approvers = Array.isArray(n.approvers) ? n.approvers : [];
      if (!approvers.length) {
        problems.push(`审批节点「${n.name || n.key}」至少要设置一个审批人`);
      } else {
        for (const a of approvers) {
          if (a?.type === 'field') {
            const hit = fieldMap.get(String(a.value || '').split('.')[0]);
            if (!hit) problems.push(`节点「${n.name}」指定的审批人字段「${a.value}」不存在`);
          } else if (a?.type !== 'user' || !a.value) {
            problems.push(`节点「${n.name}」存在未配置完整的审批人`);
          }
        }
      }
      mustExist(n.next, `审批节点「${n.name || n.key}」`);
    } else if (n.type === 'condition') {
      if (!n.name?.trim()) problems.push(`节点「${n.key}」缺少分支名称`);
      const branches = Array.isArray(n.branches) ? n.branches : [];
      if (!branches.length) {
        problems.push(`条件分支「${n.name || n.key}」至少配置一条分支`);
      }
      branches.forEach((b, i) => {
        const where = `「${n.name || n.key}」第 ${i + 1} 条分支`;
        if (!b.label?.trim()) problems.push(`${where}缺少分支说明`);
        const conds = Array.isArray(b.conditions) ? b.conditions : [];
        if (!conds.length) problems.push(`${where}至少需要一个判断条件`);
        conds.forEach((c) => problems.push(...validateRule(c, fieldMap, where)));
        mustExist(b.next, where);
      });
      if (n.defaultNext) mustExist(n.defaultNext, `「${n.name || n.key}」的默认分支`);
      // 没有默认分支时所有条件都不命中会直接结束，提示而非报错
    }
  }

  // 连通性：从开始节点出发必须能到达所有节点，且不允许成环
  if (starts.length === 1 && !problems.some((p) => /指向了不存在|没有连接/.test(p))) {
    const seen = new Set();
    const stack = [{ key: starts[0].next, path: [] }];
    while (stack.length) {
      const { key, path } = stack.pop();
      if (!key) continue;
      if (path.includes(key)) { problems.push(`流程存在环路（经过节点「${key}」），审批流不允许回环`); break; }
      if (seen.has(key)) continue;
      seen.add(key);
      const n = byKey.get(key);
      if (!n) continue;
      if (n.type === 'approval' || n.type === 'start') stack.push({ key: n.next, path: [...path, key] });
      else if (n.type === 'condition') {
        for (const b of n.branches || []) stack.push({ key: b.next, path: [...path, key] });
        if (n.defaultNext) stack.push({ key: n.defaultNext, path: [...path, key] });
      }
    }
    for (const n of nodes) {
      if (n.type !== 'start' && !seen.has(n.key)) problems.push(`节点「${n.name || n.key}」无法从开始到达，请检查连线`);
    }
  }
  return problems;
}

/** 触发规则引用字段（供字段删除引用检查） */
export function collectDefinitionRefs(def) {
  const refs = { trigger: null, conditions: [], approverFields: [] };
  const rule = def?.trigger_rule || null;
  if (rule?.field) refs.trigger = rule.field;
  const scanGroup = (g) => {
    for (const c of g?.conditions || []) if (c.field) refs.conditions.push(c.field);
  };
  for (const n of def?.nodes || []) {
    if (n.type === 'condition') {
      for (const b of n.branches || []) scanGroup(b);
    }
    if (n.type === 'approval') {
      for (const a of n.approvers || []) {
        if (a.type === 'field' && a.value) refs.approverFields.push(a.value);
      }
    }
  }
  return refs;
}

// ---------- 修改留痕：字段级 diff ----------

function formatScalar(field, v) {
  if (isEmptyVal(v)) return '（空）';
  switch (field.type) {
    case 'select': {
      const o = (field.options || []).find((x) => String(x.value) === String(v));
      return o ? o.label : String(v);
    }
    case 'multiselect': {
      if (!Array.isArray(v)) return String(v);
      return v.map((x) => field.options?.find((o) => String(o.value) === String(x))?.label || x).join('、') || '（空）';
    }
    case 'number': {
      const s = String(v);
      return field.unit ? `${s} ${field.unit}` : s;
    }
    case 'attachment': {
      const n = Array.isArray(v) ? v.length : 0;
      return n ? `${n} 个附件` : '（空）';
    }
    default:
      return String(v).length > 80 ? `${String(v).slice(0, 80)}…` : String(v);
  }
}

/**
 * 对比改前改后两份填报数据，按字段（子表单精确到行）产出变更明细。
 * @returns Array<{path,label,before,after}>
 */
export function diffSubmission(schema, before, after) {
  const changes = [];

  const push = (path, label, b, a) => {
    if (JSON.stringify(b) === JSON.stringify(a)) return;
    changes.push({ path, label, before: b, after: a });
  };

  for (const field of schema || []) {
    const b = before?.[field.key];
    const a = after?.[field.key];
    if (field.type === 'subform') {
      const bRows = Array.isArray(b) ? b : [];
      const aRows = Array.isArray(a) ? a : [];
      const rowCount = Math.max(bRows.length, aRows.length);
      for (let i = 0; i < rowCount; i++) {
        const inBefore = i < bRows.length;
        const inAfter = i < aRows.length;
        for (const child of field.children || []) {
          const path = `${field.key}[${i}].${child.key}`;
          const label = `${field.label} 第 ${i + 1} 行 · ${child.label}`;
          const bv = inBefore ? formatScalar(child, bRows[i]?.[child.key]) : '（新增行）';
          const av = inAfter ? formatScalar(child, aRows[i]?.[child.key]) : '（已删除行）';
          push(path, label, bv, av);
        }
      }
    } else {
      push(field.key, field.label, formatScalar(field, b), formatScalar(field, a));
    }
  }
  return changes;
}
