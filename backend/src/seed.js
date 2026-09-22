// 种子数据：3 个应用 / 5 张表单 / 30 条填报 / 流程与视图引用 / 校验失败热点
// 用法：npm run seed   （幂等：清空业务表后重建）
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pool } from './db.js';
import { migrate } from './db.js';
import { config } from './config.js';
import { ensureUploadDir } from './routes/attachments.js';
import { seedFlows } from './flow/seed-flows.js';

const SCHEMAS = {
  // 1. 员工请假申请
  leave: [
    { key: 'f_emp_no', type: 'text', label: '工号', required: true, unique: true, defaultValue: '', validateMessage: '工号是 8 位数字，例 10012345，且不能与他人重复', maxLength: 20, tips: '' },
    { key: 'f_name', type: 'text', label: '姓名', required: true, unique: false, defaultValue: '', validateMessage: '', maxLength: 20 },
    { key: 'f_dept', type: 'select', label: '部门', required: true, unique: false, defaultValue: 'tech', validateMessage: '',
      options: [{ label: '技术部', value: 'tech' }, { label: '销售部', value: 'sales' }, { label: '人事部', value: 'hr' }, { label: '财务部', value: 'finance' }] },
    { key: 'f_leave_type', type: 'select', label: '请假类型', required: true, unique: false, defaultValue: 'annual', validateMessage: '',
      options: [{ label: '年假', value: 'annual' }, { label: '事假', value: 'personal' }, { label: '病假', value: 'sick' }, { label: '调休', value: 'comp' }] },
    { key: 'f_days', type: 'number', label: '请假天数', required: true, unique: false, defaultValue: 1, validateMessage: '请假天数需在 0.5~30 天之间', unit: '天', min: 0.5, max: 30 },
    { key: 'f_start_date', type: 'date', label: '开始日期', required: true, unique: false, defaultValue: null, validateMessage: '', datePrecision: 'day' },
    { key: 'f_end_date', type: 'date', label: '结束日期', required: false, unique: false, defaultValue: null, validateMessage: '', datePrecision: 'day' },
    { key: 'f_reason', type: 'textarea', label: '请假事由', required: true, unique: false, defaultValue: '', validateMessage: '请写明请假事由，便于主管审批', maxLength: 500 },
    { key: 'f_cert', type: 'attachment', label: '证明材料', required: false, unique: false, defaultValue: null, validateMessage: '病假请上传医院证明，最多 3 个文件', maxCount: 3, accept: '' },
    {
      key: 'f_handover', type: 'subform', label: '工作交接', required: false, unique: false, defaultValue: null, validateMessage: '',
      children: [
        { key: 'f_item', type: 'text', label: '交接事项', required: true, unique: false, defaultValue: '', validateMessage: '', maxLength: 100 },
        { key: 'f_person', type: 'text', label: '对接人', required: false, unique: false, defaultValue: '', validateMessage: '', maxLength: 20 },
        { key: 'f_status', type: 'select', label: '完成情况', required: false, unique: false, defaultValue: 'done', validateMessage: '',
          options: [{ label: '已完成', value: 'done' }, { label: '进行中', value: 'doing' }, { label: '未开始', value: 'todo' }] },
      ],
    },
  ],
  // 2. 客户拜访记录
  visit: [
    { key: 'f_customer_name', type: 'text', label: '客户名称', required: true, unique: true, defaultValue: '', validateMessage: '客户名称在系统内必须唯一，请勿重复登记', maxLength: 100 },
    { key: 'f_industry', type: 'select', label: '客户行业', required: true, unique: false, defaultValue: 'internet', validateMessage: '',
      options: [{ label: '互联网', value: 'internet' }, { label: '金融', value: 'finance' }, { label: '制造', value: 'manufacture' }, { label: '教育', value: 'edu' }] },
    { key: 'f_visit_month', type: 'date', label: '计划跟进月份', required: true, unique: false, defaultValue: null, validateMessage: '该字段只需要填到月份（YYYY-MM）', datePrecision: 'month' },
    { key: 'f_score', type: 'number', label: '满意度评分', required: true, unique: false, defaultValue: 5, validateMessage: '评分范围 1~5 分', unit: '分', min: 1, max: 5 },
    { key: 'f_contacts', type: 'multiselect', label: '对接方式', required: false, unique: false, defaultValue: ['visit'], validateMessage: '',
      options: [{ label: '上门拜访', value: 'visit' }, { label: '电话', value: 'phone' }, { label: '视频会议', value: 'video' }, { label: '微信', value: 'wechat' }] },
    { key: 'f_note', type: 'textarea', label: '拜访纪要', required: false, unique: false, defaultValue: '', validateMessage: '', maxLength: 1000 },
    {
      key: 'f_products', type: 'subform', label: '意向产品', required: false, unique: false, defaultValue: null, validateMessage: '',
      children: [
        { key: 'f_product', type: 'text', label: '产品名称', required: true, unique: false, defaultValue: '', validateMessage: '', maxLength: 60 },
        { key: 'f_qty', type: 'number', label: '数量', required: false, unique: false, defaultValue: 1, validateMessage: '数量至少为 1', unit: '套', min: 1, max: 9999 },
        { key: 'f_price', type: 'number', label: '预估单价', required: false, unique: false, defaultValue: null, validateMessage: '', unit: '元', min: 0, max: 100000000 },
      ],
    },
  ],
  // 3. 销售订单录入
  order: [
    { key: 'f_order_no', type: 'text', label: '订单编号', required: true, unique: true, defaultValue: '', validateMessage: '订单编号自动生成，不可与已有订单重复', maxLength: 40 },
    { key: 'f_customer', type: 'text', label: '客户名称', required: true, unique: false, defaultValue: '', validateMessage: '请填写客户全称', maxLength: 100 },
    { key: 'f_order_date', type: 'date', label: '下单日期', required: true, unique: false, defaultValue: null, validateMessage: '', datePrecision: 'day' },
    { key: 'f_currency', type: 'select', label: '币种', required: true, unique: false, defaultValue: 'CNY', validateMessage: '',
      options: [{ label: '人民币', value: 'CNY' }, { label: '美元', value: 'USD' }, { label: '欧元', value: 'EUR' }] },
    { key: 'f_amount', type: 'number', label: '订单金额', required: true, unique: false, defaultValue: null, validateMessage: '订单金额不能为负数', unit: '元', min: 0, max: 1000000000 },
    { key: 'f_delivery', type: 'textarea', label: '交付要求', required: false, unique: false, defaultValue: '', validateMessage: '', maxLength: 500 },
    { key: 'f_contract', type: 'attachment', label: '合同附件', required: false, unique: false, defaultValue: null, validateMessage: '', maxCount: 3, accept: '' },
    {
      key: 'f_lines', type: 'subform', label: '订单明细', required: true, unique: false, defaultValue: null, validateMessage: '至少填写一行订单明细',
      children: [
        { key: 'f_goods', type: 'text', label: '商品名称', required: true, unique: false, defaultValue: '', validateMessage: '', maxLength: 80 },
        { key: 'f_line_qty', type: 'number', label: '数量', required: true, unique: false, defaultValue: 1, validateMessage: '数量必须大于 0', unit: '', min: 1, max: 99999 },
        { key: 'f_line_price', type: 'number', label: '单价', required: true, unique: false, defaultValue: null, validateMessage: '单价不能小于 0', unit: '元', min: 0, max: 100000000 },
      ],
    },
  ],
  // 4. 门店日巡检
  inspect: [
    { key: 'f_store_name', type: 'text', label: '门店名称', required: true, unique: false, defaultValue: '', validateMessage: '请填写巡检门店全称', maxLength: 60 },
    { key: 'f_inspect_date', type: 'date', label: '巡检日期', required: true, unique: false, defaultValue: null, validateMessage: '', datePrecision: 'day' },
    { key: 'f_inspector', type: 'select', label: '巡检员', required: true, unique: false, defaultValue: 'u01', validateMessage: '',
      options: [{ label: '张巡检', value: 'u01' }, { label: '李督查', value: 'u02' }, { label: '王经理', value: 'u03' }] },
    { key: 'f_overall_score', type: 'number', label: '整体评分', required: true, unique: false, defaultValue: 90, validateMessage: '评分范围 0~100 分', unit: '分', min: 0, max: 100 },
    { key: 'f_tags', type: 'multiselect', label: '问题标签', required: false, unique: false, defaultValue: [], validateMessage: '',
      options: [{ label: '陈列', value: 'display' }, { label: '卫生', value: 'hygiene' }, { label: '库存', value: 'stock' }, { label: '服务', value: 'service' }, { label: '安全', value: 'safety' }] },
    { key: 'f_summary', type: 'textarea', label: '巡检说明', required: false, unique: false, defaultValue: '', validateMessage: '', maxLength: 1000 },
    { key: 'f_photos', type: 'attachment', label: '现场照片', required: false, unique: false, defaultValue: null, validateMessage: '最多上传 5 张照片', maxCount: 5, accept: 'image/*' },
    {
      key: 'f_issues', type: 'subform', label: '问题清单', required: false, unique: false, defaultValue: null, validateMessage: '',
      children: [
        { key: 'f_issue_desc', type: 'text', label: '问题描述', required: true, unique: false, defaultValue: '', validateMessage: '', maxLength: 120 },
        { key: 'f_level', type: 'select', label: '严重级别', required: true, unique: false, defaultValue: 'mid', validateMessage: '',
          options: [{ label: '高', value: 'high' }, { label: '中', value: 'mid' }, { label: '低', value: 'low' }] },
        { key: 'f_deadline', type: 'date', label: '整改期限', required: false, unique: false, defaultValue: null, validateMessage: '', datePrecision: 'day' },
      ],
    },
  ],
  // 5. 物料申领
  material: [
    { key: 'f_applicant', type: 'text', label: '申领人', required: true, unique: false, defaultValue: '', validateMessage: '请填写申领人姓名', maxLength: 20 },
    { key: 'f_m_dept', type: 'select', label: '申领部门', required: true, unique: false, defaultValue: 'tech', validateMessage: '',
      options: [{ label: '技术部', value: 'tech' }, { label: '销售部', value: 'sales' }, { label: '人事部', value: 'hr' }, { label: '财务部', value: 'finance' }] },
    { key: 'f_apply_month', type: 'date', label: '申领月份', required: true, unique: false, defaultValue: null, validateMessage: '只填到月份即可（YYYY-MM）', datePrecision: 'month' },
    { key: 'f_expect_date', type: 'date', label: '期望到货日期', required: false, unique: false, defaultValue: null, validateMessage: '', datePrecision: 'day' },
    { key: 'f_remark', type: 'textarea', label: '备注', required: false, unique: false, defaultValue: '', validateMessage: '', maxLength: 300 },
    {
      key: 'f_items', type: 'subform', label: '物料明细', required: true, unique: false, defaultValue: null, validateMessage: '至少填写一种申领物料',
      children: [
        { key: 'f_material_name', type: 'text', label: '物料名称', required: true, unique: false, defaultValue: '', validateMessage: '', maxLength: 60 },
        { key: 'f_m_qty', type: 'number', label: '数量', required: true, unique: false, defaultValue: 1, validateMessage: '申领数量至少 1 件', unit: '件', min: 1, max: 9999 },
        { key: 'f_usage', type: 'text', label: '用途', required: false, unique: false, defaultValue: '', validateMessage: '', maxLength: 100 },
      ],
    },
  ],
};

function pad(n) { return String(n).padStart(2, '0'); }
function isoDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function daysAgo(n, hour = 10) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, (n * 13) % 60, 0, 0);
  return d;
}

const pick = (arr, i) => arr[i % arr.length];

export function buildSeed() {
  const apps = [
    { name: '行政办公', description: '请假、报销、考勤等内部行政流程', icon: 'office' },
    { name: '销售管理', description: '客户拜访、订单录入等销售业务', icon: 'sales' },
    { name: '门店运营', description: '门店巡检、物料申领等运营事务', icon: 'store' },
  ];

  // 每张表的 30 条数据生成器：分布 8 / 6 / 6 / 6 / 4
  const leaveData = [];
  const names = ['陈晨', '李雷', '韩梅梅', '王浩', '赵敏', '孙杰', '周倩', '吴迪'];
  const depts = ['tech', 'sales', 'hr', 'finance'];
  const ltypes = ['annual', 'personal', 'sick', 'comp'];
  for (let i = 0; i < 8; i++) {
    const start = daysAgo(i, 9);
    const end = new Date(start); end.setDate(end.getDate() + (i % 3) + 1);
    leaveData.push({
      f_emp_no: `100123${pad(i + 1)}`,
      f_name: names[i], f_dept: depts[i % 4], f_leave_type: ltypes[i % 4],
      f_days: pick([1, 2, 0.5, 3, 5, 1, 2, 10], i),
      f_start_date: isoDate(start), f_end_date: isoDate(end),
      f_reason: pick(['家中有事，需请假处理', '年度旅游休息', '感冒发烧需休养', '项目调休'], i),
      f_cert: [],
      f_handover: i % 2 === 0
        ? [{ f_item: '周报汇总', f_person: '同事甲', f_status: pick(['done', 'doing', 'todo'], i) }]
        : [],
      _ago: i % 3 === 0 ? 0 : (i % 5) + 1,
    });
  }

  const visitData = [];
  const customers = ['星辰科技', '海东银行', '长虹制造', '云启教育', '明远集团', '金桥金服'];
  const industries = ['internet', 'finance', 'manufacture', 'edu'];
  for (let i = 0; i < 6; i++) {
    const d = daysAgo(i, 14);
    visitData.push({
      f_customer_name: customers[i], f_industry: industries[i % 4],
      f_visit_month: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`,
      f_score: pick([5, 4, 3, 5, 4, 2], i),
      f_contacts: i % 2 ? ['visit', 'phone'] : ['visit'],
      f_note: pick(['客户对旗舰版很感兴趣', '预算待 Q4 审批', '需要再安排一次技术交流', '决策人休假，下月跟进'], i),
      f_products: [{ f_product: pick(['CRM 专业版', '数据分析平台', '营销云'], i), f_qty: (i % 3) + 1, f_price: pick([128000, 86000, 52000], i) }],
      _ago: i % 2 === 0 ? 0 : (i % 4) + 1,
    });
  }

  const orderData = [];
  for (let i = 0; i < 6; i++) {
    const d = daysAgo(i, 11);
    orderData.push({
      f_order_no: `SO-2026-${pad(i + 1)}0${pad(i + 2)}`,
      f_customer: customers[(i + 2) % customers.length],
      f_order_date: isoDate(d),
      f_currency: pick(['CNY', 'CNY', 'USD', 'CNY'], i),
      f_amount: pick([58000, 126000, 9800, 332000, 7600, 210000], i),
      f_delivery: pick(['30 天内交付', '分两批交付', '需现场实施', ''], i),
      f_contract: [],
      f_lines: [
        { f_goods: pick(['软件许可-标准版', '实施服务包', '扩展模块', '年度维保'], i), f_line_qty: (i % 3) + 1, f_line_price: pick([20000, 8000, 50000], i) },
      ],
      _ago: i % 3,
    });
  }

  const inspectData = [];
  const stores = ['南京西路店', '陆家嘴店', '天河城店', '武侯祠店', '西湖银泰店', '中关村店'];
  for (let i = 0; i < 6; i++) {
    const d = daysAgo(i, 16);
    inspectData.push({
      f_store_name: stores[i], f_inspect_date: isoDate(d),
      f_inspector: pick(['u01', 'u02', 'u03'], i),
      f_overall_score: pick([95, 88, 76, 92, 65, 84], i),
      f_tags: pick([['display'], ['hygiene', 'stock'], ['service'], [], ['safety', 'hygiene'], ['display', 'service']], i),
      f_summary: pick(['整体良好，个别陈列需调整', '库房补货不及时', '员工服务规范到位', '消防通道堆物，需立即整改'], i),
      f_photos: [],
      f_issues: i % 2 === 0
        ? [{ f_issue_desc: pick(['货架价签缺失', '后场堆放杂物', '试衣间卫生不达标'], i), f_level: pick(['mid', 'high', 'low'], i), f_deadline: isoDate(daysAgo(i - 3 > 0 ? i - 3 : 0, 12)) }]
        : [],
      _ago: i % 2 === 0 ? 0 : (i % 3) + 1,
    });
  }

  const materialData = [];
  const materials = [
    [['A4 打印纸', 10, '日常打印'], ['签字笔', 20, '办公领用']],
    [['千兆交换机', 2, '机房扩容'], ['六类网线', 5, '工位布线']],
    [['清洁剂', 8, '门店保洁'], ['洗手液', 12, '门店保洁']],
    [['笔记本电脑', 1, '新员工入职']],
  ];
  for (let i = 0; i < 4; i++) {
    const d = daysAgo(i, 13);
    materialData.push({
      f_applicant: names[(i + 3) % names.length],
      f_m_dept: depts[i % 4],
      f_apply_month: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`,
      f_expect_date: isoDate(new Date(d.getTime() + 5 * 86400000)),
      f_remark: i === 3 ? '新员工下周一入职，请优先安排' : '',
      f_items: materials[i].map(([name, qty, usage]) => ({ f_material_name: name, f_m_qty: qty, f_usage: usage })),
      _ago: i === 0 ? 0 : (i % 4) + 1,
    });
  }

  return { apps, formData: [leaveData, visitData, orderData, inspectData, materialData] };
}

export async function runSeed() {
  await migrate();
  await ensureUploadDir();

  await pool.query(`TRUNCATE TABLE validation_errors, flow_actions, flow_tasks, flow_instances,
                    submission_revisions, submissions, flows, form_views,
                    attachments, forms, apps RESTART IDENTITY CASCADE`);

  // 两个示例附件（供填报/数据展示使用）
  const files = [
    { name: 'sample-cert.txt', stored: `seed-${Date.now()}-cert.txt`, mime: 'text/plain', body: '示例：医院诊断证明（种子数据占位文件）\n' },
    { name: 'sample-contract.txt', stored: `seed-${Date.now()}-contract.txt`, mime: 'text/plain', body: '示例：销售合同（种子数据占位文件）\n' },
  ];
  const attachIds = [];
  for (const f of files) {
    await writeFile(path.join(config.uploadDir, f.stored), f.body, 'utf8');
    const { rows } = await pool.query(
      `INSERT INTO attachments(stored_name, origin_name, mime_type, size_bytes) VALUES ($1,$2,$3,$4) RETURNING id`,
      [f.stored, f.name, f.mime, Buffer.byteLength(f.body)],
    );
    attachIds.push(rows[0].id);
  }

  const { apps: appDefs, formData } = buildSeed();
  const appIds = [];
  for (const a of appDefs) {
    const { rows } = await pool.query(
      `INSERT INTO apps(name, description, icon) VALUES ($1,$2,$3) RETURNING id`,
      [a.name, a.description, a.icon],
    );
    appIds.push(rows[0].id);
  }

  const formDefs = [
    { appIdx: 0, name: '员工请假申请', description: '员工在线提交请假与工作交接', schema: SCHEMAS.leave },
    { appIdx: 1, name: '客户拜访记录', description: '记录客户拜访与意向产品', schema: SCHEMAS.visit },
    { appIdx: 1, name: '销售订单录入', description: '录入销售订单与明细行', schema: SCHEMAS.order },
    { appIdx: 2, name: '门店日巡检', description: '门店每日巡检与问题整改跟踪', schema: SCHEMAS.inspect },
    { appIdx: 2, name: '物料申领', description: '办公与运营物料申领登记', schema: SCHEMAS.material },
  ];
  const formIds = [];
  for (const f of formDefs) {
    const { rows } = await pool.query(
      `INSERT INTO forms(app_id, name, description, field_schema) VALUES ($1,$2,$3,$4::jsonb) RETURNING id`,
      [appIds[f.appIdx], f.name, f.description, JSON.stringify(f.schema)],
    );
    formIds.push(rows[0].id);
  }

  // 30 条提交（8+6+6+6+4），时间分散在近 7 天、含今日；均为挂流程前的历史直收单据
  const creators = ['u20', 'u21', 'u22', 'u23'];
  let total = 0;
  for (let fi = 0; fi < formData.length; fi++) {
    for (const row of formData[fi]) {
      const ago = row._ago;
      const clean = { ...row };
      delete clean._ago;
      // 给前两条请假/订单挂上示例附件
      if (fi === 0 && total < 2) clean.f_cert = [{ id: attachIds[0] }];
      if (fi === 2 && total % 6 === 0) clean.f_contract = [{ id: attachIds[1] }];
      await pool.query(
        `INSERT INTO submissions(form_id, form_ver, data, status, created_by, created_at)
         VALUES ($1,1,$2::jsonb,'submitted', $3, $4)`,
        [formIds[fi], JSON.stringify(clean), creators[total % creators.length], daysAgo(ago, 9 + (total % 8))],
      );
      total++;
    }
  }

  const viewDefs = [
    { formIdx: 0, name: '请假台账', columns: ['f_emp_no', 'f_name', 'f_dept', 'f_leave_type', 'f_days', 'f_start_date'], filter: 'f_dept' },
    { formIdx: 1, name: '客户列表', columns: ['f_customer_name', 'f_industry', 'f_visit_month', 'f_score'], filter: 'f_industry' },
    { formIdx: 2, name: '订单台账', columns: ['f_order_no', 'f_customer', 'f_order_date', 'f_currency', 'f_amount'], filter: 'f_currency' },
    { formIdx: 3, name: '巡检台账', columns: ['f_store_name', 'f_inspect_date', 'f_inspector', 'f_overall_score'], filter: 'f_inspector' },
    { formIdx: 4, name: '申领汇总', columns: ['f_applicant', 'f_m_dept', 'f_apply_month'], filter: 'f_m_dept' },
  ];
  for (const v of viewDefs) {
    await pool.query(
      `INSERT INTO form_views(app_id, form_id, name, column_fields, filter_field)
       VALUES ($1,$2,$3,$4::jsonb,$5)`,
      [appIds[formDefs[v.formIdx].appIdx], formIds[v.formIdx], v.name, JSON.stringify(v.columns), v.filter],
    );
  }

  // 校验失败热点：近 7 天内各字段的失败记录（今日也有），集中在几个字段
  const hotspotDefs = [
    { formIdx: 0, key: 'f_days', label: '请假天数', code: 'MAX', msg: '请假天数需在 0.5~30 天之间', n: 9 },
    { formIdx: 0, key: 'f_reason', label: '请假事由', code: 'REQUIRED', msg: '请写明请假事由，便于主管审批', n: 6 },
    { formIdx: 2, key: 'f_amount', label: '订单金额', code: 'MIN', msg: '订单金额不能为负数', n: 7 },
    { formIdx: 1, key: 'f_products.f_qty', label: '意向产品 / 数量', code: 'MIN', msg: '数量至少为 1', n: 5 },
    { formIdx: 3, key: 'f_overall_score', label: '整体评分', code: 'MAX', msg: '评分范围 0~100 分', n: 4 },
    { formIdx: 4, key: 'f_items.f_m_qty', label: '物料明细 / 数量', code: 'MIN', msg: '申领数量至少 1 件', n: 3 },
    { formIdx: 0, key: 'f_emp_no', label: '工号', code: 'UNIQUE', msg: '工号不能与他人重复', n: 2 },
  ];
  for (const h of hotspotDefs) {
    for (let i = 0; i < h.n; i++) {
      const ago = i === 0 ? 0 : (i % 6); // 约 1/3 落在今日附近之外，其余分布一周
      await pool.query(
        `INSERT INTO validation_errors(form_id, field_key, field_label, error_code, message, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [formIds[h.formIdx], h.key, h.label, h.code, h.msg, daysAgo(ago, 17 + i)],
      );
    }
  }

  // 真实审批流（串行/条件分支/会签/两种退回/改单重提/换版本），并驱动出 9 个多状态实例
  const flowSeed = await seedFlows(pool, { appIds, formIds });

  return { appIds, formIds, totalSubmissions: total, attachments: attachIds, flowSeed };
}

// 直接执行：npm run seed
if (import.meta.url === `file://${process.argv[1]}`) {
  runSeed()
    .then((r) => {
      console.log('种子数据写入完成：');
      console.log(`  应用 ${r.appIds.length} 个，表单 ${r.formIds.length} 张，填报 ${r.totalSubmissions} 条，附件 ${r.attachments.length} 个`);
      return pool.end();
    })
    .catch((e) => {
      console.error('种子写入失败:', e);
      process.exitCode = 1;
    });
}
