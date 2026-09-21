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
  status     VARCHAR(16) NOT NULL DEFAULT 'submitted',
  created_by VARCHAR(64) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sub_form ON submissions(form_id);
CREATE INDEX IF NOT EXISTS idx_sub_created ON submissions(created_at);
-- 老库升级：补填单人列
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS created_by VARCHAR(64) NOT NULL DEFAULT '';

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

-- 流程定义：一张表单最多一条「生效中」流程 + 一条草稿（部分唯一索引强制）
-- definition: {"nodes":[...]} 节点图，结构见 README「流程定义结构」
CREATE TABLE IF NOT EXISTS flows (
  id           BIGSERIAL PRIMARY KEY,
  app_id       BIGINT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  form_id      BIGINT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  name         VARCHAR(100) NOT NULL,
  status       VARCHAR(16) NOT NULL DEFAULT 'draft',  -- draft | published | archived
  version      INTEGER NOT NULL DEFAULT 1,
  trigger_rule JSONB,               -- {field, op, value} | null：满足才发起审批，空为全部发起
  definition   JSONB NOT NULL DEFAULT '{"nodes":[]}'::jsonb,
  published_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_flows_form ON flows(form_id);
-- 老库升级：从占位结构（trigger_field/condition_field/approver_field）迁移到定义结构
ALTER TABLE flows ADD COLUMN IF NOT EXISTS status VARCHAR(16) NOT NULL DEFAULT 'draft';
ALTER TABLE flows ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS trigger_rule JSONB;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS definition JSONB NOT NULL DEFAULT '{"nodes":[]}'::jsonb;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE flows DROP COLUMN IF EXISTS trigger_field;
ALTER TABLE flows DROP COLUMN IF EXISTS condition_field;
ALTER TABLE flows DROP COLUMN IF EXISTS approver_field;
-- 老库升级：旧版占位流程（无定义节点）一律归为历史版，避免与草稿唯一索引冲突
UPDATE flows SET status = 'archived'
  WHERE status = 'draft' AND COALESCE(definition, '{"nodes":[]}'::jsonb) = '{"nodes":[]}'::jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_flows_one_published ON flows(form_id) WHERE status = 'published';
CREATE UNIQUE INDEX IF NOT EXISTS uniq_flows_one_draft ON flows(form_id) WHERE status = 'draft';

-- 流程实例：一张提交单据对应一条实例；definition 为发起时的流程快照，
-- 换流程（重新发布）后在途单据仍按旧快照走完，新单据走新流程。
CREATE TABLE IF NOT EXISTS flow_instances (
  id                BIGSERIAL PRIMARY KEY,
  flow_id           BIGINT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  flow_version      INTEGER NOT NULL,
  form_id           BIGINT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  submission_id     BIGINT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  status            VARCHAR(16) NOT NULL DEFAULT 'running',  -- running | approved | returned
  current_node_key  VARCHAR(64),
  current_node_name VARCHAR(120) NOT NULL DEFAULT '',
  node_entered_at   TIMESTAMPTZ,          -- 进入当前节点的时间，列表「停留时长」据此计算
  round             INTEGER NOT NULL DEFAULT 1,  -- 退回后重新提交 +1
  definition        JSONB NOT NULL,     -- 发起时流程定义快照
  submitter         VARCHAR(64) NOT NULL DEFAULT '',
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  returned_at       TIMESTAMPTZ,
  return_comment    TEXT NOT NULL DEFAULT '',
  UNIQUE(submission_id)
);
CREATE INDEX IF NOT EXISTS idx_fi_form ON flow_instances(form_id, status);
CREATE INDEX IF NOT EXISTS idx_fi_flow ON flow_instances(flow_id);

-- 节点任务：会签（mode=all）时一个节点产生多条待办，全部通过才推进
CREATE TABLE IF NOT EXISTS flow_tasks (
  id          BIGSERIAL PRIMARY KEY,
  instance_id BIGINT NOT NULL REFERENCES flow_instances(id) ON DELETE CASCADE,
  node_key    VARCHAR(64) NOT NULL,
  node_name   VARCHAR(120) NOT NULL DEFAULT '',
  assignee    VARCHAR(64) NOT NULL,
  status      VARCHAR(16) NOT NULL DEFAULT 'pending',  -- pending | approved | returned | cancelled
  comment       TEXT NOT NULL DEFAULT '',
  round       INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  acted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ft_instance ON flow_tasks(instance_id, round);
CREATE INDEX IF NOT EXISTS idx_ft_assignee ON flow_tasks(assignee) WHERE status = 'pending';

-- 流程动作流水（发起/通过/退回/重新提交/自动通过/完成）
CREATE TABLE IF NOT EXISTS flow_events (
  id          BIGSERIAL PRIMARY KEY,
  instance_id BIGINT NOT NULL REFERENCES flow_instances(id) ON DELETE CASCADE,
  action      VARCHAR(24) NOT NULL,  -- start | approve | return | resubmit | auto_pass | finish
  node_key    VARCHAR(64),
  node_name   VARCHAR(120) NOT NULL DEFAULT '',
  actor       VARCHAR(64) NOT NULL DEFAULT '',
  comment     TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fe_instance ON flow_events(instance_id);

-- 退回后修改留痕：改前改后字段级对照（changes 元素 {path,label,before,after}，均为展示用文本）
-- before_data/after_data 保留改前改后的完整单据快照，逐字段对照与全貌都可回看
CREATE TABLE IF NOT EXISTS submission_revisions (
  id            BIGSERIAL PRIMARY KEY,
  submission_id BIGINT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  instance_id   BIGINT NOT NULL REFERENCES flow_instances(id) ON DELETE CASCADE,
  round         INTEGER NOT NULL,          -- 修改后进入的审批轮次
  editor        VARCHAR(64) NOT NULL DEFAULT '',
  changes       JSONB NOT NULL DEFAULT '[]'::jsonb,
  before_data   JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_data    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sr_sub ON submission_revisions(submission_id);
ALTER TABLE submission_revisions ADD COLUMN IF NOT EXISTS before_data JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE submission_revisions ADD COLUMN IF NOT EXISTS after_data JSONB NOT NULL DEFAULT '{}'::jsonb;

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
