// 流程纯逻辑单测（无需数据库）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evalOp, evaluateGroup, evaluateTrigger, routeCondition,
  resolveAssignees, validateFlowDefinition, diffSubmission,
} from '../src/flowdef.js';
test('evalOp：数字大小比较与空值短路', () => {
  assert.equal(evalOp(12000, 'gt', 10000), true);
  assert.equal(evalOp(9999, 'gt', 10000), false);
  assert.equal(evalOp('10001', 'gt', 10000), true);
  assert.equal(evalOp('abc', 'gt', 10000), false);
  assert.equal(evalOp(null, 'gt', 1), false);
  assert.equal(evalOp('', 'not_empty'), false);
  assert.equal(evalOp([], 'empty'), true);
  assert.equal(evalOp('x', 'empty'), false);
  assert.equal(evalOp('tech', 'eq', 'tech'), true);
  assert.equal(evalOp(['a', 'b'], 'contains', 'a'), true);
  assert.equal(evalOp(['a', 'b'], 'not_contains', 'c'), true);
  assert.equal(evalOp('b', 'in', ['a', 'b']), true);
  assert.equal(evalOp('c', 'not_in', ['a', 'b']), true);
});

test('evaluateGroup：and/or 组合', () => {
  const data = { amount: 12000, days: 2 };
  assert.equal(evaluateGroup({ logic: 'and', conditions: [
    { field: 'amount', op: 'gt', value: 10000 },
    { field: 'days', op: 'gte', value: 1 },
  ] }, data), true);
  assert.equal(evaluateGroup({ logic: 'and', conditions: [
    { field: 'amount', op: 'gt', value: 10000 },
    { field: 'days', op: 'gt', value: 5 },
  ] }, data), false);
  assert.equal(evaluateGroup({ logic: 'or', conditions: [
    { field: 'amount', op: 'lt', value: 1 },
    { field: 'days', op: 'gte', value: 1 },
  ] }, data), true);
  assert.equal(evaluateGroup({ conditions: [] }, data), true);
});

test('evaluateTrigger：无规则全部触发；有规则按条件', () => {
  assert.equal(evaluateTrigger(null, { x: 1 }), true);
  assert.equal(evaluateTrigger({ field: 'score', op: 'lt', value: 4 }, { score: 2 }), true);
  assert.equal(evaluateTrigger({ field: 'score', op: 'lt', value: 4 }, { score: 5 }), false);
});

test('routeCondition：命中第一条分支，否则默认分支，都不命中返回 null', () => {
  const node = {
    branches: [
      { label: '大额', logic: 'and', conditions: [{ field: 'amount', op: 'gt', value: 10000 }], next: 'n_director' },
    ],
    defaultNext: 'n_fin',
  };
  assert.equal(routeCondition(node, { amount: 20000 }), 'n_director');
  assert.equal(routeCondition(node, { amount: 100 }), 'n_fin');
  assert.equal(routeCondition({ branches: [], defaultNext: null }, { amount: 1 }), null);
});

test('resolveAssignees：固定人员 + 字段取值 + 去重去空', () => {
  const node = {
    approvers: [
      { type: 'user', value: 'u_a' },
      { type: 'user', value: 'u_a' },
      { type: 'field', value: 'f_extra' },
      { type: 'field', value: 'f_multi' },
      { type: 'field', value: 'f_missing' },
    ],
  };
  const data = { f_extra: 'u_b', f_multi: ['u_c', 'u_a'], f_missing: null };
  assert.deepEqual(resolveAssignees(node, data), ['u_a', 'u_b', 'u_c']);
});

test('validateFlowDefinition：合法串行+分支+会签通过', () => {
  const def = { nodes: [
    { key: 'start', type: 'start', next: 'c' },
    { key: 'c', type: 'condition', name: '金额', branches: [
      { label: '>1万', logic: 'and', conditions: [{ field: 'amount', op: 'gt', value: 10000 }], next: 'boss' },
    ], defaultNext: 'end' },
    { key: 'boss', type: 'approval', name: '总监', mode: 'all',
      approvers: [{ type: 'user', value: 'u_boss' }], next: 'end' },
    { key: 'end', type: 'end' },
  ] };
  const schema = [{ key: 'amount', type: 'number', label: '金额', options: [] }];
  assert.deepEqual(validateFlowDefinition(def, schema), []);
});

test('validateFlowDefinition：典型非法情形逐条拦截', () => {
  const schema = [{ key: 'name', type: 'text', label: '姓名' }];
  // 缺结束节点
  assert.ok(validateFlowDefinition({ nodes: [{ key: 's', type: 'start', next: 'end' }] }, schema).length);
  // 重复 key
  const dup = validateFlowDefinition({ nodes: [
    { key: 'start', type: 'start', next: 'a' },
    { key: 'a', type: 'approval', name: 'A', approvers: [{ type: 'user', value: 'x' }], next: 'a' },
    { key: 'end', type: 'end' },
  ] }, schema);
  assert.ok(dup.some((m) => /重复|环路/.test(m)));
  // 审批人字段不存在
  const badField = validateFlowDefinition({ nodes: [
    { key: 'start', type: 'start', next: 'a' },
    { key: 'a', type: 'approval', name: 'A', approvers: [{ type: 'field', value: 'nope' }], next: 'end' },
    { key: 'end', type: 'end' },
  ] }, schema);
  assert.ok(badField.some((m) => /审批人字段/.test(m)));
  // 数字比较作用于文本字段
  const badOp = validateFlowDefinition({ nodes: [
    { key: 'start', type: 'start', next: 'c' },
    { key: 'c', type: 'condition', name: 'C', branches: [
      { label: 'b', logic: 'and', conditions: [{ field: 'name', op: 'gt', value: 1 }], next: 'end' },
    ] },
    { key: 'end', type: 'end' },
  ] }, schema);
  assert.ok(badOp.some((m) => /不是数字字段/.test(m)));
  // 不可达节点
  const unreachable = validateFlowDefinition({ nodes: [
    { key: 'start', type: 'start', next: 'end' },
    { key: 'orphan', type: 'approval', name: '孤立', approvers: [{ type: 'user', value: 'x' }], next: 'end' },
    { key: 'end', type: 'end' },
  ] }, schema);
  assert.ok(unreachable.some((m) => /无法从开始到达/.test(m)));
});

test('diffSubmission：标量变化、选项转标签、子表单精确到行、无变化为空', () => {
  const schema = [
    { key: 'reason', type: 'textarea', label: '事由' },
    { key: 'dept', type: 'select', label: '部门', options: [{ label: '技术部', value: 'tech' }, { label: '销售部', value: 'sales' }] },
    { key: 'days', type: 'number', label: '天数', unit: '天' },
    { key: 'items', type: 'subform', label: '明细', children: [
      { key: 'qty', type: 'number', label: '数量', unit: '件' },
    ] },
  ];
  const before = { reason: '有事', dept: 'tech', days: 1, items: [{ qty: 1 }] };
  const after = { reason: '家中急事需处理', dept: 'sales', days: 1, items: [{ qty: 3 }, { qty: 2 }] };
  const changes = diffSubmission(schema, before, after);
  const byPath = Object.fromEntries(changes.map((c) => [c.path, c]));
  assert.equal(byPath.reason.before, '有事');
  assert.equal(byPath.reason.after, '家中急事需处理');
  assert.equal(byPath.dept.before, '技术部');
  assert.equal(byPath.dept.after, '销售部');
  assert.ok(!byPath.days, '未变化字段不应出现');
  assert.equal(byPath['items[0].qty'].before, '1 件');
  assert.equal(byPath['items[0].qty'].after, '3 件');
  assert.equal(byPath['items[1].qty'].before, '（新增行）');
  assert.equal(byPath['items[1].qty'].after, '2 件');
  assert.deepEqual(diffSubmission(schema, before, before), []);
});
