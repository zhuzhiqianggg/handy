//! SQLite 版本化迁移（ARCHITECTURE ADR-7）。
//!
//! 约定：迁移是**只追加**的有序列表，历史项一经发布不得修改；
//! 应用进度记录在 `schema_migrations` 表（`version` / `applied_at`），重复执行幂等。

use rusqlite::Connection;

/// v1 初始表结构（内嵌 `schema.sql`，编译期纳入二进制）。
pub const V1_SCHEMA: &str = include_str!("schema.sql");

/// v2：移除剪贴板历史（M4，用户决定直接移除，避免与系统剪贴板重复）。
/// 幂等 `DROP TABLE IF EXISTS`，对全新安装（v1 已不含 clip_* 表）无副作用。
pub const V2_DROP_CLIP: &str = "
DROP TABLE IF EXISTS clip_fts;
DROP TABLE IF EXISTS clip_items;
";

/// v3：密码存储器（M5）——主密码加密保险库。
///
/// - `vault_meta`：库元数据（`salt` 16 字节 / `verifier` 校验密文），value 一律 BLOB；
/// - `vault_items`：机密条目，明文字段**永不落库**，全部以
///   `*_enc` BLOB 存储（格式：`12 字节随机 nonce || AES-256-GCM 密文含 tag`，
///   每次写入生成新 nonce）。
pub const V3_VAULT: &str = "
CREATE TABLE IF NOT EXISTS vault_meta (
  key   TEXT PRIMARY KEY,
  value BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  category     TEXT NOT NULL CHECK(category IN ('login','secret','note')),
  title        TEXT NOT NULL,
  username_enc BLOB,
  secret_enc   BLOB NOT NULL,
  url_enc      BLOB,
  notes_enc    BLOB,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vault_items_updated ON vault_items(updated_at DESC);
";

/// v4：桌面网格挂件（M2 改版）——**文件引用型**桌面整理。
///
/// 设计原则：文件**绝不**被移动 / 复制 / 重命名；`grid_items.file_path` 存原文件
/// 路径的引用，打开经 shell 唤起系统默认程序（零磁盘副作用）。
///
/// - `grid_meta`：挂件窗几何等键值配置（value 存 JSON 字符串）；
/// - `grid_boxes`：挂件盒子（名称 + 逻辑像素几何 + 排序）；
/// - `grid_items`：盒子内条目（原路径引用），`box_id` 级联删除；
///   `(box_id, file_path)` 唯一索引防止同一盒子内重复引用。
pub const V4_GRID: &str = "
CREATE TABLE IF NOT EXISTS grid_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS grid_boxes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  pos_x      INTEGER NOT NULL DEFAULT 0,
  pos_y      INTEGER NOT NULL DEFAULT 0,
  width      INTEGER NOT NULL DEFAULT 320,
  height     INTEGER NOT NULL DEFAULT 220,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS grid_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  box_id       INTEGER NOT NULL REFERENCES grid_boxes(id) ON DELETE CASCADE,
  file_path    TEXT    NOT NULL,
  display_name TEXT    NOT NULL,
  sort         INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_grid_items_box_path ON grid_items(box_id, file_path);
CREATE INDEX IF NOT EXISTS idx_grid_items_box_sort ON grid_items(box_id, sort);
";

/// 全部迁移：(版本号, SQL)。新增结构在**末尾追加**；移除历史结构可追加 DROP 迁移。
pub const MIGRATIONS: &[(i64, &str)] = &[
    (1, V1_SCHEMA),
    (2, V2_DROP_CLIP),
    (3, V3_VAULT),
    (4, V4_GRID),
];

/// 当前毫秒时间戳（用于 `applied_at`）。
pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// 依次应用所有「未记录」的迁移。任何一步失败即中止并返回中文错误。
pub fn run(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
             version    INTEGER PRIMARY KEY,
             applied_at INTEGER NOT NULL
         );",
    )
    .map_err(|err| format!("创建迁移记录表失败：{err}"))?;

    // 已应用的最大版本号（空表时为 0）
    let applied: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )
        .map_err(|err| format!("读取迁移版本失败：{err}"))?;

    for (version, sql) in MIGRATIONS {
        if *version <= applied {
            continue;
        }
        conn.execute_batch(sql)
            .map_err(|err| format!("应用数据库迁移 v{version} 失败：{err}"))?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
            rusqlite::params![version, now_ms()],
        )
        .map_err(|err| format!("记录数据库迁移 v{version} 失败：{err}"))?;
    }

    Ok(())
}
