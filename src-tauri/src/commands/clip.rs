//! 剪贴板历史（M4）数据命令（V10）。
//!
//! 数据契约：`db/schema.sql` 的 `clip_items`（**唯一索引 (kind, content)**）与
//! `clip_fts`（FTS5, unicode61, ref_id/kind UNINDEXED）。**不可改表结构**。
//!
//! 职责：
//!   - `clip_add_batch`：前端监听（`useClipboardWatch`）批量落库。去重遵守 schema 注释
//!     ——`ON CONFLICT(kind, content) DO UPDATE SET created_at = excluded.created_at`
//!     （刷新时间序；**不覆盖** pinned，避免重复内容把置顶状态冲掉）；随后按
//!     `settings.maxClipboard` 裁剪非置顶旧记录、对账 FTS 索引；
//!   - `clip_list / clip_toggle_pin / clip_delete / clip_clear`：历史管理基本操作；
//!   - `clipboard_read_text`：剪贴板文本读取兜底（经平台抽象层
//!     `platform::current().read_clipboard`；WebView 的 `navigator.clipboard.readText`
//!     在后台无焦点场景常被拒绝，前端探测不可用时走本命令）。
//!
//! 边界：敏感内容**不落库**的判定在前端（`clipboardService.isSensitiveClipboard`），
//! 本模块只负责存储语义。历史 UI（列表/搜索/回贴/识别/转便签）在 V11。

use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use crate::db;
use crate::platform::{self, PlatformOps};

/// 配置存储文件名 / 键（与 `commands/app.rs` 一致）。
const SETTINGS_STORE: &str = "settings.json";
const SETTINGS_KEY: &str = "settings";

/// 历史上限缺省值（`settings.maxClipboard` 读不到 / 非法时回退）。
const MAX_CLIPBOARD_DEFAULT: i64 = 100;

/// 剪贴板条目（与 `clip_items` 表一一对应；serde camelCase 对齐前端 `ClipItem`）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipItem {
    pub id: String,
    pub kind: String,
    pub content: String,
    pub thumb: Option<String>,
    pub source_app: Option<String>,
    pub pinned: bool,
    pub sensitive: bool,
    pub created_at: i64,
}

/// `clip_items` 表行 → 实体。
fn row_to_clip(row: &Row) -> rusqlite::Result<ClipItem> {
    Ok(ClipItem {
        id: row.get("id")?,
        kind: row.get("kind")?,
        content: row.get("content")?,
        thumb: row.get("thumb")?,
        source_app: row.get("source_app")?,
        pinned: row.get::<_, i64>("pinned")? != 0,
        sensitive: row.get::<_, i64>("sensitive")? != 0,
        created_at: row.get("created_at")?,
    })
}

/// 打开独立短连接（与 notes/todos 同策略；WAL 下读写并发安全）。
fn connect(app: &AppHandle) -> Result<Connection, String> {
    let path = db::db_path(app)?;
    db::open(&path)
}

/// 当前 Unix 毫秒时间戳。
fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

const CLIP_COLUMNS: &str = "id, kind, content, thumb, source_app, pinned, sensitive, created_at";

/// 读取历史上限（`settings.json` → `settings.maxClipboard`；读不到 / 非法回退 100）。
fn max_clipboard(app: &AppHandle) -> i64 {
    let Ok(store) = app.store(SETTINGS_STORE) else {
        return MAX_CLIPBOARD_DEFAULT;
    };
    match store.get(SETTINGS_KEY) {
        Some(Value::Object(map)) => map
            .get("maxClipboard")
            .and_then(Value::as_i64)
            .filter(|n| *n > 0)
            .unwrap_or(MAX_CLIPBOARD_DEFAULT),
        _ => MAX_CLIPBOARD_DEFAULT,
    }
}

/// 批量写入入参（`kind` 缺省 `text`；`id` 缺省由 Rust 生成 uuid）。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ClipInput {
    pub id: Option<String>,
    pub kind: Option<String>,
    pub content: String,
    pub thumb: Option<String>,
    pub source_app: Option<String>,
}

/// 分页倒序列表（新 → 旧）。
#[tauri::command]
pub async fn clip_list(
    app: AppHandle,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<ClipItem>, String> {
    let limit = limit.unwrap_or(100).clamp(1, 500);
    let offset = offset.unwrap_or(0).max(0);
    let conn = connect(&app)?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {CLIP_COLUMNS} FROM clip_items ORDER BY created_at DESC LIMIT ?1 OFFSET ?2"
        ))
        .map_err(|err| format!("查询剪贴板历史失败：{err}"))?;
    let items = stmt
        .query_map(params![limit, offset], row_to_clip)
        .map_err(|err| format!("查询剪贴板历史失败：{err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("读取剪贴板历史失败：{err}"))?;
    Ok(items)
}

/// 翻转单条置顶状态，返回更新后的实体。
#[tauri::command]
pub async fn clip_toggle_pin(app: AppHandle, clip_id: String) -> Result<ClipItem, String> {
    let conn = connect(&app)?;
    let affected = conn
        .execute(
            "UPDATE clip_items SET pinned = 1 - pinned WHERE id = ?1",
            params![clip_id],
        )
        .map_err(|err| format!("更新置顶状态失败：{err}"))?;
    if affected == 0 {
        return Err("剪贴板条目不存在或已被删除".to_string());
    }
    let mut stmt = conn
        .prepare(&format!("SELECT {CLIP_COLUMNS} FROM clip_items WHERE id = ?1"))
        .map_err(|err| format!("查询剪贴板条目失败：{err}"))?;
    stmt.query_row(params![clip_id], row_to_clip)
        .map_err(|err| format!("查询剪贴板条目失败：{err}"))
}

/// 删除单条（联动清理 FTS 孤儿索引）。
#[tauri::command]
pub async fn clip_delete(app: AppHandle, clip_id: String) -> Result<(), String> {
    let conn = connect(&app)?;
    let affected = conn
        .execute("DELETE FROM clip_items WHERE id = ?1", params![clip_id])
        .map_err(|err| format!("删除剪贴板条目失败：{err}"))?;
    if affected == 0 {
        return Err("剪贴板条目不存在或已被删除".to_string());
    }
    reconcile_fts(&conn)?;
    Ok(())
}

/// 清空非置顶条目，返回删除条数（置顶条目保留）。
#[tauri::command]
pub async fn clip_clear(app: AppHandle) -> Result<i64, String> {
    let conn = connect(&app)?;
    let affected = conn
        .execute("DELETE FROM clip_items WHERE pinned = 0", [])
        .map_err(|err| format!("清空剪贴板历史失败：{err}"))?;
    reconcile_fts(&conn)?;
    Ok(affected as i64)
}

/// 批量落库（前端监听调用）。返回处理条数（含被去重合并的条目）。
///
/// 流程：UPSERT（冲突刷新 created_at、不动 pinned）→ 按上限裁剪非置顶旧记录 →
/// FTS 对账（补建缺失索引行 + 清理孤儿行）。
#[tauri::command]
pub async fn clip_add_batch(app: AppHandle, items: Vec<ClipInput>) -> Result<usize, String> {
    if items.is_empty() {
        return Ok(0);
    }
    let conn = connect(&app)?;
    let now = now_ms();

    for (index, item) in items.iter().enumerate() {
        let id = item
            .id
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let kind = item
            .kind
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "text".to_string());
        // 批内保持传入顺序（时间戳随序号递增，列表时序稳定）
        let created_at = now + index as i64;
        conn.execute(
            "INSERT INTO clip_items (id, kind, content, thumb, source_app, pinned, sensitive, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, ?6) \
             ON CONFLICT(kind, content) DO UPDATE SET created_at = excluded.created_at",
            params![id, kind, item.content, item.thumb, item.source_app, created_at],
        )
        .map_err(|err| format!("写入剪贴板历史失败：{err}"))?;
    }

    trim_to_limit(&conn, max_clipboard(&app))?;
    reconcile_fts(&conn)?;
    Ok(items.len())
}

/// 读取剪贴板文本兜底（`navigator.clipboard.readText` 不可用 / 被拒时由前端调用）。
/// 空剪贴板 / 非文本内容返回 `Ok(None)`（非文本时插件返回 Err，原样上抛给前端跳过本轮）。
#[tauri::command]
pub async fn clipboard_read_text(app: AppHandle) -> Result<Option<String>, String> {
    let text = platform::current().read_clipboard(&app)?;
    Ok(if text.is_empty() { None } else { Some(text) })
}

/// 写入剪贴板文本（V11 回贴）：把历史条目写回系统剪贴板。
#[tauri::command]
pub async fn clipboard_write_text(app: AppHandle, text: String) -> Result<(), String> {
    platform::current().write_clipboard(&text, &app)
}

/// 裁剪：保持**非置顶**条数 ≤ 预算（= maxClipboard − 置顶数，负数按 0），
/// 删除最旧的溢出部分。置顶条目不参与删除（若置顶数本身超上限，总数可能略超——
/// 置顶是用户显式意图，优先保留）。
fn trim_to_limit(conn: &Connection, limit: i64) -> Result<(), String> {
    let pinned: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM clip_items WHERE pinned = 1",
            [],
            |row| row.get(0),
        )
        .map_err(|err| format!("统计置顶条数失败：{err}"))?;
    let budget = (limit - pinned).max(0);
    conn.execute(
        "DELETE FROM clip_items WHERE pinned = 0 AND id IN ( \
           SELECT id FROM clip_items WHERE pinned = 0 ORDER BY created_at DESC LIMIT -1 OFFSET ?1 )",
        params![budget],
    )
    .map_err(|err| format!("裁剪剪贴板历史失败：{err}"))?;
    Ok(())
}

/// FTS 对账（幂等）：为尚无索引的 `clip_items` 行补建 `clip_fts`；清理指向已删除
/// 条目的孤儿索引行。每次写操作后调用，保证 FTS 与主表一致（供 V11 搜索）。
fn reconcile_fts(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "INSERT INTO clip_fts (content, ref_id, kind) \
         SELECT ci.content, ci.id, ci.kind FROM clip_items ci \
         WHERE NOT EXISTS (SELECT 1 FROM clip_fts f WHERE f.ref_id = ci.id)",
        [],
    )
    .map_err(|err| format!("同步剪贴板全文索引失败：{err}"))?;
    conn.execute(
        "DELETE FROM clip_fts WHERE ref_id NOT IN (SELECT id FROM clip_items)",
        [],
    )
    .map_err(|err| format!("清理剪贴板全文索引失败：{err}"))?;
    Ok(())
}
