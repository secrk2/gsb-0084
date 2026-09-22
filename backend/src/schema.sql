-- 积木低代码平台 建表脚本（幂等）

CREATE TABLE IF NOT EXISTS apps (
  id          BIGSERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon        VARCHAR(32) NOT NULL DEFAULT 'app',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS forms (
  id          BIGSERIAL PRIMARY KEY,
  app_id      BIGINT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name        VARCHAR(100) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- field_schema: 字段元数据数组，结构见后端 FieldMeta 约定
  field_schema JSONB NOT NULL DEFAULT '[]'::jsonb,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_forms_app ON forms(app_id);

CREATE TABLE IF NOT EXISTS submissions (
  id         BIGSERIAL PRIMARY KEY,
  form_id    BIGINT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  form_ver   INTEGER NOT NULL DEFAULT 1,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- submitted（无流程/直接收数）| in_approval | returned | approved | rejected
  status     VARCHAR(16) NOT NULL DEFAULT 'submitted',
  created_by VARCHAR(64) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sub_form ON submissions(form_id);
CREATE INDEX IF NOT EXISTS idx_sub_created ON submissions(created_at);

-- 校验失败明细（表单提交时 422 的字段级记录，用于应用动态热点）
CREATE TABLE IF NOT EXISTS validation_errors (
  id           BIGSERIAL PRIMARY KEY,
  form_id      BIGINT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  field_key    VARCHAR(128) NOT NULL,
  field_label  VARCHAR(200) NOT NULL DEFAULT '',
  error_code   VARCHAR(32) NOT NULL,
  message      VARCHAR(300) NOT NULL DEFAULT '',
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ve_form_time ON validation_errors(form_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_ve_field ON validation_errors(field_key);

-- 审批流定义（草稿/版本化）。同一张表单至多一条 active：部分唯一索引兜底。
-- definition 为阶段数组，结构见 backend/src/flow/engine.js 顶部注释
CREATE TABLE IF NOT EXISTS flows (
  id              BIGSERIAL PRIMARY KEY,
  app_id          BIGINT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  form_id         BIGINT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  name            VARCHAR(100) NOT NULL,
  definition      JSONB NOT NULL DEFAULT '[]'::jsonb,
  version         INTEGER NOT NULL DEFAULT 1,
  -- draft 草稿 | active 生效中 | archived 已被新版本替换/停用
  status          VARCHAR(16) NOT NULL DEFAULT 'draft',
  published_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 旧版引用拦截用字段（保留并由 definition 派生填充）
  trigger_field   VARCHAR(128),
  condition_field VARCHAR(128),
  approver_field  VARCHAR(128)
);
-- 老库升级（首次建表时这些列已在上面的 CREATE 中；旧库由 ALTER 补齐）。必须先加列再建索引。
ALTER TABLE flows ADD COLUMN IF NOT EXISTS definition JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS status VARCHAR(16) NOT NULL DEFAULT 'draft';
ALTER TABLE flows ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_flows_form ON flows(form_id);
-- 同一张表单只能有一条生效流程（NULL 不参与唯一约束）
CREATE UNIQUE INDEX IF NOT EXISTS uq_flows_active_per_form
  ON flows(form_id) WHERE status = 'active';

-- 流程实例：一条提交单据对应一条
CREATE TABLE IF NOT EXISTS flow_instances (
  id              BIGSERIAL PRIMARY KEY,
  flow_id         BIGINT NOT NULL REFERENCES flows(id) ON DELETE RESTRICT,
  submission_id   BIGINT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  form_id         BIGINT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  -- running | approved | rejected（退回发起人不改终态，仍为 running 并由 current_stage=-1 标记）
  status          VARCHAR(16) NOT NULL DEFAULT 'running',
  -- 当前激活阶段下标（退回发起人时为 -1，表示停在发起人待修改重提）
  current_stage   INTEGER NOT NULL DEFAULT 0,
  -- 按提交时数据展开的实际执行路径 [{stage_idx, branch_idx, node}]；退回发起人后重提按新数据重建
  active_path     JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- 当前停在 active_path 中的第几个节点（退回发起人时为 -1）
  node_cursor     INTEGER NOT NULL DEFAULT 0,
  -- 节点激活批次：每进入一个节点 +1，用于区分同一节点的多次激活（退回上节点再通过）
  batch_no        INTEGER NOT NULL DEFAULT 0,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fi_submission ON flow_instances(submission_id);
CREATE INDEX IF NOT EXISTS idx_fi_flow ON flow_instances(flow_id);
CREATE INDEX IF NOT EXISTS idx_fi_form ON flow_instances(form_id);

-- 节点审批任务（串行节点同批同时只有 1 个 pending；会签节点同批 N 个）
CREATE TABLE IF NOT EXISTS flow_tasks (
  id              BIGSERIAL PRIMARY KEY,
  instance_id     BIGINT NOT NULL REFERENCES flow_instances(id) ON DELETE CASCADE,
  stage_idx       INTEGER NOT NULL,
  branch_idx      INTEGER,          -- 条件分支内为分支下标，普通阶段为 NULL
  node_id         VARCHAR(64) NOT NULL,
  node_name       VARCHAR(100) NOT NULL DEFAULT '',
  -- 该任务在节点审批人序列中的位置（会签全部同批下发，串行按 seq 逐个下发）
  seq             INTEGER NOT NULL DEFAULT 0,
  batch_no        INTEGER NOT NULL DEFAULT 0,
  assignee        VARCHAR(64) NOT NULL,
  -- pending | approved | rejected | returned | skipped | cancelled
  -- cancelled=批次作废（他人退回/驳回导致）；skipped=会签节点因整批终止而未处理
  status          VARCHAR(16) NOT NULL DEFAULT 'pending',
  comment         VARCHAR(500) NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  acted_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ft_instance ON flow_tasks(instance_id);
CREATE INDEX IF NOT EXISTS idx_ft_assignee_status ON flow_tasks(assignee, status);

-- 审批操作流水（提交/通过/退回发起人/退回上节点/重提/终态）
CREATE TABLE IF NOT EXISTS flow_actions (
  id              BIGSERIAL PRIMARY KEY,
  instance_id     BIGINT NOT NULL REFERENCES flow_instances(id) ON DELETE CASCADE,
  action          VARCHAR(24) NOT NULL,
  actor           VARCHAR(64) NOT NULL DEFAULT '',
  node_name       VARCHAR(100) NOT NULL DEFAULT '',
  comment         VARCHAR(500) NOT NULL DEFAULT '',
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fa_instance ON flow_actions(instance_id, id);

-- 单据内容版本：每次提交/退回后重提各存一份快照，并与上一版做字段级 diff
CREATE TABLE IF NOT EXISTS submission_revisions (
  id              BIGSERIAL PRIMARY KEY,
  submission_id   BIGINT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  revision        INTEGER NOT NULL,
  data            JSONB NOT NULL DEFAULT '{}'::jsonb,
  change_summary  JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{path,label,before,after}]
  created_by      VARCHAR(64) NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sr_submission ON submission_revisions(submission_id, revision);

-- 视图对字段的引用（引用内容为字段 key 数组）
CREATE TABLE IF NOT EXISTS form_views (
  id          BIGSERIAL PRIMARY KEY,
  app_id      BIGINT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name        VARCHAR(100) NOT NULL,
  form_id     BIGINT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  column_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  filter_field  VARCHAR(128),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS attachments (
  id          BIGSERIAL PRIMARY KEY,
  stored_name VARCHAR(255) NOT NULL,
  origin_name VARCHAR(255) NOT NULL,
  mime_type   VARCHAR(150) NOT NULL DEFAULT '',
  size_bytes  BIGINT NOT NULL DEFAULT 0,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
