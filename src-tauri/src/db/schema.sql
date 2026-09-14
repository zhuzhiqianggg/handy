-- Handy · 顺手 —— SQLite 主数据层表结构（schema v1，见 ARCHITECTURE ADR-7）
--
-- 职责边界：本文件只承载「实体数据」（便签/待办/剪贴板/使用历史/整理计划/模块表）。
-- 应用级配置（settings / 收藏 / 最近 / Pro 标记）仍存 `settings.json`（tauri-plugin-store）。
--
-- 约定：所有 CREATE 语句均带 IF NOT EXISTS，可安全重复执行；版本推进由 migrations.rs 记录。

-- 便签（含窗口几何，关闭重开位置不丢）
CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  color       TEXT NOT NULL DEFAULT 'yellow',
  pinned      INTEGER NOT NULL DEFAULT 0,
  x           INTEGER NOT NULL DEFAULT 0,
  y           INTEGER NOT NULL DEFAULT 0,
  w           INTEGER NOT NULL DEFAULT 280,
  h           INTEGER NOT NULL DEFAULT 240,
  opacity     REAL NOT NULL DEFAULT 1.0,
  z           INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- 待办（note_id 关联便签，支持便签↔待办互转）
CREATE TABLE IF NOT EXISTS todos (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  done        INTEGER NOT NULL DEFAULT 0,
  priority    INTEGER NOT NULL DEFAULT 1,
  due_at      INTEGER,
  remind_at   INTEGER,
  reminded    INTEGER NOT NULL DEFAULT 0,
  note_id     TEXT REFERENCES notes(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_todos_note ON todos(note_id);
CREATE INDEX IF NOT EXISTS idx_todos_due ON todos(due_at);

-- 剪贴板历史（默认保留最近 N 条，条数由设置控制；sensitive 不落库）
CREATE TABLE IF NOT EXISTS clip_items (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL DEFAULT 'text',
  content     TEXT NOT NULL DEFAULT '',
  thumb       TEXT,
  source_app  TEXT,
  pinned      INTEGER NOT NULL DEFAULT 0,
  sensitive   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clip_created ON clip_items(created_at DESC);
-- 去重：同 kind + 同内容只保留一行（写入时 ON CONFLICT 更新 created_at）
CREATE UNIQUE INDEX IF NOT EXISTS idx_clip_content ON clip_items(kind, content);

-- 全文检索（剪贴板 / 笔记内容，FTS5；libsqlite3-sys bundled 已启用 FTS5）
CREATE VIRTUAL TABLE IF NOT EXISTS clip_fts USING fts5(
  content,
  ref_id UNINDEXED,
  kind UNINDEXED,
  tokenize = 'unicode61'
);

-- 工具使用历史（沿用 v1 语义，迁移到 SQLite）
CREATE TABLE IF NOT EXISTS usage_history (
  id          TEXT PRIMARY KEY,
  tool_id     TEXT NOT NULL,
  input       TEXT NOT NULL DEFAULT '',
  output      TEXT NOT NULL DEFAULT '',
  pinned      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_tool ON usage_history(tool_id, created_at DESC);

-- 桌面整理计划 / 撤销记录（payload 为 JSON 文本）
CREATE TABLE IF NOT EXISTS organize_plans (
  id          TEXT PRIMARY KEY,
  payload     TEXT NOT NULL DEFAULT '{}',
  applied     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- 模块启停（跨窗口一致性用；与 settings.json 的 settings.modules 保持同步）
CREATE TABLE IF NOT EXISTS module_state (
  module_id   TEXT PRIMARY KEY,
  enabled     INTEGER NOT NULL DEFAULT 1,
  updated_at  INTEGER NOT NULL
);

-- 版本迁移记录
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  INTEGER NOT NULL
);
