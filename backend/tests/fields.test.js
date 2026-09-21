import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDefaults,
  newFieldMeta,
  validateSchema,
  validateSubmission,
} from '../src/fields.js';

const numField = {
  key: 'f_age', type: 'number', label: '年龄', required: true,
  unique: false, defaultValue: null, validateMessage: '', unit: '岁', min: 18, max: 60,
};
const dateField = {
  key: 'f_month', type: 'date', label: '入职月份', required: true,
  unique: false, defaultValue: null, validateMessage: '', datePrecision: 'month',
};
const selectField = {
  key: 'f_dept', type: 'select', label: '部门', required: false, unique: false,
  defaultValue: null, validateMessage: '',
  options: [{ label: '技术', value: 'tech' }, { label: '销售', value: 'sales' }],
};
const multiField = {
  key: 'f_tags', type: 'multiselect', label: '标签', required: false, unique: false,
  defaultValue: null, validateMessage: '',
  options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }],
};
const subField = {
  key: 'f_rows', type: 'subform', label: '明细', required: false, unique: false,
  defaultValue: null, validateMessage: '',
  children: [
    { key: 'f_goods', type: 'text', label: '商品', required: true, unique: false, defaultValue: '', validateMessage: '', maxLength: 20 },
    { key: 'f_qty', type: 'number', label: '数量', required: false, unique: false, defaultValue: null, validateMessage: '', unit: '件', min: 1, max: 9 },
  ],
};

test('必填：空值报 REQUIRED，自定义提示生效', async () => {
  const { errors } = await validateSubmission([numField], { f_age: null });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'REQUIRED');
  const custom = { ...numField, validateMessage: '必须填年龄才能提交' };
  const r2 = await validateSubmission([custom], { f_age: '' });
  assert.equal(r2.errors[0].message, '必须填年龄才能提交');
});

test('数字范围：低于 min / 高于 max，单位拼进默认提示', async () => {
  const low = await validateSubmission([numField], { f_age: 3 });
  assert.equal(low.errors[0].code, 'MIN');
  assert.match(low.errors[0].message, /不能小于 18 岁/);
  const high = await validateSubmission([numField], { f_age: 99 });
  assert.equal(high.errors[0].code, 'MAX');
  const ok = await validateSubmission([numField], { f_age: 30 });
  assert.equal(ok.errors.length, 0);
  const badType = await validateSubmission([numField], { f_age: 'abc' });
  assert.equal(badType.errors[0].code, 'TYPE');
});

test('日期：月精度接受 YYYY-MM，拒绝日格式', async () => {
  assert.equal((await validateSubmission([dateField], { f_month: '2026-09' })).errors.length, 0);
  const e1 = await validateSubmission([dateField], { f_month: '2026-13' });
  assert.equal(e1.errors[0].code, 'DATE_FORMAT');
  const e2 = await validateSubmission([dateField], { f_month: '2026-09-01' });
  assert.equal(e2.errors[0].code, 'DATE_FORMAT');
  const dayField = { ...dateField, datePrecision: 'day', label: '入职日期' };
  assert.equal((await validateSubmission([dayField], { f_month: '2026-09-20' })).errors.length, 0);
  assert.equal((await validateSubmission([dayField], { f_month: '2026-02-31' })).errors.length, 1);
});

test('单选/多选：非法选项被拦', async () => {
  assert.equal((await validateSubmission([selectField], { f_dept: 'tech' })).errors.length, 0);
  const bad = await validateSubmission([selectField], { f_dept: 'ops' });
  assert.equal(bad.errors[0].code, 'OPTION');
  const mOk = await validateSubmission([multiField], { f_tags: ['a', 'b'] });
  assert.equal(mOk.errors.length, 0);
  const mBad = await validateSubmission([multiField], { f_tags: ['a', 'x'] });
  assert.equal(mBad.errors[0].code, 'OPTION');
});

test('唯一：uniqueChecker 命中报 UNIQUE', async () => {
  const u = { ...numField, unique: true };
  const r = await validateSubmission([u], { f_age: 30 }, {
    uniqueChecker: async () => true,
  });
  assert.ok(r.errors.some((e) => e.code === 'UNIQUE'));
});

test('子表单：按行定位错误，聚合 key 为点路径', async () => {
  const r = await validateSubmission([subField], {
    f_rows: [
      { f_goods: '键盘', f_qty: 2 },
      { f_goods: '', f_qty: 0 },
    ],
  });
  assert.equal(r.errors.length, 2);
  assert.equal(r.errors[0].fieldKey, 'f_rows.f_goods');
  assert.match(r.errors[0].message, /第 2 行/);
  assert.equal(r.errors[1].fieldKey, 'f_rows.f_qty');
  assert.deepEqual(r.errors[1].path, ['f_rows', 1, 'f_qty']);
});

test('默认值：缺失字段按类型补空数组/默认值', () => {
  const d = applyDefaults([
    { key: 'a', type: 'text', defaultValue: 'x' },
    { key: 'b', type: 'multiselect' },
    { key: 'c', type: 'attachment' },
    { key: 'd', type: 'subform' },
    { key: 'e', type: 'number' },
  ], {});
  assert.equal(d.a, 'x');
  assert.deepEqual(d.b, []);
  assert.deepEqual(d.c, []);
  assert.deepEqual(d.d, []);
  assert.equal(d.e, null);
});

test('设计期 schema 校验：重复 key、范围倒置、空选项、空子表单', () => {
  const bad = validateSchema([
    { key: 'a', type: 'text', label: 'A' },
    { key: 'a', type: 'text', label: 'B' },
    { key: 'n', type: 'number', label: 'N', min: 10, max: 1 },
    { key: 's', type: 'select', label: 'S', options: [] },
    { key: 'sub', type: 'subform', label: '子', children: [] },
  ]);
  assert.ok(bad.length >= 4);
  assert.ok(validateSchema([{ key: 'ok1', type: 'text', label: '正常' }]).length === 0);
});

test('newFieldMeta：8 种类型都能生成合法元数据', () => {
  for (const t of ['text', 'textarea', 'number', 'date', 'select', 'multiselect', 'attachment', 'subform']) {
    const f = newFieldMeta(t);
    assert.equal(f.type, t);
    assert.equal(validateSchema([f]).length, 0, `${t} 应通过 schema 校验`);
    if (t === 'subform') assert.ok(f.children.length >= 1);
    if (t === 'date') assert.equal(f.datePrecision, 'day');
  }
});
