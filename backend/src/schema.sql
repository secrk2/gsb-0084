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

-- 流程对字段的引用
CREATE TABLE IF NOT EXISTS flows (
  id              BIGSERIAL PRIMARY KEY,
  app_id          BIGINT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name            VARCHAR(100) NOT NULL,
  form_id         BIGINT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  trigger_field   VARCHAR(128),
  condition_field VARCHAR(128),
  approver_field  VARCHAR(128),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
