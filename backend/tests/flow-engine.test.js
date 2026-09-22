// 流程引擎纯逻辑单测（无需数据库）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newApprovalNode,
  validateDefinition,
  evalCondition,
  pickBranch,
  resolveApprovers,
  expandPath,
  diffData,
  collectDefinitionFields,
  legacyRefFields,
} from '../src/flow/engine.js';

const formSchema = [
  { key: 'f_amount', type: 'number', label: '金额' },
  { key: 'f_dept', type: 'select', label: '部门', options: [{ label: '技术', value: 'tech' }, { label: '财务', value: 'finance' }] },
  { key: 'f_managers', type: 'multiselect', label: '分管领导', options: [{ label: '甲', value: 'u1' }, { label: '乙', value: 'u2' }] },
  { key: 'f_note', type: 'text', label: '备注' },
  {
    key: 'f_lines', type: 'subform', label: '明细',
    children: [
      { key: 'f_qty', type: 'number', label: '数量' },
      { key: 'f_goods', type: 'text', label: '商品' },
    ],
  },
];

function simpleFlow() {
  return [
    { kind: 'approval', node: newApprovalNode({ name: '主管', approvers: ['u10'] }) },
    {
      kind: 'branch',
      branches: [
        { label: '大额', when: { field: 'f_amount', op: 'gt', value: 10000 }, nodes: [
          newApprovalNode({ id: 'n_dir', name: '总监', approvers: ['u11'] }),
        ] },
        { label: '其他', when: null, nodes: [] },
      ],
    },
  ];
}

test('validateDefinition：合法流程通过', () => {
  assert.deepEqual(validateDefinition(simpleFlow(), formSchema), []);
});

test('validateDefinition：未指定审批人 / 条件字段不存在 / 值缺失 被拦下', () => {
  const bad = [
    { kind: 'approval', node: newApprovalNode({ name: '空节点', approvers: [] }) },
    { kind: 'branch', branches: [
      { label: 'b', when: { field: 'f_not_exist', op: 'gt', value: 1 }, nodes: [] },
    ] },
    { kind: 'branch', branches: [
      { label: 'b2', when: { field: 'f_amount', op: 'gt', value: '' }, nodes: [] },
    ] },
    { kind: 'approval', node: newApprovalNode({ name: '字段审批', approver_type: 'field', field: 'f_gone' }) },
  ];
  const problems = validateDefinition(bad, formSchema);
  assert.ok(problems.length >= 3, JSON.stringify(problems));
  assert.ok(problems.some((p) => p.includes('未指定审批人')));
  assert.ok(problems.some((p) => p.includes('f_not_exist')));
  assert.ok(problems.some((p) => p.includes('条件值')));
  assert.ok(problems.some((p) => p.includes('f_gone')));
});

test('evalCondition：大小于/等于/in/空 语义正确', () => {
  assert.equal(evalCondition({ field: 'f_amount', op: 'gt', value: 10000 }, { f_amount: 20000 }), true);
  assert.equal(evalCondition({ field: 'f_amount', op: 'gt', value: 10000 }, { f_amount: 9999 }), false);
  assert.equal(evalCondition({ field: 'f_amount', op: 'lte', value: 10000 }, { f_amount: '10000' }), true);
  assert.equal(evalCondition({ field: 'f_dept', op: 'eq', value: 'tech' }, { f_dept: 'tech' }), true);
  assert.equal(evalCondition({ field: 'f_dept', op: 'ne', value: 'tech' }, { f_dept: 'finance' }), true);
  assert.equal(evalCondition({ field: 'f_managers', op: 'in', value: 'u1,u3' }, { f_managers: ['u2', 'u3'] }), true);
  assert.equal(evalCondition({ field: 'f_managers', op: 'not_in', value: 'u9' }, { f_managers: ['u1'] }), true);
  assert.equal(evalCondition({ field: 'f_note', op: 'empty' }, { f_note: '' }), true);
  assert.equal(evalCondition({ field: 'f_note', op: 'not_empty' }, { f_note: 'x' }), true);
  // 非法数字比较不通过而不是报错
  assert.equal(evalCondition({ field: 'f_note', op: 'gt', value: 1 }, { f_note: 'abc' }), false);
  // 定宽日期字符串支持大小比较；普通文本大小于一律不成立
  assert.equal(evalCondition({ field: 'f_day', op: 'gte', value: '2026-09-01' }, { f_day: '2026-09-20' }), true);
  assert.equal(evalCondition({ field: 'f_month', op: 'lt', value: '2026-10' }, { f_month: '2026-09' }), true);
  assert.equal(evalCondition({ field: 'f_note', op: 'gt', value: 'a' }, { f_note: 'z' }), false);
});

test('pickBranch：先命中先得；无命中取默认分支；无默认返回 -1', () => {
  const stage = { kind: 'branch', branches: [
    { label: 'a', when: { field: 'f_amount', op: 'gt', value: 100 } },
    { label: 'b', when: { field: 'f_amount', op: 'gt', value: 10 } },
    { label: 'd', when: null },
  ] };
  assert.equal(pickBranch(stage, { f_amount: 50 }), 1);
  assert.equal(pickBranch(stage, { f_amount: 5 }), 2);
  const noDefault = { kind: 'branch', branches: [stage.branches[0], stage.branches[1]] };
  assert.equal(pickBranch(noDefault, { f_amount: 1 }), -1);
});

test('resolveApprovers：固定人 / 字段标量 / 字段数组', () => {
  const fixed = newApprovalNode({ approver_type: 'fixed', approvers: ['a', 'b'] });
  assert.deepEqual(resolveApprovers(fixed, {}), ['a', 'b']);
  const fScalar = newApprovalNode({ approver_type: 'field', field: 'f_dept' });
  assert.deepEqual(resolveApprovers(fScalar, { f_dept: 'tech' }), ['tech']);
  const fArr = newApprovalNode({ approver_type: 'field', field: 'f_managers' });
  assert.deepEqual(resolveApprovers(fArr, { f_managers: ['u1', 'u2'] }), ['u1', 'u2']);
  assert.deepEqual(resolveApprovers(fArr, { f_managers: [] }), []);
});

test('expandPath：大额走主管+总监；小额只走主管；条件全不命中且无默认则为空', () => {
  const big = expandPath(simpleFlow(), { f_amount: 50000 });
  assert.deepEqual(big.map((x) => x.node.name), ['主管', '总监']);
  assert.equal(big[1].branch_idx, 0);
  const small = expandPath(simpleFlow(), { f_amount: 100 });
  assert.deepEqual(small.map((x) => x.node.name), ['主管']);

  const noDefault = [{
    kind: 'branch',
    branches: [{ label: 'x', when: { field: 'f_amount', op: 'gt', value: 1000 }, nodes: [newApprovalNode({ name: 'N', approvers: ['u'] })] }],
  }];
  assert.deepEqual(expandPath(noDefault, { f_amount: 1 }), []);
});

test('diffData：标量改动、子表单行增删与子字段改动都能识别', () => {
  const before = {
    f_amount: 100, f_dept: 'tech', f_note: 'a',
    f_lines: [{ f_qty: 1, f_goods: '纸' }, { f_qty: 2, f_goods: '笔' }],
  };
  const after = {
    f_amount: 300, f_dept: 'tech', f_note: 'a',
    f_lines: [{ f_qty: 1, f_goods: '纸张' }, { f_qty: 3, f_goods: '笔' }, { f_qty: 9, f_goods: '墨' }],
  };
  const changes = diffData(before, after, formSchema);
  const labels = changes.map((c) => c.label);
  assert.ok(labels.includes('金额'));
  assert.ok(labels.some((l) => l.includes('第 1 行') && l.includes('商品')), JSON.stringify(labels));
  assert.ok(labels.some((l) => l.includes('第 2 行') && l.includes('数量')));
  assert.ok(labels.some((l) => l.includes('第 3 行')), '新增一行应被识别');
  const amount = changes.find((c) => c.path === 'f_amount');
  assert.equal(amount.before, '100');
  assert.equal(amount.after, '300');
  // 未变化字段不报
  assert.ok(!labels.includes('部门'));
  assert.ok(!labels.includes('备注'));

  // 删除一行
  const removed = diffData(before, { ...before, f_lines: [before.f_lines[0]] }, formSchema);
  assert.ok(removed.some((c) => c.label.includes('第 2 行') && c.kind === 'row_removed'));
});

test('collectDefinitionFields / legacyRefFields 收集条件与审批人字段', () => {
  const def = [
    { kind: 'approval', node: newApprovalNode({ approver_type: 'field', field: 'f_dept' }) },
    { kind: 'branch', branches: [
      { label: 'b', when: { field: 'f_amount', op: 'gt', value: 1 }, nodes: [] },
    ] },
  ];
  const keys = collectDefinitionFields(def);
  assert.ok(keys.has('f_dept'));
  assert.ok(keys.has('f_amount'));
  const legacy = legacyRefFields(def);
  assert.equal(legacy.condition_field, 'f_amount');
  assert.equal(legacy.approver_field, 'f_dept');
});
