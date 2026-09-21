// 字段类型定义与元数据工具（前后端约定的单一事实来源，文档化于 README）

export const FIELD_TYPES = {
  text: { label: '单行文本', scalar: true, uniqueable: true },
  textarea: { label: '多行文本', scalar: true, uniqueable: false },
  number: { label: '数字', scalar: true, uniqueable: true },
  date: { label: '日期', scalar: true, uniqueable: true },
  select: { label: '下拉单选', scalar: true, uniqueable: true },
  multiselect: { label: '多选', scalar: false, uniqueable: false },
  attachment: { label: '附件', scalar: false, uniqueable: false },
  subform: { label: '子表单', scalar: false, uniqueable: false },
};

export const ERROR_CODES = {
  REQUIRED: 'REQUIRED',
  UNIQUE: 'UNIQUE',
  TYPE: 'TYPE',
  MIN: 'MIN',
  MAX: 'MAX',
  LENGTH: 'LENGTH',
  OPTION: 'OPTION',
  DATE_FORMAT: 'DATE_FORMAT',
  MAX_COUNT: 'MAX_COUNT',
  SUBFIELD: 'SUBFIELD',
};

const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

function isEmpty(v) {
  return (
    v === null ||
    v === undefined ||
    (typeof v === 'string' && v.trim() === '') ||
    (Array.isArray(v) && v.length === 0)
  );
}

/** 按元数据默认值生成一份空数据（含子表单默认不建行） */
export function applyDefaults(schema, data = {}) {
  const out = {};
  for (const f of schema || []) {
    if (data[f.key] !== undefined) {
      out[f.key] = data[f.key];
    } else if (f.defaultValue !== undefined && f.defaultValue !== null && f.defaultValue !== '') {
      out[f.key] = f.defaultValue;
    } else if (f.type === 'multiselect' || f.type === 'attachment') {
      out[f.key] = [];
    } else if (f.type === 'subform') {
      out[f.key] = [];
    } else {
      out[f.key] = null;
    }
  }
  return out;
}

function msg(field, fallback) {
  return field.validateMessage?.trim() || fallback;
}

function validDayDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
function validMonth(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}$/.test(v)) return false;
  const [, m] = v.split('-').map(Number);
  return m >= 1 && m <= 12;
}

/**
 * 校验一条提交数据。
 * @returns {Promise<{errors: Array}>} errors: {path:[keys...], fieldKey, fieldLabel, code, message}
 *   fieldKey/fieldLabel 为聚合用的叶子字段标识（子表单形如 subKey.childKey）
 */
export async function validateSubmission(schema, data, deps = {}) {
  const { uniqueChecker, attachmentChecker } = deps;
  const errors = [];

  async function checkField(field, value, path, aggKey, aggLabel, rowIdx) {
    const tag = rowIdx === undefined ? '' : `（第 ${rowIdx + 1} 行）`;

    if (isEmpty(value)) {
      if (field.required) {
        errors.push({
          path,
          fieldKey: aggKey,
          fieldLabel: aggLabel,
          code: 'REQUIRED',
          message: msg(field, `「${field.label}」为必填项${tag}`),
        });
      }
      return; // 空值且非必填，后续规则不执行
    }

    switch (field.type) {
      case 'text':
      case 'textarea': {
        if (typeof value !== 'string') {
          errors.push({ path, fieldKey: aggKey, fieldLabel: aggLabel, code: 'TYPE', message: msg(field, `「${field.label}」必须是文本${tag}`) });
          break;
        }
        const max = Number(field.maxLength) || (field.type === 'text' ? 200 : 5000);
        if (value.length > max) {
          errors.push({ path, fieldKey: aggKey, fieldLabel: aggLabel, code: 'LENGTH', message: msg(field, `「${field.label}」不能超过 ${max} 个字符${tag}`) });
        }
        break;
      }
      case 'number': {
        const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
        if (typeof n !== 'number' || !Number.isFinite(n)) {
          errors.push({ path, fieldKey: aggKey, fieldLabel: aggLabel, code: 'TYPE', message: msg(field, `「${field.label}」必须是数字${tag}`) });
          break;
        }
        if (field.min !== null && field.min !== '' && field.min !== undefined && n < Number(field.min)) {
          errors.push({ path, fieldKey: aggKey, fieldLabel: aggLabel, code: 'MIN', message: msg(field, `「${field.label}」不能小于 ${field.min}${field.unit ? ' ' + field.unit : ''}${tag}`) });
        }
        if (field.max !== null && field.max !== '' && field.max !== undefined && n > Number(field.max)) {
          errors.push({ path, fieldKey: aggKey, fieldLabel: aggLabel, code: 'MAX', message: msg(field, `「${field.label}」不能大于 ${field.max}${field.unit ? ' ' + field.unit : ''}${tag}`) });
        }
        break;
      }
      case 'date': {
        const ok = field.datePrecision === 'month' ? validMonth(value) : validDayDate(value);
        if (!ok) {
          errors.push({
            path, fieldKey: aggKey, fieldLabel: aggLabel, code: 'DATE_FORMAT',
            message: msg(field, field.datePrecision === 'month'
              ? `「${field.label}」请填写到月，格式为 YYYY-MM${tag}`
              : `「${field.label}」请填写有效日期，格式为 YYYY-MM-DD${tag}`),
          });
        }
        break;
      }
      case 'select': {
        const allowed = (field.options || []).map((o) => o.value);
        if (!allowed.includes(value)) {
          errors.push({ path, fieldKey: aggKey, fieldLabel: aggLabel, code: 'OPTION', message: msg(field, `「${field.label}」选择了无效选项${tag}`) });
        }
        break;
      }
      case 'multiselect': {
        if (!Array.isArray(value)) {
          errors.push({ path, fieldKey: aggKey, fieldLabel: aggLabel, code: 'TYPE', message: msg(field, `「${field.label}」必须是多选数组${tag}`) });
          break;
        }
        const allowed = (field.options || []).map((o) => o.value);
        const bad = value.filter((v) => !allowed.includes(v));
        if (bad.length) {
          errors.push({ path, fieldKey: aggKey, fieldLabel: aggLabel, code: 'OPTION', message: msg(field, `「${field.label}」包含无效选项${tag}`) });
        }
        break;
      }
      case 'attachment': {
        if (!Array.isArray(value)) {
          errors.push({ path, fieldKey: aggKey, fieldLabel: aggLabel, code: 'TYPE', message: msg(field, `「${field.label}」附件数据格式不正确${tag}`) });
          break;
        }
        const maxCount = Number(field.maxCount) || 5;
        if (value.length > maxCount) {
          errors.push({ path, fieldKey: aggKey, fieldLabel: aggLabel, code: 'MAX_COUNT', message: msg(field, `「${field.label}」最多上传 ${maxCount} 个附件${tag}`) });
        }
        const ids = value.map((a) => Number(a?.id)).filter(Number.isInteger);
        if (attachmentChecker && ids.length) {
          const missing = await attachmentChecker(ids);
          if (missing.length) {
            errors.push({ path, fieldKey: aggKey, fieldLabel: aggLabel, code: 'TYPE', message: msg(field, `「${field.label}」中有 ${missing.length} 个附件不存在或已被删除${tag}`) });
          }
        }
        break;
      }
      case 'subform': {
        if (!Array.isArray(value)) {
          errors.push({ path, fieldKey: aggKey, fieldLabel: aggLabel, code: 'TYPE', message: msg(field, `「${field.label}」数据格式不正确${tag}`) });
          break;
        }
        for (const [i, row] of value.entries()) {
          if (typeof row !== 'object' || row === null) {
            errors.push({ path: [...path, i], fieldKey: aggKey, fieldLabel: aggLabel, code: 'SUBFIELD', message: `「${field.label}」第 ${i + 1} 行数据格式不正确` });
            continue;
          }
          for (const child of field.children || []) {
            await checkField(
              child,
              row[child.key],
              [...path, i, child.key],
              `${aggKey}.${child.key}`,
              `${field.label} / ${child.label}`,
              i,
            );
          }
        }
        break;
      }
    }

    // 唯一性（仅标量字段；空值已在前面 return）
    if (field.unique && FIELD_TYPES[field.type]?.uniqueable && uniqueChecker) {
      const dup = await uniqueChecker(aggKey, value);
      if (dup) {
        errors.push({ path, fieldKey: aggKey, fieldLabel: aggLabel, code: 'UNIQUE', message: msg(field, `「${field.label}」的值已存在，请保证唯一${tag}`) });
      }
    }
  }

  for (const field of schema || []) {
    await checkField(field, data?.[field.key], [field.key], field.key, field.label);
  }
  return { errors };
}

/** 结构校验设计期 schema（保存表单时调用），返回中文错误信息数组 */
export function validateSchema(schema) {
  const problems = [];
  if (!Array.isArray(schema)) return ['字段结构必须是数组'];
  const topKeys = new Set();

  function walk(fields, where) {
    if (!Array.isArray(fields)) {
      problems.push(`${where} 字段必须是数组`);
      return;
    }
    const localKeys = new Set();
    for (const f of fields) {
      if (!f || typeof f !== 'object') { problems.push(`${where} 存在非法字段`); continue; }
      if (!FIELD_TYPES[f.type]) { problems.push(`字段「${f.label || '?'}」类型未知：${f.type}`); continue; }
      if (!f.label?.trim()) { problems.push(`${where} 存在未命名字段`); continue; }
      if (!f.key || !KEY_RE.test(f.key)) {
        problems.push(`字段「${f.label}」的标识不合法（需字母开头，仅含字母数字下划线）`);
      } else if (localKeys.has(f.key) || topKeys.has(f.key)) {
        problems.push(`字段标识「${f.key}」重复`);
      } else {
        localKeys.add(f.key);
        topKeys.add(f.key);
      }
      if (f.type === 'number') {
        const min = f.min === '' || f.min === null || f.min === undefined ? null : Number(f.min);
        const max = f.max === '' || f.max === null || f.max === undefined ? null : Number(f.max);
        if ((min !== null && Number.isNaN(min)) || (max !== null && Number.isNaN(max))) {
          problems.push(`字段「${f.label}」的取值范围必须是数字`);
        } else if (min !== null && max !== null && min > max) {
          problems.push(`字段「${f.label}」的最小值不能大于最大值`);
        }
      }
      if ((f.type === 'select' || f.type === 'multiselect')) {
        const opts = f.options || [];
        if (!opts.length) problems.push(`字段「${f.label}」至少需要一个选项`);
        const vals = new Set();
        for (const o of opts) {
          if (!o?.label?.trim() || !o.value?.toString().trim()) {
            problems.push(`字段「${f.label}」存在空白选项`);
          } else if (vals.has(o.value)) {
            problems.push(`字段「${f.label}」选项值「${o.value}」重复`);
          }
          vals.add(o.value);
        }
      }
      if (f.type === 'subform') {
        if (!f.children?.length) {
          problems.push(`子表单「${f.label}」至少要有一个子字段`);
        }
        walk(f.children, `子表单「${f.label}」内`);
      }
    }
  }
  walk(schema, '表单');
  return problems;
}

export function newFieldMeta(type) {
  const seq = Math.random().toString(36).slice(2, 8);
  const base = {
    key: `f_${type}_${seq}`,
    type,
    label: FIELD_TYPES[type].label,
    required: false,
    unique: false,
    defaultValue: null,
    validateMessage: '',
    tips: '',
  };
  switch (type) {
    case 'text': return { ...base, maxLength: 200 };
    case 'textarea': return { ...base, maxLength: 1000 };
    case 'number': return { ...base, unit: '', min: '', max: '' };
    case 'date': return { ...base, datePrecision: 'day' };
    case 'select':
    case 'multiselect':
      return { ...base, options: [{ label: '选项一', value: 'opt1' }, { label: '选项二', value: 'opt2' }] };
    case 'attachment': return { ...base, maxCount: 5, accept: '' };
    case 'subform':
      return {
        ...base,
        key: `f_sub_${seq}`,
        children: [{ ...newFieldMeta('text'), label: '子字段', key: `f_child_${seq}` }],
      };
    default: return base;
  }
}
