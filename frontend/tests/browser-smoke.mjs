// 浏览器端到端：嵌入式 PG + 真实后端 + Vite + Playwright Chromium
// 运行：node tests/browser-smoke.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.JIMU_PG_PORT = '54420';
process.env.JIMU_PG_DB = 'jimu_ui';
process.env.DATABASE_URL = 'postgres://jimu:jimu@127.0.0.1:54420/jimu_ui';
process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), 'jimu-ui-up-'));
process.env.CACHE_TTL = '0';

const BE = '/workspace/backend';
const { startTestPg } = await import(`${BE}/tests/helpers/embedded-pg.js`);
const pg = await startTestPg();
const { runSeed } = await import(`${BE}/src/seed.js`);
await runSeed();
const { createApp, prepareStorage } = await import(`${BE}/src/app.js`);
await prepareStorage();
const server = createApp().listen(3000);
await new Promise((r) => server.once('listening', r));

const vite = spawn('npx', ['vite', '--port', '5199', '--strictPort'], {
  cwd: '/workspace/frontend', shell: true, stdio: 'ignore',
});
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch('http://localhost:5199/');
    if (r.ok) break;
  } catch { /* 等待启动 */ }
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.launch({
  env: {
    ...process.env,
    LD_LIBRARY_PATH: [
      '/tmp/chromedeps/extracted/usr/lib/x86_64-linux-gnu',
      '/tmp/chromedeps/extracted/lib/x86_64-linux-gnu',
      '/home/node/.local/chromelibs/root/usr/lib/x86_64-linux-gnu',
      '/home/node/.local/chromelibs/root/lib/x86_64-linux-gnu',
      process.env.LD_LIBRARY_PATH,
    ].filter(Boolean).join(':'),
    FONTCONFIG_FILE: '/home/node/.local/chromelibs/fonts.conf',
    HOME: process.env.HOME,
  },
});
const pageErrors = [];
const consoleErrors = [];
process.on('exit', () => {
  if (pageErrors.length || consoleErrors.length) {
    console.log('--- 浏览器侧错误 ---');
    pageErrors.forEach((e) => console.log('PAGEERROR:', e));
    consoleErrors.forEach((e) => console.log('CONSOLE:', e));
  }
});
let failures = 0;
function check(name, cond) {
  console.log(`${cond ? '✅' : '❌'} ${name}`);
  if (!cond) failures += 1;
}

try {
  // ---------- 桌面：应用动态 ----------
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await page.goto('http://localhost:5199/activity');
  await page.waitForSelector('.kpi');
  await page.screenshot({ path: '/tmp/jimu-shots/01-desktop-activity.png', fullPage: true });
  const kpiText = await page.locator('.kpi-grid').innerText();
  check('桌面-看板含应用数 3', kpiText.includes('应用数') && kpiText.includes('\n3'));
  check('桌面-看板含表单数 5', /表单数[\s\S]*\n5/.test(kpiText));
  check('桌面-看板含今日提交量', kpiText.includes('今日提交量'));
  const hot = await page.locator('.bar-row').first().innerText();
  check('桌面-校验失败热点首位是请假天数', hot.includes('请假天数'));

  // ---------- 桌面：设计器删除被引用字段被拦 ----------
  await page.goto('http://localhost:5199/forms/1/design');
  await page.waitForSelector('.canvas-field');
  // 点选「请假天数」字段使其选中（工具条出现）
  const daysField = page.locator('.canvas-field', { hasText: '请假天数' }).first();
  await daysField.click();
  await daysField.locator('.cf-btn[title="删除"]').click();
  await page.waitForSelector('.modal-mask .ref-list', { timeout: 5000 });
  const modalText = await page.locator('.modal').innerText();
  check('桌面-删除引用字段被拦且说明被谁引用', modalText.includes('不能删除') && modalText.includes('请假审批流'));
  await page.screenshot({ path: '/tmp/jimu-shots/02-desktop-refblock.png' });
  await page.locator('.modal-foot .btn').click();

  // ---------- 桌面：预览填报 + 子表单增删行不丢数据 ----------
  await page.goto('http://localhost:5199/forms/1/fill');
  await page.waitForSelector('.sf-table');
  // 按字段顺序定位填写
  const inputs = page.locator('.fill-wrap .input, .fill-wrap .textarea, .fill-wrap .select');
  await page.locator('.fill-wrap input.input').first().fill('99999001'); // 工号
  await page.locator('.fill-wrap input.input').nth(1).fill('浏览器测试员'); // 姓名
  await page.locator('.fill-wrap select.select').first().selectOption('tech'); // 部门
  await page.locator('.fill-wrap select.select').nth(1).selectOption('annual'); // 请假类型
  await page.locator('.fill-wrap input[type="number"]').first().fill('2'); // 天数
  await page.locator('.fill-wrap input[type="date"]').first().fill('2026-09-20');
  await page.locator('.fill-wrap textarea').first().fill('浏览器自动化测试：家中有事');

  // 子表单：加两行，分别填不同内容
  await page.getByRole('button', { name: '＋ 添加一行' }).click();
  await page.locator('.sf-table tbody tr').first().locator('input').first().fill('周报汇总');
  await page.getByRole('button', { name: '＋ 添加一行' }).click();
  const rowsLocator = page.locator('.sf-table tbody tr');
  check('子表单-已加出两行', (await rowsLocator.count()) === 2);
  await rowsLocator.nth(1).locator('input').first().fill('报销单据');
  // 删除第一行，第二行填的内容必须还在
  await rowsLocator.first().locator('.sf-del').click();
  const leftRows = page.locator('.sf-table tbody tr');
  check('子表单-删行后剩一行', (await leftRows.count()) === 1);
  const keptVal = await leftRows.first().locator('input').first().inputValue();
  check('子表单-删除其它行后已填内容不丢失', keptVal === '报销单据');
  await page.screenshot({ path: '/tmp/jimu-shots/03-desktop-fill-subform.png' });

  await page.getByRole('button', { name: /提交一条数据/ }).click();
  await page.waitForSelector('text=提交成功', { timeout: 5000 });
  check('桌面-合法提交成功入库', await page.locator('text=提交成功').first().isVisible());

  // 校验失败路径：天数填 999 且清空事由
  await page.locator('.fill-wrap input[type="number"]').first().fill('999');
  await page.locator('.fill-wrap textarea').first().fill('');
  await page.getByRole('button', { name: /提交一条数据/ }).click();
  await page.waitForSelector('.field-error', { timeout: 5000 });
  const errText = await page.locator('.card').first().innerText();
  check('桌面-越界+必填 422 内联展示', errText.includes('未通过校验'));
  check('桌面-展示自定义校验提示', await page.locator('.field-error', { hasText: '0.5~30' }).first().isVisible());

  // ---------- 桌面：流程设计器（金额分支 + 财务会签） ----------
  await page.goto('http://localhost:5199/forms/3/flow');
  await page.waitForSelector('.flow-canvas');
  const branchVal = await page.locator('.branch-label').first().inputValue();
  const nodeVals = await page.locator('.fn-name').evaluateAll((els) => els.map((e) => e.value));
  check('流程设计器-展示金额分支条件', branchVal.includes('金额超过 1 万'));
  check('流程设计器-展示财务会签节点', nodeVals.some((v) => v.includes('财务会签')));
  check('流程设计器-标注当前生效版本', await page.locator('.flow-side').innerText().then((t) => t.includes('当前生效')));
  await page.screenshot({ path: '/tmp/jimu-shots/07-desktop-flow-design.png', fullPage: true });

  // ---------- 桌面：审批中心待办（吴迪有大单会签待签，周倩已签） ----------
  await page.locator('.identity-box select').selectOption('u_wudi');
  await page.goto('http://localhost:5199/approvals');
  await page.waitForSelector('.todo-card');
  const todoText = await page.locator('.todo-card').first().innerText();
  check('审批中心-显示财务会签节点', todoText.includes('财务会签'));
  check('审批中心-显示已停留时长', /已停留/.test(todoText));
  check('审批中心-会签共 2 人、剩我 1 人未签', /待签\s*1\s*人/.test(todoText));
  await page.screenshot({ path: '/tmp/jimu-shots/08-desktop-approvals.png', fullPage: true });

  // 进入实例详情：节点进度 + 时间线
  await page.locator('.todo-card a', { hasText: '查看详情' }).first().click();
  await page.waitForSelector('.timeline');
  const detailText = await page.locator('.page').innerText();
  check('实例详情-显示当前停在财务会签', detailText.includes('当前停在：财务会签'));
  check('实例详情-时间线含分支选路', detailText.includes('条件分支选路'));
  check('实例详情-会签两人（周倩已通过、吴迪待处理）', detailText.includes('周倩') && detailText.includes('吴迪'));
  await page.screenshot({ path: '/tmp/jimu-shots/09-desktop-instance.png', fullPage: true });

  // 吴迪通过（详情页用意见输入框，无弹窗）→ 会签齐人，流程完成
  await page.getByRole('button', { name: '✓ 通过' }).click();
  await page.waitForSelector('text=全部节点通过', { timeout: 5000 });
  check('实例详情-会签最后一人通过后流程完成', await page.locator('.page').innerText().then((t) => t.includes('全部节点通过')));

  // 退回重提实例（种子 #3）：第 2 轮、修改留痕改前改后可查
  await page.goto('http://localhost:5199/instances/3');
  await page.waitForSelector('.revision-card');
  const revText = await page.locator('.revision-card').innerText();
  check('修改留痕-显示改前内容', revText.includes('有事'));
  check('修改留痕-显示改后内容', revText.includes('家中急事'));
  check('实例列表-第 2 轮标识', await page.locator('.page').innerText().then((t) => t.includes('第 2 轮')));
  await page.getByText('查看改前 / 改后完整数据快照').click();
  check('修改留痕-可展开完整快照', await page.locator('.snapshot-box').first().isVisible());
  await page.screenshot({ path: '/tmp/jimu-shots/10-desktop-revision.png', fullPage: true });

  // 实例列表：当前节点/待办人/停留时长列齐全
  await page.goto('http://localhost:5199/instances');
  await page.waitForSelector('.list-table tbody tr');
  const listText = await page.locator('.list-table').innerText();
  check('实例列表-含已停留列', listText.includes('已停留'));
  check('实例列表-含审批中状态', listText.includes('审批中'));
  await page.locator('.identity-box select').selectOption('u_chen'); // 还原身份

  // ---------- 平板：三栏设计器仍可用，看板单列 ----------
  await page.setViewportSize({ width: 820, height: 1100 });
  await page.goto('http://localhost:5199/activity');
  await page.waitForSelector('.two-col');
  await page.screenshot({ path: '/tmp/jimu-shots/04-tablet-activity.png' });
  const twoColCols = await page.locator('.two-col').evaluate((el) => getComputedStyle(el).gridTemplateColumns);
  check('平板-看板双栏退化为单列', twoColCols.split(' ').length === 1);
  await page.goto('http://localhost:5199/forms/1/design');
  await page.waitForSelector('.designer');
  check('平板-设计器仍可使用', await page.locator('.designer').isVisible());

  // ---------- 手机：能填不能设计 ----------
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://localhost:5199/forms/1/design');
  await page.waitForSelector('.mobile-block');
  check('手机-设计器被隐藏', !(await page.locator('.designer').isVisible()));
  check('手机-显示仅支持填报提示', await page.locator('text=手机端仅支持填报').isVisible());

  await page.goto('http://localhost:5199/forms/1/fill');
  await page.waitForSelector('.fill-wrap input');
  check('手机-填报页可正常使用', await page.locator('.fill-wrap').isVisible());
  await page.getByRole('button', { name: '＋ 添加一行' }).click();
  const sfDisplay = await page.locator('.sf-table tbody tr').first().evaluate((el) => getComputedStyle(el).display);
  check('手机-子表单表格退化为卡片行（block）', sfDisplay === 'block');
  await page.screenshot({ path: '/tmp/jimu-shots/05-mobile-fill.png', fullPage: true });

  await page.goto('http://localhost:5199/activity');
  await page.waitForSelector('.kpi');
  await page.screenshot({ path: '/tmp/jimu-shots/06-mobile-activity.png', fullPage: true });
  check('手机-看板 KPI 2 列', (await page.locator('.kpi-grid').evaluate((el) => getComputedStyle(el).gridTemplateColumns)).split(' ').length === 2);

  await ctx.close();
} catch (e) {
  console.error('脚本异常:', e);
  failures += 1;
} finally {
  await browser.close();
  vite.kill();
  server.close();
  const { pool } = await import(`${BE}/src/db.js`);
  await pool.end();
  await pg.stop();
  process.exit(failures ? 1 : 0);
}
