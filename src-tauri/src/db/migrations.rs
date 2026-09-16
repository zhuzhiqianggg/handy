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

/// v5：待办「说明」字段（`todos.detail`）。
///
/// `title` 只够放一句短语（列表里要一行显示、系统提醒要念出来），但真实事项往往需要
/// 补充上下文：链接、操作步骤、子清单。于是新增 `detail` 存 **Markdown** 说明，
/// 由工作台以所见即所得方式编辑（见 `src/components/RichMarkdown.tsx`）。
///
/// `ADD COLUMN` 带**常量默认值**，SQLite 允许且无需回填；迁移只执行一次
/// （`schema_migrations` 记录版本），因此不会出现「列已存在」的重复执行问题。
pub const V5_TODO_DETAIL: &str = "
ALTER TABLE todos ADD COLUMN detail TEXT NOT NULL DEFAULT '';
";

/// v6：桌面格子升级为「真实收纳 + 挂件」。
///
/// V33 的产品转向（用户实测反馈驱动）：
///   - 旧模型是**文件引用型** —— 格子登记桌面文件的路径引用，文件一动不动。
///     问题是它和桌面原图标**完全重复**（同一批文件在桌面和格子里各显示一份），
///     用户的原话是「并不是整理收纳，而是复制了一份而已」；
///   - 新模型是**真实收纳型** —— 每个格子绑定一个真实目录
///     （`桌面/Handy整理/<格子名>/`），拖进去 = 真把文件移进该目录。
///     文件离开桌面根目录 → 桌面图标自然消失 → **不再重复**。
///
/// 同时把格子扩成**挂件容器**：`kind` 区分收纳格 / 便签 / 日历，
/// `content` 存挂件自身的数据（便签正文、日历配置 JSON）。
///
/// `ADD COLUMN` 带常量默认值，SQLite 允许且无需回填；迁移只执行一次
/// （`schema_migrations` 记录版本），因此不会出现「列已存在」的重复执行问题。
/// `grid_items` 表保留但降级为**登记缓存**：内容真相在磁盘目录，表只缓存 id
/// 供前端做删除 / 跨格移动的定位（每次列举时按目录对账）。
pub const V6_GRID_WIDGETS: &str = "
ALTER TABLE grid_boxes ADD COLUMN kind TEXT NOT NULL DEFAULT 'folder';
ALTER TABLE grid_boxes ADD COLUMN content TEXT NOT NULL DEFAULT '';

-- 迁移前的「系统」格子是由 ensure_system_box 建的，里面装的是此电脑 / 回收站
-- 这类 CLSID 虚拟条目（磁盘上并没有对应文件）。升级后必须把它标成 system 类型，
-- 否则按「收纳格 = 真实目录」的新模型对账时，会把这两个入口当成失效条目清掉。
UPDATE grid_boxes SET kind = 'system' WHERE name = '系统';
";

/// 全部迁移：(版本号, SQL)。新增结构在**末尾追加**；移除历史结构可追加 DROP 迁移。
pub const MIGRATIONS: &[(i64, &str)] = &[
    (1, V1_SCHEMA),
    (2, V2_DROP_CLIP),
    (3, V3_VAULT),
    (4, V4_GRID),
    (5, V5_TODO_DETAIL),
    (6, V6_GRID_WIDGETS),
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

// —— 回归测试 ——
//
// 为什么要在这里测：迁移是**唯一**会改用户现有数据库结构的代码，一旦出错用户拿到的是
// 「表结构对不上 → 各功能报 no such column」。而它此前**一条断言都没有** ——
// V33 的 v6 就是在「沙箱里 GUI 起不来、跑不到 db::init」的情况下被发现的（见 PROJECT_STATUS §1.19）。
// 这组测试不依赖窗口/WebView，任何环境都能跑：`cargo test --lib db::migrations`。
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// 建一个空临时库；同名残留先删掉，保证从零开始。
    fn temp_conn(tag: &str) -> (PathBuf, Connection) {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "handy-migrate-test-{tag}-{}.db",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let conn = Connection::open(&path).expect("打开临时库失败");
        (path, conn)
    }

    /// 表的列名清单。
    fn columns(conn: &Connection, table: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .expect("读取表结构失败");
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("读取列名失败");
        rows.map(|row| row.expect("列行读取失败")).collect()
    }

    /// 已记录的迁移版本号（升序）。
    fn versions(conn: &Connection) -> Vec<i64> {
        let mut stmt = conn
            .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
            .expect("读取迁移版本失败");
        let rows = stmt
            .query_map([], |row| row.get::<_, i64>(0))
            .expect("读取迁移版本失败");
        rows.map(|row| row.expect("版本行读取失败")).collect()
    }

    /// 只应用到第 `last` 个版本（用于构造「老用户库里停在 v5」的现场）。
    fn apply_upto(conn: &Connection, last: i64) {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                 version    INTEGER PRIMARY KEY,
                 applied_at INTEGER NOT NULL
             );",
        )
        .expect("建迁移表失败");
        for (version, sql) in MIGRATIONS {
            if *version > last {
                break;
            }
            conn.execute_batch(sql)
                .unwrap_or_else(|err| panic!("预置迁移 v{version} 失败：{err}"));
            conn.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
                rusqlite::params![version, now_ms()],
            )
            .expect("记录预置迁移失败");
        }
    }

    /// 全新安装：一条 `run()` 应把所有版本按序落库，且最终结构含 v6 的两列。
    #[test]
    fn fresh_db_applies_every_migration() {
        let (path, conn) = temp_conn("fresh");
        run(&conn).expect("全新库迁移失败");

        let expected: Vec<i64> = MIGRATIONS.iter().map(|(v, _)| *v).collect();
        assert_eq!(
            versions(&conn),
            expected,
            "schema_migrations 必须按序记录全部迁移"
        );

        let cols = columns(&conn, "grid_boxes");
        assert!(cols.iter().any(|c| c == "kind"), "v6 未加 grid_boxes.kind");
        assert!(
            cols.iter().any(|c| c == "content"),
            "v6 未加 grid_boxes.content"
        );

        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    /// 老库升级（线上真实形态）：停在 v5、且已有一个「系统」格子。
    ///
    /// 断言三件事：① v6 被追加；② 新增列的默认值符合预期（普通格子回落 folder、
    /// content 为空串 —— 前端按 kind 分支渲染，空串是便签的安全初值）；
    /// ③ 名字为「系统」的格子被标成 `system` —— 它是 CLSID 虚拟条目（此电脑/回收站），
    /// 不标就会被新模型当成「收纳目录里已不存在的失效条目」清掉。
    #[test]
    fn v5_db_upgrades_to_widgets_without_losing_boxes() {
        let (path, conn) = temp_conn("from-v5");
        apply_upto(&conn, 5);
        assert_eq!(versions(&conn), vec![1, 2, 3, 4, 5], "预置应停在 v5");

        for name in ["文件夹", "系统"] {
            conn.execute(
                "INSERT INTO grid_boxes (name, pos_x, pos_y, width, height, sort, created_at, updated_at) \
                 VALUES (?1, 0, 0, 320, 220, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                rusqlite::params![name],
            )
            .expect("预置格子失败");
        }

        run(&conn).expect("v5 → v6 升级失败");

        // 用内层作用域收掉 `stmt` 的借用，后面才能 drop(conn) 关库再删文件
        let rows: Vec<(String, String, String)> = {
            let mut stmt = conn
                .prepare("SELECT name, kind, content FROM grid_boxes ORDER BY name ASC")
                .expect("查询格子失败");
            let mapped = stmt
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .expect("查询格子失败");
            mapped
                .map(|row| row.expect("格子行读取失败"))
                .collect::<Vec<_>>()
        };

        assert_eq!(
            rows,
            vec![
                ("文件夹".to_string(), "folder".to_string(), String::new()),
                ("系统".to_string(), "system".to_string(), String::new()),
            ],
            "升级后：普通格子回落 folder，系统格子必须标成 system，content 为空串"
        );
        assert_eq!(versions(&conn).last().copied(), Some(6), "v6 应被记录");

        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    /// 重复执行幂等：第二次 `run()` 不应报错、也不应重复插入版本行。
    #[test]
    fn run_is_idempotent() {
        let (path, conn) = temp_conn("repeat");
        run(&conn).expect("第一次迁移失败");
        let first = versions(&conn);
        run(&conn).expect("第二次迁移应直接跳过且不报错");
        assert_eq!(versions(&conn), first, "重复执行不得改变版本记录");

        drop(conn);
        let _ = std::fs::remove_file(path);
    }
}
