# 积木 Jimu · 低代码搭建平台

业务部门排队要小系统？用「积木」在线搭表单、收数据、看动态。
本轮交付 **表单设计** 与 **应用动态** 两个模块。

- 前端：Vue 3 + Vite + Vue Router
- 后端：Node.js + Express
- 元数据与填报数据：PostgreSQL（JSONB 存字段结构与填报内容）
- 缓存：Redis（应用动态看板，连接异常自动降级直查数据库）
- 入口：`http://localhost:8082`

---

## 一键启动（Docker Compose）

```bash
docker compose up -d --build
# 首次启动会自动建表并写入种子数据（3 应用 / 5 表单 / 30 提交）
```

打开 <http://localhost:8082> ：

- `/activity` 应用动态（首页）
- `/apps` 应用与表单 → 选应用 → 「✏️ 设计」或「👁 预览填报」

容器与端口：

| 服务 | 容器端口 | 宿主端口 | 说明 |
|---|---|---|---|
| frontend (nginx) | 80 | **8082** | 唯一入口，静态资源 + `/api` 反代 |
| backend (Express) | 3000 | 内部 | REST API |
| postgres:16 | 5432 | 5432 | 业务库 jimu |
| redis:7 | 6379 | 6379 | 看板缓存 |

重新灌种子：`docker compose exec backend node src/seed.js`（会清空业务表重建）。

## 本地开发（无 Docker）

```bash
# 1) PostgreSQL：建库
createdb jimu
# 2) Redis：本机 6379 起一个即可（没有也能跑，缓存自动降级）

# 后端
cd backend
npm install
DATABASE_URL=postgres://用户:密码@localhost:5432/jimu npm run seed
npm start                 # :3000

# 前端
cd frontend
npm install
npm run dev               # :5173，已配置 /api 代理到 :3000
```

后端单测（纯逻辑，无需数据库）：`cd backend && npm test`。

---

## 功能清单

### 表单设计

- **8 类字段**：单行文本、多行文本、数字（**单位 + 最小/最大取值范围**）、日期（**可只填到月 YYYY-MM**）、下拉单选、多选、附件（多文件上传）、**可增删行的子表单**（子字段支持文本/多行/数字/日期/单选/多选）。
- 每个字段可设：**必填、唯一（提交时查重）、默认值、自定义校验提示文案**；数字另设单位与范围，日期另设精度，附件限数量与类型，选项类在线维护选项。
- 三栏设计器：左侧字段库（点击/拖入）、中间画布（拖拽排序、复制、删除、子表单子字段增删排序）、右侧属性面板。
- **删除被引用字段会被拦下**：保存前调用引用检查，若字段被流程（触发条件/分支条件/审批人）或视图（列表列/筛选条件）引用，返回 **409** 并弹窗逐条说明「流程/视图『某某』的什么配置使用了字段『某某』」。整表覆盖保存同样走该检查，无法绕过。
- **保存并预览填报**：设计完一键跳到填报页，真实写入一条数据，立即在「应用动态」可见。
- 子表单选/填的增删行以稳定行 uid 渲染，**添加、删除任意一行，其它行已填内容不丢失**。

### 填报与校验

- 按元数据动态渲染，无数据无表单；提交后服务端按**当前版本字段元数据**重新校验（不信任前端）。
- 校验失败返回 422，错误定位到字段；**子表单错误精确到第几行的哪个字段**，页面红框 + 文案提示并滚动到首个错误。
- 校验同时写入 `validation_errors` 明细，作为看板热点的数据源。
- 必填为空 / 数字越界或非数字 / 日期格式与精度不符 / 选项不在候选内 / 附件超限或不存在 / 唯一值重复，均会被拦。

### 应用动态（首页）

- **应用数、表单数、今日提交量**（附今日校验失败数、累计提交量）。
- **校验失败集中在哪些字段**：近 7 天字段级失败 Top 榜（表单 + 字段名 + 次数条形），越靠前越该优化提示或规则。
- 近 7 天提交趋势（堆叠：成功/校验失败）、各应用今日提交对比、最近 15 条提交流水。
- 看板数据走 Redis 缓存（30 秒，可用 `CACHE_TTL=0` 关闭），Redis 不可用时自动降级直查。

### 预置数据

3 个应用（行政办公、销售管理、门店运营）、5 张表单（请假申请、客户拜访、销售订单、门店巡检、物料申领，覆盖全部字段类型与子表单）、**30 条填报**（分布在近 7 天含今日）、4 条流程与 5 个视图（制造引用拦截场景）、近 7 天校验失败热点数据、2 个示例附件。

---

## 响应式版式（桌面 / 平板 / 手机）

断点：桌面 `>1024px`，平板 `641–1024px`，手机 `≤640px`。

| 区域 | 桌面（≥1025px） | 平板（641–1024px） | 手机（≤640px） |
|---|---|---|---|
| 应用动态 | 4 个 KPI 一排；热点字段 + 右侧趋势/各应用双栏（约 5:4） | KPI 改 2×2；图表全部单列堆叠 | KPI 2×2 紧凑卡；图表单列；表格横向滚动；按钮通栏 |
| 应用/表单列表 | 应用卡片多列（每行约 4 个）；表单整行表格 | 应用卡片每行 2–3 个；表格同桌面 | 应用卡片单列；表格保留但可横滑；新建按钮通栏 |
| **表单设计器** | 三栏固定：字段库 220 / 画布自适应 / 属性 330，画布最大 680 居中 | 三栏收窄：180 / 自适应 / 300 | **不提供设计**：显示「手机端仅支持填报」提示与跳转按钮 |
| 预览填报 | 卡片最大宽 720 居中，提交栏吸底 | 同桌面，宽度收窄 | 全宽卡片，输入控件 44px 触控高度，提交栏吸底通栏 |
| 子表单 | 表格：表头 + 行内编辑，删除行在行尾 | 同桌面 | **表格退化为卡片行**：每个单元格独占一行并显示字段名标签，删除按钮悬浮行右上角 |
| 多选/附件 | 横排复选、附件列表 | 横排/自动换行 | 纵排，上传触发区通栏，附件项纵向排列 |

**手机上能填、不能设计**：设计器路由在 `≤640px` 整体隐藏并展示引导；填报功能在手机上完整可用（含附件上传与子表单增删行）。平板可设计（三栏压缩），也可填报。

---

## 字段元数据结构（JSONB）

```jsonc
{
  "key": "f_days",          // 字母开头的字段标识，同表唯一（含子字段）
  "type": "number",         // text|textarea|number|date|select|multiselect|attachment|subform
  "label": "请假天数",
  "required": true,
  "unique": false,          // 仅 text/number/date/select 可设
  "defaultValue": 1,
  "validateMessage": "请假天数需在 0.5~30 天之间",  // 留空用系统默认提示
  "unit": "天", "min": 0.5, "max": 30,             // number
  "datePrecision": "day",  // day | month（date）
  "options": [{"label":"年假","value":"annual"}],  // select/multiselect
  "maxCount": 3, "accept": "image/*",              // attachment
  "children": [ /* 仅 subform：嵌套同类字段结构 */ ]
}
```

填报数据按 `key` 存 JSONB：标量为原始值，多选/附件为数组，子表单为对象数组（附件数组元素为 `{id}` 引用 `attachments` 表）。

## 主要接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/apps` | 应用列表（含表单数/提交数/今日数） |
| GET/POST | `/api/forms?appId=` | 表单列表 / 新建 |
| GET/PUT | `/api/forms/:id` | 详情（含 field_schema）/ 整表更新（含引用拦截） |
| POST | `/api/forms/:id/fields/check-delete` | 删除前引用预检 |
| POST | `/api/forms/:id/fields/remove` | 删除字段（409 + 引用明细） |
| POST | `/api/submissions` | 填报提交（422 返回字段级 errors） |
| GET | `/api/submissions?formId=` | 某表单提交记录 |
| GET | `/api/activity/overview` | 看板汇总（Redis 缓存） |
| POST/GET | `/api/attachments`、`/api/attachments/:id` | 上传/下载附件 |

## 目录

```
docker-compose.yml          # 一次带起 frontend/backend/postgres/redis，8082
backend/   Express + pg + ioredis（src/fields.js 校验引擎、references.js 引用拦截、seed.js 种子）
frontend/  Vue3（views/Designer 设计器、Fill 填报、Activity 看板；components/DynamicForm 等）
```
