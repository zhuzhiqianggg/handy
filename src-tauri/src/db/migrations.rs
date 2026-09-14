//! SQLite 版本化迁移（ARCHITECTURE ADR-7）。
//!
//! 约定：迁移是**只追加**的有序列表，历史项一经发布不得修改；
//! 应用进度记录在 `schema_migrations` 表（`version` / `applied_at`），重复执行幂等。

use rusqlite::Connection;

/// v1 初始表结构（内嵌 `schema.sql`，编译期纳入二进制）。
pub const V1_SCHEMA: &str = include_str!("schema.sql");

/// 全部迁移：(版本号, SQL)。新增数据结构时在**末尾追加**一项。
pub const MIGRATIONS: &[(i64, &str)] = &[(1, V1_SCHEMA)];

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
