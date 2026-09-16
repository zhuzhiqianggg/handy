//! 桌面网格挂件（desktop grid widget）——「文件引用型」桌面整理（M2 改版）。
//!
//! 设计原则（用户明确否决 V12「建目录 + 移动文件」方案）：
//!   - **零磁盘副作用**：挂件条目只是原文件路径的**引用**（`grid_items.file_path`），
//!     打开经 shell 插件唤起系统默认程序打开**原文件**，从不移动 / 复制 / 重命名；
//!   - **桌面层挂件窗**：`grid-overlay` 无边框透明窗，**作为桌面窗口的子窗口**
//!     真正长在桌面上（`SetParent` 到 Progman / WorkerW，见 [`apply_attach`]）。
//!     V20 修复：旧实现用 `SetWindowPos(HWND_BOTTOM)` 把它压到了**壁纸之下**，
//!     用户看到的是「格子建了但桌面上什么都没有」；
//!   - **默认点击穿透**：窗口创建后即 `set_ignore_cursor_events(true)`；Rust 侧轻量
//!     轮询线程每 [`POLL_INTERVAL_MS`] 毫秒取全局光标位置，与前端上报的盒子区域
//!     （[`grid_overlay_update_regions`]，挂件窗内**物理像素**）做命中测试，命中
//!     （或前端拖拽期显式申请，见 [`grid_set_interactive`]）才切回可交互。这样透明
//!     区域始终把点击让给桌面，而盒子区域可交互、可接收文件拖放。
//!
//! 数据契约：`db/migrations.rs` v4（grid_meta / grid_boxes / grid_items）。
//! 三方向一致：迁移 SQL = 本文件结构体 = `src/types/grid.ts`。
//!
//! 全部命令均为 `async fn`（项目 P0 约定：同步命令会楔死 WebView2 COM STA），
//! 错误一律中文可读，SQL 一律参数化绑定。

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Mutex;

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::HWND;

use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::db;

/// 挂件窗 label（与 capabilities `windows` / `main.tsx` 的 `?window=grid-overlay` 对应）。
pub const GRID_LABEL: &str = "grid-overlay";

/// 挂件窗加载 URL（窗口分派见 `src/main.tsx` → `App.tsx`）。
const GRID_URL: &str = "index.html?window=grid-overlay";

/// `grid_meta` 中挂件窗几何的键名。
const META_KEY_GEOMETRY: &str = "overlay_geometry";

/// 光标轮询间隔（毫秒）。足够快以赶上拖放落点，又远低于 CPU 可感知开销。
const POLL_INTERVAL_MS: u64 = 60;

/// 每隔多少个轮询周期检查一次 Z 序（错位才重排，见 [`reassert_attach`]）。
const REASSERT_TICKS: u64 = 33;

/// 前端上报的盒子命中区域（挂件窗客户区内**物理像素**）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridRegion {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 挂件窗几何（逻辑像素，存 `grid_meta`，JSON 序列化）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridGeometry {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

/// 盒子实体（与 `grid_boxes` 表对应；`item_count` 为条目计数子查询）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridBox {
    pub id: i64,
    pub name: String,
    pub pos_x: i64,
    pub pos_y: i64,
    pub width: i64,
    pub height: i64,
    pub sort: i64,
    pub item_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// 挂件条目（与 `grid_items` 表对应；`file_path` 为**原文件**路径引用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridItem {
    pub id: i64,
    pub box_id: i64,
    pub file_path: String,
    pub display_name: String,
    pub sort: i64,
    pub created_at: String,
}

// —— 进程内共享状态（仅本模块使用；均为极小状态，无需托管进 Tauri State） ——

/// 前端上报的命中区域（物理像素）。空 = 视为全程穿透。
static REGIONS: Mutex<Vec<GridRegion>> = Mutex::new(Vec::new());

/// 前端交互期（拖拽/缩放/重命名）显式申请的「保持可交互」标志。
static FORCED_INTERACTIVE: AtomicBool = AtomicBool::new(false);

/// 光标轮询线程是否在运行（保证 show 多次只起一个线程；窗口销毁后线程自退出）。
static POLLER_RUNNING: AtomicBool = AtomicBool::new(false);

// —— DB 辅助 ——

/// 打开独立短连接（每次命令新建；WAL + 外键约束，与 sql 插件同文件，同 notes 约定）。
fn connect(app: &AppHandle) -> Result<Connection, String> {
    let path = db::db_path(app)?;
    db::open(&path)
}

/// 当前本地时间（ISO 片段 `YYYY-MM-DD HH:MM:SS`，与 vault 等表的时间语义一致）。
fn now_iso() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

/// 盒子列前缀（别名 `b`）。
const BOX_COLUMNS: &str = "b.id, b.name, b.pos_x, b.pos_y, b.width, b.height, b.sort, \
                           b.created_at, b.updated_at";

/// 行 → 盒子实体（SQL 必须附带 `item_count` 计数列）。
fn row_to_box_with_count(row: &Row) -> rusqlite::Result<GridBox> {
    Ok(GridBox {
        id: row.get("id")?,
        name: row.get("name")?,
        pos_x: row.get("pos_x")?,
        pos_y: row.get("pos_y")?,
        width: row.get("width")?,
        height: row.get("height")?,
        sort: row.get("sort")?,
        item_count: row.get("item_count")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// 行 → 条目实体。
fn row_to_item(row: &Row) -> rusqlite::Result<GridItem> {
    Ok(GridItem {
        id: row.get("id")?,
        box_id: row.get("box_id")?,
        file_path: row.get("file_path")?,
        display_name: row.get("display_name")?,
        sort: row.get("sort")?,
        created_at: row.get("created_at")?,
    })
}

/// 按 id 读取单个盒子（不存在返回中文错误）。
fn load_box(app: &AppHandle, box_id: i64) -> Result<GridBox, String> {
    let conn = connect(app)?;
    let sql = format!(
        "SELECT {BOX_COLUMNS}, \
         (SELECT COUNT(*) FROM grid_items i WHERE i.box_id = b.id) AS item_count \
         FROM grid_boxes b WHERE b.id = ?1"
    );
    match conn.query_row(&sql, params![box_id], row_to_box_with_count) {
        Ok(entity) => Ok(entity),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(format!("盒子不存在或已被删除（id={box_id}）"))
        }
        Err(err) => Err(format!("查询盒子失败：{err}")),
    }
}

/// 名称清洗：去首尾空白，空则用缺省名。
fn clean_name(name: Option<String>) -> String {
    match name {
        Some(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                "新盒子".to_string()
            } else {
                trimmed.to_string()
            }
        }
        None => "新盒子".to_string(),
    }
}

/// 读取「下一个排序值」。
///
/// `bind = Some(id)` 用于**带 `?1` 占位符**的 SQL（盒子内条目求最大值）；
/// `bind = None` 用于**完全不带占位符**的 SQL（全表求最大值）。
///
/// 二者必须显式区分：对无占位符的 SQL 传入参数会触发 rusqlite
/// `Wrong number of parameters passed to query. Got 1, needed 0`，
/// 这正是此前「添加盒子 / 添加挂件条目一律失败」的根因。
fn next_sort(conn: &Connection, sql: &str, bind: Option<i64>) -> Result<i64, String> {
    let outcome = match bind {
        Some(value) => conn.query_row(sql, params![value], |row| row.get(0)),
        None => conn.query_row(sql, [], |row| row.get(0)),
    };
    outcome.map_err(|err| format!("读取排序值失败：{err}"))
}

// —— 盒子 CRUD ——

/// 盒子列表（含条目计数；按 sort 升序、id 升序稳定排序）。
#[tauri::command]
pub async fn grid_box_list(app: AppHandle) -> Result<Vec<GridBox>, String> {
    let conn = connect(&app)?;
    let sql = format!(
        "SELECT {BOX_COLUMNS}, \
         (SELECT COUNT(*) FROM grid_items i WHERE i.box_id = b.id) AS item_count \
         FROM grid_boxes b ORDER BY b.sort ASC, b.id ASC"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|err| format!("查询盒子列表失败：{err}"))?;
    let boxes = stmt
        .query_map([], row_to_box_with_count)
        .map_err(|err| format!("查询盒子列表失败：{err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("读取盒子列表失败：{err}"))?;
    Ok(boxes)
}

/// 创建（`boxId` 缺省）或更新盒子（几何 / 名称 / 排序），返回落库后的完整实体。
///
/// 更新只写传入的字段（`None` 跳过）；创建时缺省值：名称「新盒子」、位置按毫秒
/// 散列级联摆放（避免新盒子完全重叠）、320×220、排序追加到末尾。
#[tauri::command]
pub async fn grid_box_upsert(
    app: AppHandle,
    box_id: Option<i64>,
    name: Option<String>,
    pos_x: Option<i64>,
    pos_y: Option<i64>,
    width: Option<i64>,
    height: Option<i64>,
    sort: Option<i64>,
) -> Result<GridBox, String> {
    // 尺寸下限（与前端 MIN_BOX_W/H 一致），防止把盒子拖没
    const MIN_W: i64 = 160;
    const MIN_H: i64 = 120;

    match box_id {
        None => {
            let now = now_iso();
            let final_width = width.unwrap_or(320).max(MIN_W);
            let final_height = height.unwrap_or(220).max(MIN_H);

            let conn = connect(&app)?;
            // 全表求最大值 → 该 SQL 无占位符，必须传 None
            let final_sort = match sort {
                Some(s) => s,
                None => next_sort(&conn, "SELECT COALESCE(MAX(sort) + 1, 0) FROM grid_boxes", None)?,
            };
            // 已存在的盒子数 → 决定新盒子级联位置，避免多个新盒子完全重叠
            let existing: i64 = conn
                .query_row("SELECT COUNT(*) FROM grid_boxes", [], |row| row.get(0))
                .unwrap_or(0);
            let cascade = existing.max(0) as i64;
            conn.execute(
                "INSERT INTO grid_boxes \
                 (name, pos_x, pos_y, width, height, sort, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    clean_name(name),
                    pos_x.unwrap_or(60 + (cascade % 6) * 340),
                    pos_y.unwrap_or(60 + (cascade % 4) * 250),
                    final_width,
                    final_height,
                    final_sort,
                    now,
                    now,
                ],
            )
            .map_err(|err| format!("创建盒子失败：{err}"))?;
            load_box(&app, conn.last_insert_rowid())
        }
        Some(id) => {
            // 动态 SET：只更新显式传入的字段
            let mut sets: Vec<&'static str> = Vec::new();
            let mut values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
            if let Some(v) = name {
                sets.push("name = ?");
                values.push(Box::new(clean_name(Some(v))));
            }
            if let Some(v) = pos_x {
                sets.push("pos_x = ?");
                values.push(Box::new(v));
            }
            if let Some(v) = pos_y {
                sets.push("pos_y = ?");
                values.push(Box::new(v));
            }
            if let Some(v) = width {
                sets.push("width = ?");
                values.push(Box::new(v.max(MIN_W)));
            }
            if let Some(v) = height {
                sets.push("height = ?");
                values.push(Box::new(v.max(MIN_H)));
            }
            if let Some(v) = sort {
                sets.push("sort = ?");
                values.push(Box::new(v));
            }

            let conn = connect(&app)?;
            if !sets.is_empty() {
                let sql = format!(
                    "UPDATE grid_boxes SET {}, updated_at = ? WHERE id = ?",
                    sets.join(", ")
                );
                let now = now_iso();
                let mut bind: Vec<&dyn rusqlite::ToSql> =
                    values.iter().map(|b| b.as_ref()).collect();
                bind.push(&now);
                bind.push(&id);
                let affected = conn
                    .execute(sql.as_str(), bind.as_slice())
                    .map_err(|err| format!("更新盒子失败：{err}"))?;
                if affected == 0 {
                    return Err(format!("盒子不存在或已被删除（id={id}）"));
                }
            }
            load_box(&app, id)
        }
    }
}

/// 删除盒子（级联删除其条目；**文件本体不受任何影响**）。
#[tauri::command]
pub async fn grid_box_delete(app: AppHandle, box_id: i64) -> Result<(), String> {
    let conn = connect(&app)?;
    let affected = conn
        .execute("DELETE FROM grid_boxes WHERE id = ?1", params![box_id])
        .map_err(|err| format!("删除盒子失败：{err}"))?;
    if affected == 0 {
        return Err(format!("盒子不存在或已被删除（id={box_id}）"));
    }
    // grid_items 由外键 ON DELETE CASCADE 自动清理（db::open 已启用 foreign_keys）
    Ok(())
}

// —— 条目 CRUD（仅登记引用，不动文件） ——

/// 添加条目：把**原文件路径**登记为某盒子内的引用。
///
/// - `displayName` 缺省取文件名；
/// - 同一盒子内同一 `file_path` 不重复登记（唯一索引兜底 + 友好中文错误）。
#[tauri::command]
pub async fn grid_item_add(
    app: AppHandle,
    box_id: i64,
    file_path: String,
    display_name: Option<String>,
) -> Result<GridItem, String> {
    let file_path = file_path.trim().to_string();
    if file_path.is_empty() {
        return Err("文件路径为空".to_string());
    }

    let conn = connect(&app)?;
    let box_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM grid_boxes WHERE id = ?1",
            params![box_id],
            |row| row.get(0),
        )
        .map_err(|err| format!("查询盒子失败：{err}"))?;
    if box_exists == 0 {
        return Err("盒子不存在或已被删除".to_string());
    }

    let dup: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM grid_items WHERE box_id = ?1 AND file_path = ?2",
            params![box_id, file_path],
            |row| row.get(0),
        )
        .map_err(|err| format!("查询挂件条目失败：{err}"))?;
    if dup > 0 {
        return Err("该文件已在此盒子中".to_string());
    }

    let display = match display_name {
        Some(raw) if !raw.trim().is_empty() => raw.trim().to_string(),
        _ => std::path::Path::new(&file_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| file_path.clone()),
    };
    let sort = next_sort(
        &conn,
        "SELECT COALESCE(MAX(sort) + 1, 0) FROM grid_items WHERE box_id = ?1",
        Some(box_id),
    )?;
    let created = now_iso();

    conn.execute(
        "INSERT INTO grid_items (box_id, file_path, display_name, sort, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![box_id, file_path, display, sort, created],
    )
    .map_err(|err| format!("添加挂件条目失败：{err}"))?;

    // 手动登记 = 用户明确要它进格子 → 从「不再自动收录」名单解除
    if let Ok(mut dismissed) = read_dismissed(&conn) {
        if dismissed.remove(&file_path) {
            let _ = write_dismissed(&conn, &dismissed);
        }
    }

    Ok(GridItem {
        id: conn.last_insert_rowid(),
        box_id,
        file_path,
        display_name: display,
        sort,
        created_at: created,
    })
}

/// 删除条目（仅移除引用，**文件本体不受任何影响**）。
///
/// `dismiss = true`（格子层 × 按钮语义）：把路径记入「不再自动收录」名单，
/// 桌面同步不会再把它收回来；再次手动拖入同一文件会自动解除。
#[tauri::command]
pub async fn grid_item_delete(
    app: AppHandle,
    item_id: i64,
    dismiss: Option<bool>,
) -> Result<(), String> {
    let conn = connect(&app)?;
    // 先取路径再删：dismiss 要记住的是「哪个文件」而不是「哪行记录」
    let path: Option<String> = conn
        .query_row(
            "SELECT file_path FROM grid_items WHERE id = ?1",
            params![item_id],
            |row| row.get(0),
        )
        .ok();
    let affected = conn
        .execute("DELETE FROM grid_items WHERE id = ?1", params![item_id])
        .map_err(|err| format!("删除挂件条目失败：{err}"))?;
    if affected == 0 {
        return Err("挂件条目不存在或已被删除".to_string());
    }
    if dismiss.unwrap_or(false) {
        if let Some(path) = path {
            let mut set = read_dismissed(&conn)?;
            set.insert(path);
            let _ = write_dismissed(&conn, &set);
        }
    }
    Ok(())
}

/// 移动条目到另一个格子（对标腾讯桌面整理：图标拖着走，只改引用归属）。
///
/// **文件本体不受任何影响**；桌面同步按「路径已登记」全局去重，
/// 移动过的条目不会被同步当成新文件再收一遍。
#[tauri::command]
pub async fn grid_item_move(
    app: AppHandle,
    item_id: i64,
    target_box_id: i64,
) -> Result<(), String> {
    let conn = connect(&app)?;
    let target_exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM grid_boxes WHERE id = ?1",
            params![target_box_id],
            |row| row.get::<_, i64>(0).map(|count| count > 0),
        )
        .map_err(|err| format!("查询目标格子失败：{err}"))?;
    if !target_exists {
        return Err("目标格子不存在或已被删除".to_string());
    }
    let affected = conn
        .execute(
            "UPDATE grid_items SET box_id = ?1 WHERE id = ?2",
            params![target_box_id, item_id],
        )
        .map_err(|err| format!("移动挂件条目失败：{err}"))?;
    if affected == 0 {
        return Err("挂件条目不存在或已被删除".to_string());
    }
    Ok(())
}

/// 某盒子的条目列表（按 sort 升序、id 升序稳定排序）。
#[tauri::command]
pub async fn grid_item_list(app: AppHandle, box_id: i64) -> Result<Vec<GridItem>, String> {
    let conn = connect(&app)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, box_id, file_path, display_name, sort, created_at \
             FROM grid_items WHERE box_id = ?1 ORDER BY sort ASC, id ASC",
        )
        .map_err(|err| format!("查询挂件条目失败：{err}"))?;
    let items = stmt
        .query_map(params![box_id], row_to_item)
        .map_err(|err| format!("查询挂件条目失败：{err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("读取挂件条目失败：{err}"))?;
    Ok(items)
}

// —— 挂件窗几何 ——

/// 同步读取挂件窗几何（开窗时用；无记录 / JSON 损坏均返回 `None` 走缺省值）。
fn read_geometry(app: &AppHandle) -> Result<Option<GridGeometry>, String> {
    let conn = connect(app)?;
    let raw: Option<String> = match conn.query_row(
        "SELECT value FROM grid_meta WHERE key = ?1",
        params![META_KEY_GEOMETRY],
        |row| row.get(0),
    ) {
        Ok(v) => Some(v),
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(err) => return Err(format!("读取挂件几何失败：{err}")),
    };
    Ok(raw.and_then(|raw| serde_json::from_str::<GridGeometry>(&raw).ok()))
}

/// 读取挂件窗几何（无记录返回 `null`）。
#[tauri::command]
pub async fn grid_geometry_get(app: AppHandle) -> Result<Option<GridGeometry>, String> {
    read_geometry(&app)
}

/// 持久化挂件窗几何（前端 moved / resized 防抖后调用）。
#[tauri::command]
pub async fn grid_geometry_set(
    app: AppHandle,
    x: i64,
    y: i64,
    width: i64,
    height: i64,
) -> Result<(), String> {
    let json = serde_json::to_string(&GridGeometry { x, y, width, height })
        .map_err(|err| format!("序列化挂件几何失败：{err}"))?;
    let conn = connect(&app)?;
    conn.execute(
        "INSERT INTO grid_meta (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![META_KEY_GEOMETRY, json],
    )
    .map_err(|err| format!("写入挂件几何失败：{err}"))?;
    Ok(())
}

// —— 挂件窗生命周期 ——

/// 缺省几何：主显示器工作区（物理 → 逻辑像素换算；读取失败兜底 1280×800）。
fn default_geometry(app: &AppHandle) -> (f64, f64, f64, f64) {
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let area = monitor.work_area();
        let sf = monitor.scale_factor();
        if sf > 0.0 {
            return (
                f64::from(area.position.x) / sf,
                f64::from(area.position.y) / sf,
                f64::from(area.size.width) / sf,
                f64::from(area.size.height) / sf,
            );
        }
    }
    (0.0, 0.0, 1280.0, 800.0)
}

// ————————————————————————————————————————————————————————————————
// 桌面层挂载（V21 重做 —— 三次踩坑的最终答案）
//
// # 走过的两条错路
//
// 1. **V19 = `SetWindowPos(HWND_BOTTOM)`**：`HWND_BOTTOM` 是「整个 Z 序的最底」，
//    **包括桌面窗口（Progman）之下** —— 窗口被塞到壁纸后面，用户看到的是
//    「格子建了、数据也建了，但桌面上什么都没有」。
// 2. **V20 = `SetParent(Progman)`**：把挂件窗变成桌面的**子窗口**。位置对了，
//    但踩了三个新坑：
//      - 子窗口不参与 DWM 的 per-pixel alpha 合成 → **透明失效**，整块灰底；
//      - `SetParent` 会触发窗口重建 → **点一下闪一下**；
//      - 父子关系随 Explorer 重启失效 → 「看运气才能看到」。
//
// # 最终做法：顶层窗口 + 「插到桌面窗口正上方」
//
// `SetWindowPos(hwnd, host, SWP_NOACTIVATE)` 的第二个参数语义是
// 「把 hwnd 放到 host **之上**」，host 取 Progman（或持有 `SHELLDLL_DefView`
// 的 WorkerW）。于是 Z 序变成：
//
// ```text
//   …… 其它应用窗口 ……
//   ┌──────────────┐
//   │ grid-overlay │   ← 我们（透明区域穿透，桌面图标仍可见可点）
//   ├──────────────┤
//   │   Progman    │   ← 桌面 + 系统图标
//   └──────────────┘
// ```
//
// 三个好处：
//   - 窗口仍是**顶层窗口** → 透明 / 模糊 / 圆角全部正常；
//   - 不重建窗口 → 不再闪烁；Explorer 重启后由轮询线程重新定位；
//   - 应用窗口天然盖住它 → 不会打扰正常工作，回到桌面又立刻看到挂件。
//
// 另外给窗口加 `WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW`：点击挂件时**不抢焦点**，
// 也不会因为被激活而浮到别的窗口上面去。
//
// 兜底：找不到桌面宿主 → 退到 [`AttachMode::Normal`]（不做任何 Z 序调整，
// 窗口照旧可见可用），并把原因原样报给前端，不做静默吞错。
// ————————————————————————————————————————————————————————————————

/// 挂件窗与桌面的相对关系。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachMode {
    /// 贴到桌面（默认）：Z 序上紧贴在桌面窗口之上、其它应用窗口之下。
    Desktop,
    /// 普通窗口：不调整 Z 序（排查 / 兼容用，序列化仍写作 `"bottom"`）。
    Normal,
}

impl AttachMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Desktop => "desktop",
            Self::Normal => "bottom",
        }
    }

    fn parse(value: &str) -> Self {
        if value == "bottom" {
            Self::Normal
        } else {
            Self::Desktop
        }
    }

    fn from_u8(value: u8) -> Self {
        if value == 1 {
            Self::Normal
        } else {
            Self::Desktop
        }
    }

    /// 当前进程内生效的基准层（供后续扩展读取；`ATTACH_MODE` 为唯一写入点）。
    #[allow(dead_code)]
    fn current() -> Self {
        Self::from_u8(ATTACH_MODE.load(Ordering::Relaxed))
    }

    fn as_u8(self) -> u8 {
        match self {
            Self::Desktop => 0,
            Self::Normal => 1,
        }
    }
}

/// `grid_meta` 中「挂件基准层」的键名。
const META_KEY_ATTACH: &str = "attach_mode";

/// `grid_meta` 中「系统桌面图标是否被隐藏」的键名（崩溃后启动时据此恢复）。
const META_KEY_ICONS_HIDDEN: &str = "desktop_icons_hidden";

/// `grid_meta` 中「不再自动收录」名单的键名（JSON 字符串数组）。
///
/// 桌面同步会把桌面上还没进格子的文件按类型自动收纳；用户点条目上的 × 移除后，
/// 若不同步记住这个意愿，下一轮同步就会把它原样收回来 —— 名单就是那块记忆。
/// 手动把同一文件拖进格子会自动解除（用户用行动推翻了之前的决定）。
const META_KEY_DISMISSED: &str = "sync_dismissed";

/// `grid_meta` 中「挂件层是否应处于显示状态」的键名。
///
/// 「桌面整理永久生效」的根基：应用任何原因退出 / 重启（手动关闭、升级覆盖安装、
/// 崩溃被拉起）后，启动时只要这里记着「显示中」，就自动把格子层摆回桌面并接管 ——
/// 用户不需要每次开机后重新去点「显示格子」。
const META_KEY_OVERLAY_VISIBLE: &str = "overlay_visible";

/// 当前生效的基准层（轮询线程读它做周期复位，避免每 tick 查库）。
static ATTACH_MODE: AtomicU8 = AtomicU8::new(0);

/// 宽字符字面量（Win32 API 需要 NUL 结尾的 UTF-16）。
#[cfg(target_os = "windows")]
fn wide(value: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// 找「桌面宿主窗口」：优先 Progman，其次挂有 `SHELLDLL_DefView` 的 WorkerW。
///
/// 说明：Win10/11 通常由 `Progman` 承载 `SHELLDLL_DefView`（桌面图标视图）；
/// 装了壁纸软件 / 多显示器动态壁纸时，`SHELLDLL_DefView` 会被挪到某个 `WorkerW`
/// 下，故两种都试。
#[cfg(target_os = "windows")]
fn null_hwnd() -> HWND {
    HWND(std::ptr::null_mut())
}

#[cfg(target_os = "windows")]
fn desktop_host() -> Option<HWND> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowExW, FindWindowW};

    let progman_class = wide("Progman");
    let def_view_class = wide("SHELLDLL_DefView");
    let worker_class = wide("WorkerW");

    // 注：windows 0.58 把 `FindWindowW` / `FindWindowExW` 包成了 `Result<HWND>`
    // （找不到 = `Err`），所以统一 `unwrap_or_else` 退化成空句柄判断。
    unsafe {
        let progman = FindWindowW(PCWSTR(progman_class.as_ptr()), PCWSTR::null())
            .unwrap_or_else(|_| null_hwnd());
        if !progman.0.is_null() {
            let def_view = FindWindowExW(
                progman,
                null_hwnd(),
                PCWSTR(def_view_class.as_ptr()),
                PCWSTR::null(),
            )
            .unwrap_or_else(|_| null_hwnd());
            if !def_view.0.is_null() {
                return Some(progman);
            }
        }

        // 遍历顶层 WorkerW：哪个直接挂着 SHELLDLL_DefView 就是壁纸层
        let mut current = null_hwnd();
        for _ in 0..32 {
            let worker = match FindWindowExW(
                null_hwnd(),
                current,
                PCWSTR(worker_class.as_ptr()),
                PCWSTR::null(),
            ) {
                Ok(handle) => handle,
                Err(_) => break,
            };
            if worker.0.is_null() {
                break;
            }
            let def_view = FindWindowExW(
                worker,
                null_hwnd(),
                PCWSTR(def_view_class.as_ptr()),
                PCWSTR::null(),
            )
            .unwrap_or_else(|_| null_hwnd());
            if !def_view.0.is_null() {
                return Some(worker);
            }
            current = worker;
        }
        None
    }
}

/// 桌面图标视图（`SHELLDLL_DefView` → `SysListView32`）。
#[cfg(target_os = "windows")]
fn desktop_icon_view() -> Option<HWND> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::FindWindowExW;

    let host = desktop_host()?;
    let def_view_class = wide("SHELLDLL_DefView");
    let list_class = wide("SysListView32");
    unsafe {
        let def_view = FindWindowExW(
            host,
            null_hwnd(),
            PCWSTR(def_view_class.as_ptr()),
            PCWSTR::null(),
        )
        .unwrap_or_else(|_| null_hwnd());
        if def_view.0.is_null() {
            return None;
        }
        let list = FindWindowExW(
            def_view,
            null_hwnd(),
            PCWSTR(list_class.as_ptr()),
            PCWSTR::null(),
        )
        .unwrap_or_else(|_| null_hwnd());
        if list.0.is_null() {
            None
        } else {
            Some(list)
        }
    }
}

/// 隐藏 / 恢复桌面系统图标（仅切换 `SysListView32` 的可见性，**不动任何文件**）。
///
/// 语义：这是「桌面整理」的关键一步 —— 格子接管呈现后，原来的图标不该再重复显示。
/// 返回 `Ok(false)` 表示没找到图标视图窗口（例如 Explorer 未运行 / 已被第三方接管），
/// 调用方据此提示「本机不支持自动隐藏」而不是报错。
#[cfg(target_os = "windows")]
fn desktop_icons_apply(hidden: bool) -> Result<bool, String> {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE, SW_SHOW};
    let Some(view) = desktop_icon_view() else {
        return Ok(false);
    };
    // SAFETY: view 为系统桌面图标 ListView 的有效 HWND；ShowWindow 仅切可见性。
    unsafe {
        let _ = ShowWindow(view, if hidden { SW_HIDE } else { SW_SHOW });
    }
    Ok(true)
}

#[cfg(not(target_os = "windows"))]
fn desktop_icons_apply(_hidden: bool) -> Result<bool, String> {
    Ok(false)
}

/// 桌面图标当前是否可见（非 Windows / 找不到视图时返回 `true` = 视为可见）。
#[cfg(target_os = "windows")]
fn desktop_icons_visible() -> bool {
    use windows::Win32::UI::WindowsAndMessaging::IsWindowVisible;
    match desktop_icon_view() {
        Some(view) => unsafe { IsWindowVisible(view).as_bool() },
        None => true,
    }
}

#[cfg(not(target_os = "windows"))]
fn desktop_icons_visible() -> bool {
    true
}

/// 取挂件窗自身的 Win32 句柄。
#[cfg(target_os = "windows")]
fn overlay_hwnd(win: &WebviewWindow) -> Result<HWND, String> {
    win.hwnd()
        .map(|raw| HWND(raw.0 as _))
        .map_err(|err| format!("获取挂件窗句柄失败：{err}"))
}

/// 让挂件窗「不抢焦点、不进 Alt+Tab」。
///
/// 贴着桌面的顶层窗口如果可激活，用户一点它就会被提到其它应用窗口之上，
/// 挂件随即变成「挡住工作」的干扰项。`WS_EX_NOACTIVATE` 从根上避免这件事。
#[cfg(target_os = "windows")]
fn make_unfocusable(hwnd: HWND) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };
    // SAFETY: 有效 HWND；只读改写本窗口的扩展样式位。
    unsafe {
        let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let next = current
            | (WS_EX_NOACTIVATE.0 as isize)
            | (WS_EX_TOOLWINDOW.0 as isize);
        if next != current {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
        }
    }
}

/// 把挂件窗插到「桌面窗口正上方」。
#[cfg(target_os = "windows")]
fn place_above_desktop(hwnd: HWND) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };
    let Some(host) = desktop_host() else {
        return Err("未找到桌面窗口（Progman / WorkerW）".to_string());
    };
    // SAFETY: host 为系统桌面窗口有效句柄；hwnd 为本进程窗口有效句柄。
    // 第二个参数的语义是「把 hwnd 放到 host 之上」——正是我们要的分层。
    unsafe {
        SetWindowPos(
            hwnd,
            host,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )
        .map_err(|err| format!("把挂件窗贴到桌面层失败：{err}"))
    }
}

/// 按基准层把挂件窗放到位。
///
/// - `Desktop`：插到桌面窗口正上方；找不到桌面宿主**退回 `Normal`** 并把原因返回
///   （前端据此提示用户，而不是让用户面对一个「看不见的窗」）；
/// - `Normal`：不做任何 Z 序调整（普通顶层窗口）。
fn apply_attach(win: &WebviewWindow, mode: AttachMode) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let hwnd = overlay_hwnd(win)?;
        // 无论哪种模式，挂件都不该抢焦点
        make_unfocusable(hwnd);

        if mode == AttachMode::Desktop {
            return match place_above_desktop(hwnd) {
                Ok(()) => {
                    ATTACH_MODE.store(AttachMode::Desktop.as_u8(), Ordering::Relaxed);
                    Ok(())
                }
                Err(err) => {
                    ATTACH_MODE.store(AttachMode::Normal.as_u8(), Ordering::Relaxed);
                    Err(format!("{err}，挂件已按普通窗口显示"))
                }
            };
        }

        ATTACH_MODE.store(AttachMode::Normal.as_u8(), Ordering::Relaxed);
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (win, mode);
        Ok(())
    }
}

/// 周期复位：**只在 Z 序真的错位时**才重排。
///
/// 每次都无脑 `SetWindowPos` 会让窗口反复重绘 —— 那正是 V20「点一下闪一下」的
/// 观感来源之一。这里用 `GetWindow(hwnd, GW_HWNDNEXT)`（紧贴在我下面的是谁）
/// 判断：桌面窗口就在正下方 = 层级正确，直接返回。
fn reassert_attach(win: &WebviewWindow) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::{GetWindow, GW_HWNDNEXT};
        if AttachMode::current() != AttachMode::Desktop {
            return;
        }
        let Ok(hwnd) = overlay_hwnd(win) else {
            return;
        };
        let Some(host) = desktop_host() else {
            return;
        };
        // SAFETY: 有效 HWND，仅查询 Z 序。
        let below = unsafe { GetWindow(hwnd, GW_HWNDNEXT) }.unwrap_or_else(|_| null_hwnd());
        if below == host {
            return;
        }
        let _ = place_above_desktop(hwnd);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = win;
    }
}

/// 读基准层（无记录 = 默认「贴到桌面」）。
fn read_attach_mode(app: &AppHandle) -> AttachMode {
    let Ok(conn) = connect(app) else {
        return AttachMode::Desktop;
    };
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM grid_meta WHERE key = ?1",
            params![META_KEY_ATTACH],
            |row| row.get(0),
        )
        .ok();
    raw.map(|value| AttachMode::parse(&value))
        .unwrap_or(AttachMode::Desktop)
}

/// 写基准层。
fn write_attach_mode(app: &AppHandle, mode: AttachMode) -> Result<(), String> {
    let conn = connect(app)?;
    conn.execute(
        "INSERT INTO grid_meta (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![META_KEY_ATTACH, mode.as_str()],
    )
    .map_err(|err| format!("保存挂件基准层失败：{err}"))?;
    Ok(())
}

/// 读「系统桌面图标是否被隐藏」的持久化标记。
fn read_icons_hidden(app: &AppHandle) -> bool {
    let Ok(conn) = connect(app) else {
        return false;
    };
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM grid_meta WHERE key = ?1",
            params![META_KEY_ICONS_HIDDEN],
            |row| row.get(0),
        )
        .ok();
    raw.as_deref() == Some("1")
}

/// 写「系统桌面图标是否被隐藏」的持久化标记。
fn write_icons_hidden(app: &AppHandle, hidden: bool) -> Result<(), String> {
    let conn = connect(app)?;
    conn.execute(
        "INSERT INTO grid_meta (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![META_KEY_ICONS_HIDDEN, if hidden { "1" } else { "0" }],
    )
    .map_err(|err| format!("保存桌面图标状态失败：{err}"))?;
    Ok(())
}

/// 读「不再自动收录」名单（JSON 数组；损坏 / 缺失视为空集，不让坏数据废掉同步）。
fn read_dismissed(conn: &Connection) -> Result<std::collections::HashSet<String>, String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM grid_meta WHERE key = ?1",
            params![META_KEY_DISMISSED],
            |row| row.get(0),
        )
        .ok();
    let list = raw
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default();
    Ok(list.into_iter().collect())
}

/// 写「不再自动收录」名单（排序后落库，保证字节稳定）。
fn write_dismissed(
    conn: &Connection,
    set: &std::collections::HashSet<String>,
) -> Result<(), String> {
    let mut list: Vec<String> = set.iter().cloned().collect();
    list.sort();
    let json = serde_json::to_string(&list).map_err(|err| format!("序列化名单失败：{err}"))?;
    conn.execute(
        "INSERT INTO grid_meta (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![META_KEY_DISMISSED, json],
    )
    .map_err(|err| format!("保存名单失败：{err}"))?;
    Ok(())
}

/// 退出 / 启动时无条件恢复桌面系统图标（避免「图标被藏住但应用没了」的尴尬）。
pub fn restore_desktop_icons() {
    let _ = desktop_icons_apply(false);
}

/// 启动时自愈：上次是被强杀 / 崩溃（图标还藏着），这里恢复并清标记。
pub fn heal_desktop_icons(app: &AppHandle) {
    if !read_icons_hidden(app) {
        return;
    }
    match desktop_icons_apply(false) {
        Ok(_) => {
            let _ = write_icons_hidden(app, false);
            println!("[Handy] 检测到上次退出时隐藏了桌面图标，已自动恢复");
        }
        Err(err) => eprintln!("[Handy] 恢复桌面图标失败：{err}"),
    }
}

/// 读取挂件窗基准层（`desktop` | `bottom`）。
#[tauri::command]
pub async fn grid_attach_get(app: AppHandle) -> Result<String, String> {
    Ok(read_attach_mode(&app).as_str().to_string())
}

/// 设置挂件窗基准层并立即生效（窗口不存在时只落库，下次开窗生效）。
#[tauri::command]
pub async fn grid_attach_set(app: AppHandle, mode: String) -> Result<(), String> {
    let parsed = AttachMode::parse(&mode);
    write_attach_mode(&app, parsed)?;
    if let Some(win) = app.get_webview_window(GRID_LABEL) {
        apply_attach(&win, parsed)?;
    }
    Ok(())
}

/// 隐藏 / 恢复桌面系统图标。返回「本机是否支持」（false = 没找到桌面图标视图）。
#[tauri::command]
pub async fn grid_desktop_icons_set(app: AppHandle, hidden: bool) -> Result<bool, String> {
    let supported = desktop_icons_apply(hidden)?;
    if supported {
        write_icons_hidden(&app, hidden)?;
    }
    Ok(supported)
}

/// 查询桌面系统图标当前是否可见。
#[tauri::command]
pub async fn grid_desktop_icons_get() -> Result<bool, String> {
    Ok(desktop_icons_visible())
}


/// Windows 光标命中测试：全局光标（物理像素）→ 挂件窗内坐标 → 区域判定。
#[cfg(target_os = "windows")]
fn cursor_hit_windows(win: &WebviewWindow, regions: &[GridRegion]) -> bool {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let Ok(origin) = win.outer_position() else {
        return false;
    };
    let mut point = POINT::default();
    unsafe {
        if GetCursorPos(&mut point).is_err() {
            return false;
        }
    }
    let rel_x = f64::from(point.x - origin.x);
    let rel_y = f64::from(point.y - origin.y);
    regions
        .iter()
        .any(|r| rel_x >= r.x && rel_y >= r.y && rel_x <= r.x + r.width && rel_y <= r.y + r.height)
}

/// 命中测试入口（非 Windows 平台暂返回 `false`，即保持默认穿透）。
fn cursor_hit(win: &WebviewWindow) -> bool {
    let regions = REGIONS
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default();
    if regions.is_empty() {
        return false;
    }
    #[cfg(target_os = "windows")]
    {
        cursor_hit_windows(win, &regions)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = win;
        false
    }
}

/// 启动（或确认已在运行的）光标轮询线程。
///
/// 生命周期：窗口被销毁（用户 Alt+F4 / grid_overlay_show 重建路径外的关闭）后，
/// 下一轮 `get_webview_window` 返回 `None`，线程自行退出并复位 `POLLER_RUNNING`。
fn ensure_poller(app: AppHandle) {
    if POLLER_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return; // 已有轮询线程在跑
    }
    let spawned = std::thread::Builder::new()
        .name("grid-overlay-poller".into())
        .spawn(move || {
            // 上次施加的穿透态（None = 尚未施加），仅在状态变化时调用窗口 API
            let mut last_ignore: Option<bool> = None;
            let mut tick: u64 = 0;
            loop {
                std::thread::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS));
                let Some(win) = app.get_webview_window(GRID_LABEL) else {
                    // 窗口已销毁 → 图标若仍在代管必须先还回去，再退出线程
                    release_icons_if_taken(&app);
                    break;
                };
                if !win.is_visible().unwrap_or(false) {
                    if last_ignore != Some(true) {
                        let _ = win.set_ignore_cursor_events(true);
                        last_ignore = Some(true);
                    }
                    // 挂件不可见却还代管着图标 = 泄漏（非 grid_overlay_hide 路径的隐藏）
                    release_icons_if_taken(&app);
                    continue;
                }
                tick += 1;
                // 周期性校验层级（错位才重排）：Explorer 重启 / 别的窗口插队后自愈
                if tick % REASSERT_TICKS == 0 {
                    reassert_attach(&win);
                }
                // 白屏自愈（V32）：窗口可见但前端心跳停了 = webview 已死（JS 崩溃 / 白屏，
                // 用户看到的就是「格子显示了一下就没了」）。销毁重建，无需用户发现。
                {
                    let last = LAST_HEARTBEAT.load(Ordering::Relaxed);
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    if last > 0 && now.saturating_sub(last) > HEARTBEAT_TIMEOUT_SECS {
                        eprintln!(
                            "[Handy] 挂件前端心跳超时（{now} - {last} = {}s 无心跳），自动重建挂件窗",
                            now - last
                        );
                        LAST_HEARTBEAT.store(0, Ordering::Relaxed);
                        let _ = win.close();
                        std::thread::sleep(std::time::Duration::from_secs(2));
                        if let Err(err) = show_overlay(&app) {
                            eprintln!("[Handy] 挂件窗重建失败：{err}");
                        }
                        continue;
                    }
                }
                let want_interactive =
                    cursor_hit(&win) || FORCED_INTERACTIVE.load(Ordering::Relaxed);
                if last_ignore != Some(!want_interactive) {
                    let _ = win.set_ignore_cursor_events(!want_interactive);
                    last_ignore = Some(!want_interactive);
                }
            }
            POLLER_RUNNING.store(false, Ordering::SeqCst);
        });
    if let Err(err) = spawned {
        POLLER_RUNNING.store(false, Ordering::SeqCst);
        eprintln!("[Handy] 启动挂件光标轮询失败：{err}");
    }
}

/// 图标当前是否由挂件层代管（true = 已被我们藏起、必须负责恢复）。
/// 挂件窗任何**非正常收起**路径（窗口被销毁、被外部隐藏）由轮询线程据此兜底恢复 ——
/// V30.1 用户实测踩坑：最小化 Handy 后原生桌面回来了、图标却还是空的。
static ICONS_TAKEN: AtomicBool = AtomicBool::new(false);

/// 桌面接管开关（对称）：格子层贴上桌面时隐藏系统图标，收起时恢复。
///
/// 仅在贴桌模式有意义（普通窗口模式下系统图标本来就看得见，无需也不该去动）。
/// 隐藏失败不阻断显示（例如桌面图标视图已被第三方桌面工具接管时找不到句柄），
/// 只留日志 —— 格子层照样可用，只是出现「格子 + 原图标」双层。
fn takeover_icons(app: &AppHandle, hidden: bool) {
    let applied = matches!(desktop_icons_apply(hidden), Ok(true));
    match (hidden, applied) {
        (true, true) => {
            let _ = write_icons_hidden(app, true);
        }
        (true, false) => {
            println!("[Handy] 未找到系统桌面图标视图，跳过自动隐藏（可能已被第三方桌面工具接管）");
        }
        (false, false) => {}
        (false, true) => {
            let _ = write_icons_hidden(app, false);
        }
    }
    // 只有真正把图标藏起来才标记代管；恢复或失败一律解除
    ICONS_TAKEN.store(applied && hidden, Ordering::Relaxed);
}

/// 兜底恢复：挂件层已不可见但图标仍在代管 → 立即还给系统（轮询线程调用）。
fn release_icons_if_taken(app: &AppHandle) {
    if ICONS_TAKEN.swap(false, Ordering::Relaxed) {
        let _ = desktop_icons_apply(false);
        let _ = write_icons_hidden(app, false);
        println!("[Handy] 检测到挂件层已不可见，自动恢复系统桌面图标");
    }
}

/// 创建（幂等复用）并显示挂件窗。
///
/// V32 起格子层**不再自动隐藏系统桌面图标**（用户明确要求「原桌面 + 多一些格子」
/// 的共存形态；自动隐藏还制造过图标泄漏 —— 挂件白屏时图标跟着一起失踪）。
/// 想隐藏图标仍有手动开关（`grid_desktop_icons_set`，管理页）。
fn show_overlay(app: &AppHandle) -> Result<(), String> {
    let mode = read_attach_mode(app);
    // 已存在 → 先归位再显示：避免「先以旧层级画一帧、再跳位」的闪动
    if let Some(existing) = app.get_webview_window(GRID_LABEL) {
        let attach = apply_attach(&existing, mode);
        let _ = existing.show();
        let _ = write_overlay_visible(app, true);
        store_heartbeat_now();
        ensure_poller(app.clone());
        return attach;
    }

    // 几何：DB 优先（逻辑像素），缺省 = 主显示器工作区
    let (x, y, width, height) = match read_geometry(app)? {
        Some(g) if g.width > 0 && g.height > 0 => (
            g.x as f64,
            g.y as f64,
            g.width as f64,
            g.height as f64,
        ),
        _ => default_geometry(app),
    };

    let win = WebviewWindowBuilder::new(app, GRID_LABEL, WebviewUrl::App(GRID_URL.into()))
        .title("桌面挂件 · Handy")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(false)
        .skip_taskbar(true)
        // 先隐藏：等层级摆好再显示，用户看不到「跳一下」的过程
        .visible(false)
        .inner_size(width, height)
        .position(x, y)
        .build()
        .map_err(|err| format!("创建桌面挂件窗口失败：{err}"))?;

    // 默认点击穿透；光标命中盒子区域后由轮询线程开放交互
    let _ = win.set_ignore_cursor_events(true);
    // 按基准层归位（默认「贴到桌面」；失败时窗口仍在，把原因透给前端）
    let attach = apply_attach(&win, mode);
    let _ = win.show();
    let _ = write_overlay_visible(app, true);
    // 心跳基线：给 webview 启动 + React 挂载留出宽限（超时判定见轮询线程）
    store_heartbeat_now();
    ensure_poller(app.clone());
    attach
}

/// 读「挂件层是否应处于显示状态」。
fn read_overlay_visible(app: &AppHandle) -> bool {
    let Ok(conn) = connect(app) else {
        return false;
    };
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM grid_meta WHERE key = ?1",
            params![META_KEY_OVERLAY_VISIBLE],
            |row| row.get(0),
        )
        .ok();
    raw.as_deref() == Some("1")
}

/// 写「挂件层是否应处于显示状态」。
fn write_overlay_visible(app: &AppHandle, visible: bool) -> Result<(), String> {
    let conn = connect(app)?;
    conn.execute(
        "INSERT INTO grid_meta (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![META_KEY_OVERLAY_VISIBLE, if visible { "1" } else { "0" }],
    )
    .map_err(|err| format!("保存挂件显示状态失败：{err}"))?;
    Ok(())
}

/// 应用启动时恢复「上次显示中」的格子层（桌面整理永久生效的关键一步）。
///
/// 由 `lib.rs` setup 在 `db::init` 之后调用；失败只留日志 —— 格子层没恢复
/// 不该拦住整个应用启动。
pub fn restore_overlay_if_visible(app: &AppHandle) {
    if read_overlay_visible(app) {
        if let Err(err) = show_overlay(app) {
            eprintln!("[Handy] 启动恢复桌面格子层失败：{err}");
        }
    }
}

/// 显示（幂等）桌面挂件窗。
#[tauri::command]
pub async fn grid_overlay_show(app: AppHandle) -> Result<(), String> {
    show_overlay(&app)
}

/// 隐藏桌面挂件窗（不销毁，盒子配置保留；再次 show 复用同一窗口）。
#[tauri::command]
pub async fn grid_overlay_hide(app: AppHandle) -> Result<(), String> {
    FORCED_INTERACTIVE.store(false, Ordering::Relaxed);
    if let Some(win) = app.get_webview_window(GRID_LABEL) {
        let _ = win.set_ignore_cursor_events(true);
        win.hide()
            .map_err(|err| format!("隐藏桌面挂件失败：{err}"))?;
    }
    // 收起格子层即交还桌面：系统图标恢复显示（与 show 时隐藏对称）
    takeover_icons(&app, false);
    let _ = write_overlay_visible(&app, false);
    Ok(())
}

// —— 交互 / 命中 / 打开 ——

/// 交互期显式申请：`interactive = true` 保持可交互（拖拽/缩放/重命名期间，防止
/// 光标短暂甩出盒子区域时被轮询线程切回穿透打断）；`false` 交还轮询线程控制。
#[tauri::command]
pub async fn grid_set_interactive(app: AppHandle, interactive: bool) -> Result<(), String> {
    FORCED_INTERACTIVE.store(interactive, Ordering::Relaxed);
    if let Some(win) = app.get_webview_window(GRID_LABEL) {
        win.set_ignore_cursor_events(!interactive)
            .map_err(|err| format!("切换挂件交互状态失败：{err}"))?;
    }
    Ok(())
}

/// 前端上报命中区域（挂件窗客户区内**物理像素**；全量替换）。
#[tauri::command]
pub async fn grid_overlay_update_regions(regions: Vec<GridRegion>) -> Result<(), String> {
    match REGIONS.lock() {
        Ok(mut guard) => *guard = regions,
        Err(_) => return Err("更新挂件命中区域失败（内部状态异常）".to_string()),
    }
    Ok(())
}

// —— 挂件健康监控（V32）：心跳 + 故障上报 + 白屏自愈 ——

/// 挂件前端最近一次心跳的 UNIX 秒时间戳（0 = 尚未心跳过）。
static LAST_HEARTBEAT: AtomicU64 = AtomicU64::new(0);

/// 心跳超时阈值（秒）：超过即判定 webview 已死（白屏 / JS 崩溃），重建挂件窗。
const HEARTBEAT_TIMEOUT_SECS: u64 = 90;

/// `grid_meta` 中「挂件最近一次前端故障」的键名（管理页展示，供用户截图反馈）。
const META_KEY_OVERLAY_FAULT: &str = "overlay_last_fault";

/// 记录当前时间为中心跳基线。
fn store_heartbeat_now() {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    LAST_HEARTBEAT.store(now, Ordering::Relaxed);
}

/// 挂件前端心跳（每 10 秒一次；JS 存活即有心跳）。
#[tauri::command]
pub async fn grid_overlay_heartbeat() -> Result<(), String> {
    store_heartbeat_now();
    Ok(())
}

/// 挂件前端故障上报（window.onerror / unhandledrejection 捕获）。
///
/// 写日志 + 落库（管理页展示）——白屏这类「看不见的故障」从此有据可查。
#[tauri::command]
pub async fn grid_overlay_fault(app: AppHandle, message: String) -> Result<(), String> {
    eprintln!("[Handy][挂件故障] {message}");
    let conn = connect(&app)?;
    conn.execute(
        "INSERT INTO grid_meta (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![
            META_KEY_OVERLAY_FAULT,
            format!(
                "{} {}",
                chrono::Local::now().format("%m-%d %H:%M"),
                message.chars().take(300).collect::<String>()
            )
        ],
    )
    .map_err(|err| format!("记录挂件故障失败：{err}"))?;
    Ok(())
}

/// 读取挂件最近一次故障（无记录返回 null）。
#[tauri::command]
pub async fn grid_overlay_fault_get(app: AppHandle) -> Result<Option<String>, String> {
    let conn = connect(&app)?;
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM grid_meta WHERE key = ?1",
            params![META_KEY_OVERLAY_FAULT],
            |row| row.get(0),
        )
        .ok();
    Ok(raw)
}

/// 打开条目原文件（经 shell 插件 Rust API 唤起系统默认程序）。
///
/// 说明：本地路径打开走 Rust 侧 `shell().open`，不经前端 `shell:allow-open` 的
/// URL 作用域校验（该作用域默认仅放行 http/mailto/tel），保证「打开原文件」
/// 这一核心能力不被作用域误伤；同时 capabilities 仍按任务要求扩展了 open 作用域，
/// 供前端 `ipc.shellOpen` 等既有调用使用。
#[tauri::command]
pub async fn grid_open_path(app: AppHandle, path: String) -> Result<(), String> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("文件路径为空".to_string());
    }
    // 「系统」格子的虚拟条目（::{CLSID}，如此电脑 / 回收站）：不走 shell 插件，
    // 直接 ShellExecuteW 打开 shell 命名空间 —— 插件对非文件系统路径的校验
    // 不可控，这里显式处理并检查返回值（≤32 = 失败码）。
    #[cfg(target_os = "windows")]
    if path.starts_with("::") {
        use windows::core::PCWSTR;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let verb = wide("open");
        let target = wide(&path);
        let result = unsafe {
            ShellExecuteW(
                None,
                PCWSTR(verb.as_ptr()),
                PCWSTR(target.as_ptr()),
                None,
                None,
                SW_SHOWNORMAL,
            )
        };
        if (result.0 as isize) <= 32 {
            return Err(format!(
                "打开系统位置失败（ShellExecute 返回 {}）",
                result.0 as isize
            ));
        }
        return Ok(());
    }
    use tauri_plugin_shell::ShellExt;
    // shell::open 自 2.1 起标记 deprecated（官方建议迁移 tauri-plugin-opener）；
    // 本项目继续沿用已集成的 shell 插件，暂不引入新依赖，显式压掉弃用告警。
    #[allow(deprecated)]
    app.shell()
        .open(path, None)
        .map_err(|err| format!("打开文件失败：{err}"))
}

// ————————————————————————————————————————————————————————————————
// 一键整理 / 布局备份与还原（V19）
//
// 对标「桌面整理工具」的核心体验：**一键把满屏图标归置成几个格子**、
// **布局可备份可还原**。与 V12「建目录 + 移动文件」的根本区别仍然是
// **零磁盘副作用**：整理的是「桌面图标的呈现方式」，文件本体一个字节都不动。
// 因此「还原布局」只是丢弃 / 重建格子，不涉及任何文件回迁，天然安全。
// ————————————————————————————————————————————————————————————————

/// 一键整理的格子排布：从左上角起、每行 [`ARRANGE_COLUMNS`] 个、按网格递进。
const ARRANGE_COLUMNS: i64 = 3;
const ARRANGE_ORIGIN_X: i64 = 40;
const ARRANGE_ORIGIN_Y: i64 = 40;
const ARRANGE_STEP_X: i64 = 344;
const ARRANGE_STEP_Y: i64 = 268;
const ARRANGE_BOX_W: i64 = 320;
const ARRANGE_BOX_H: i64 = 244;

/// 一键整理结果摘要（前端据此提示「收了几个格子、几个文件」）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoArrangeReport {
    /// 桌面上扫描到的可见条目数（已排除隐藏 / 系统文件与符号链接）
    pub scanned: usize,
    /// 本次新建的格子数
    pub boxes_created: usize,
    /// 复用了同名已有格子的次数
    pub boxes_reused: usize,
    /// 新登记的条目引用数
    pub items_added: usize,
    /// 已在格子中、本次跳过的条目数
    pub skipped: usize,
}

/// 把扫描结果归入「格子名」：文件夹单独一组，文件按扩展名类别分组。
fn arrange_group_of(item: &crate::commands::organizer::OrganizerItem) -> String {
    if item.is_dir {
        return "文件夹".to_string();
    }
    if item.category.is_empty() {
        return "其他".to_string();
    }
    item.category.clone()
}

/// 分组展示顺序：文件夹最前，「其他」最后，中间类别保持扫描自然顺序。
fn arrange_group_rank(name: &str) -> i64 {
    match name {
        "文件夹" => 0,
        "其他" => 2,
        _ => 1,
    }
}

/// 一键整理核心（连接与目录由调用方给定，命令与桌面同步共用）。
///
/// - **不移动 / 不复制 / 不重命名任何文件**，只新建格子与引用；
/// - 同名格子直接复用（再次整理是**增量补充**，不会越点越多格子）；
/// - 已登记过的文件全局去重，不会在多个格子里重复出现；
/// - `dismissed` 名单里的路径（用户点 × 移除过的）跳过，不违背用户决定。
fn auto_arrange_inner(
    conn: &Connection,
    root: &std::path::Path,
    dismissed: &std::collections::HashSet<String>,
) -> Result<AutoArrangeReport, String> {
    use std::collections::{HashMap, HashSet};

    // 复用 organizer 的扫描：已排除隐藏 / 系统文件与 symlink，并带好 by-type 类别
    let scanned = crate::commands::organizer::scan_items(root)?;
    let total_scanned = scanned.len();

    // 已登记的文件路径（跨全部格子）—— 同一文件不重复登记
    let mut known: HashSet<String> = HashSet::new();
    {
        let mut stmt = conn
            .prepare("SELECT file_path FROM grid_items")
            .map_err(|err| format!("读取已有条目失败：{err}"))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|err| format!("读取已有条目失败：{err}"))?;
        for row in rows {
            known.insert(row.map_err(|err| format!("读取已有条目失败：{err}"))?);
        }
    }

    // 已有格子：名称 → id；`occupied` 记录已占用的排布槽位，新格子往后排
    let mut existing: HashMap<String, i64> = HashMap::new();
    let mut occupied: i64 = 0;
    {
        let mut stmt = conn
            .prepare("SELECT id, name FROM grid_boxes ORDER BY sort ASC, id ASC")
            .map_err(|err| format!("读取格子失败：{err}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|err| format!("读取格子失败：{err}"))?;
        for row in rows {
            let (id, name) = row.map_err(|err| format!("读取格子失败：{err}"))?;
            occupied += 1;
            existing.insert(name, id);
        }
    }

    // 按类别分组（保持扫描顺序，末尾统一排序把「文件夹」提前、「其他」压后）
    let mut grouped: Vec<(String, Vec<usize>)> = Vec::new();
    for (index, item) in scanned.iter().enumerate() {
        let key = arrange_group_of(item);
        match grouped.iter_mut().find(|(name, _)| *name == key) {
            Some((_, bucket)) => bucket.push(index),
            None => grouped.push((key, vec![index])),
        }
    }
    grouped.sort_by_key(|(name, _)| arrange_group_rank(name));

    let mut report = AutoArrangeReport {
        scanned: total_scanned,
        boxes_created: 0,
        boxes_reused: 0,
        items_added: 0,
        skipped: 0,
    };

    for (label, indices) in grouped {
        // 本组里还没被登记过、且不在「不再收录」名单里的文件
        let fresh: Vec<usize> = indices
            .into_iter()
            .filter(|index| {
                scanned.get(*index).map_or(false, |item| {
                    !known.contains(&item.path) && !dismissed.contains(&item.path)
                })
            })
            .collect();
        if fresh.is_empty() {
            report.skipped += 1;
            continue;
        }

        let box_id: i64 = match existing.get(&label) {
            Some(id) => {
                report.boxes_reused += 1;
                *id
            }
            None => {
                let now = now_iso();
                let pos_x = ARRANGE_ORIGIN_X + (occupied % ARRANGE_COLUMNS) * ARRANGE_STEP_X;
                let pos_y = ARRANGE_ORIGIN_Y + (occupied / ARRANGE_COLUMNS) * ARRANGE_STEP_Y;
                // 全表求最大值：该 SQL 无占位符，必须传 None
                let sort = next_sort(
                    &conn,
                    "SELECT COALESCE(MAX(sort) + 1, 0) FROM grid_boxes",
                    None,
                )?;
                conn.execute(
                    "INSERT INTO grid_boxes \
                     (name, pos_x, pos_y, width, height, sort, created_at, updated_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        label,
                        pos_x,
                        pos_y,
                        ARRANGE_BOX_W,
                        ARRANGE_BOX_H,
                        sort,
                        now,
                        now,
                    ],
                )
                .map_err(|err| format!("创建格子「{label}」失败：{err}"))?;
                let id = conn.last_insert_rowid();
                existing.insert(label.clone(), id);
                occupied += 1;
                report.boxes_created += 1;
                id
            }
        };

        let mut item_sort = next_sort(
            &conn,
            "SELECT COALESCE(MAX(sort) + 1, 0) FROM grid_items WHERE box_id = ?1",
            Some(box_id),
        )?;
        let created = now_iso();
        for index in fresh {
            let Some(item) = scanned.get(index) else {
                continue;
            };
            conn.execute(
                "INSERT INTO grid_items (box_id, file_path, display_name, sort, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![box_id, item.path, item.name, item_sort, created],
            )
            .map_err(|err| format!("登记「{}」失败：{err}", item.name))?;
            known.insert(item.path.clone());
            item_sort += 1;
            report.items_added += 1;
        }
    }

    Ok(report)
}

/// 一键整理桌面：扫描 → 按类型分组 → 每组一个格子 + 登记引用。
///
/// `dir` 仅供测试 / 自定义目录，缺省为用户桌面。
#[tauri::command]
pub async fn grid_auto_arrange(
    app: AppHandle,
    dir: Option<String>,
) -> Result<AutoArrangeReport, String> {
    let root: std::path::PathBuf = match dir {
        Some(value) if !value.trim().is_empty() => std::path::PathBuf::from(value.trim()),
        _ => dirs::desktop_dir().ok_or_else(|| "无法定位桌面目录".to_string())?,
    };
    let conn = connect(&app)?;
    auto_arrange_inner(&conn, &root, &read_dismissed(&conn)?)
}

/// 清理失效引用：桌面根目录下的文件已被删除 / 移走的条目直接删除。
///
/// 只清**桌面根目录**的失效引用 —— 用户从其他目录手动拖入的引用（如 U 盘、
/// 网盘路径）可能只是暂时不可达，静默删掉用户手工整理的引用弊大于利；
/// 打开时自然会报「文件不存在」，由用户自己处置。
fn prune_missing_items(conn: &Connection, desktop: &std::path::Path) -> Result<usize, String> {
    let rows: Vec<(i64, String)> = {
        let mut stmt = conn
            .prepare("SELECT id, file_path FROM grid_items")
            .map_err(|err| format!("读取条目清单失败：{err}"))?;
        let mapped = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|err| format!("读取条目清单失败：{err}"))?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("读取条目清单失败：{err}"))?
    };
    let desktop_str = desktop.to_string_lossy().trim_end_matches(['\\', '/']).to_string();
    let mut removed = 0usize;
    for (id, path) in rows {
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().trim_end_matches(['\\', '/']).to_string());
        // 只处置「确实住在桌面根目录且已不存在」的引用；其他一律保留
        let is_desktop_child = parent
            .map(|p| p.eq_ignore_ascii_case(&desktop_str))
            .unwrap_or(false);
        if !is_desktop_child || std::path::Path::new(&path).exists() {
            continue;
        }
        let affected = conn
            .execute("DELETE FROM grid_items WHERE id = ?1", params![id])
            .map_err(|err| format!("清理失效引用失败：{err}"))?;
        removed += affected;
    }
    Ok(removed)
}

/// 桌面同步报告：一键整理结果 + 失效引用清理数。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSyncReport {
    #[serde(flatten)]
    pub arrange: AutoArrangeReport,
    /// 本次清理的失效引用数（桌面文件已被删除 / 移走）
    pub pruned: usize,
}

/// Shell 图标数据（RGBA 像素，base64；前端转 dataURL 渲染）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIconData {
    pub width: u32,
    pub height: u32,
    /// RGBA 像素（逐行、每像素 4 字节）的 base64
    pub rgba_base64: String,
}

/// 手写 base64（避免为一个编码器引入依赖；输入 ≤ 32×32×4 字节，性能无感）。
fn b64_encode(data: &[u8]) -> String {
    const TBL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = chunk.get(1).map_or(0, |v| u32::from(*v));
        let b2 = chunk.get(2).map_or(0, |v| u32::from(*v));
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TBL[(n >> 18) as usize & 63] as char);
        out.push(TBL[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TBL[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TBL[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// 提取文件 / 文件夹的 Shell 真实图标（32×32），转 RGBA 后 base64 返回。
///
/// 「接管桌面」的观感关键：格子里渲染**系统真实图标**（与资源管理器一致，
/// .lnk 自动解析为目标图标），而不是通用线条图标 —— 用户一眼认出「这是我的文件」。
/// 失败返回 None，前端回退通用图标；先查桌面再查其他路径，绝不做任何写操作。
#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn grid_file_icon(path: String) -> Result<Option<FileIconData>, String> {
    // SHGetFileInfo 会触达磁盘与图标缓存，放阻塞线程池避免占用 async 运行时
    tauri::async_runtime::spawn_blocking(move || extract_icon_rgba(&path))
        .await
        .map_err(|err| format!("图标提取任务失败：{err}"))
}

/// 非 Windows 平台暂不支持 Shell 图标提取，前端回退通用图标。
#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn grid_file_icon(_path: String) -> Result<Option<FileIconData>, String> {
    Ok(None)
}

/// SHGetFileInfo → GetIconInfo → GetDIBits 的完整提取链（Windows）。
///
/// 外壳负责 COM 生命周期：`.lnk` 快捷方式的图标解析走 shell 命名空间，
/// 阻塞线程池的线程默认没有 COM —— 不初始化的话文件夹图标能出、快捷方式全失败
/// （V30.1 实测：格子里的 .lnk 全是回退图标）。
#[cfg(target_os = "windows")]
fn extract_icon_rgba(path: &str) -> Option<FileIconData> {
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    unsafe {
        // 已初始化（模式不同）也不报错，沿用现态即可
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }
    let result = extract_icon_rgba_impl(path);
    unsafe {
        CoUninitialize();
    }
    result
}

/// 提取链本体（调用方需保证本线程已初始化 COM）。
#[cfg(target_os = "windows")]
fn extract_icon_rgba_impl(path: &str) -> Option<FileIconData> {
    use std::os::windows::ffi::OsStrExt;

    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, BITMAPINFO, BITMAPINFOHEADER,
        DIB_RGB_COLORS, HBITMAP,
    };
    use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
    use windows::Win32::UI::Shell::{
        SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON,
    };
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};

    let wide: Vec<u16> = std::ffi::OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut sfi = SHFILEINFOW::default();
    let ok = unsafe {
        SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            FILE_ATTRIBUTE_NORMAL,
            Some(&mut sfi as *mut SHFILEINFOW as *mut _),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        )
    };
    if ok == 0 || sfi.hIcon.is_invalid() {
        return None;
    }

    // 内联小闭包统一清理；返回值经 Option 透传
    let result: Option<FileIconData> = (|| {
        unsafe {
            let mut info = ICONINFO::default();
            if GetIconInfo(sfi.hIcon, &mut info).is_err() {
                return None;
            }
            let hdc = CreateCompatibleDC(None);
            if hdc.is_invalid() {
                let _ = DeleteObject(info.hbmMask).ok();
                let _ = DeleteObject(info.hbmColor).ok();
                return None;
            }

            let read_bitmap = |hbm: HBITMAP, bit_count: u16| -> Option<Vec<u8>> {
                let mut bmi = BITMAPINFO::default();
                bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
                // 第一次调用不取像素，只回填尺寸信息
                GetDIBits(hdc, hbm, 0, 0, None, &mut bmi, DIB_RGB_COLORS);
                let w = bmi.bmiHeader.biWidth;
                if w <= 0 {
                    return None;
                }
                let h = bmi.bmiHeader.biHeight.unsigned_abs();
                bmi.bmiHeader.biHeight = -bmi.bmiHeader.biHeight; // top-down
                bmi.bmiHeader.biBitCount = bit_count;
                bmi.bmiHeader.biCompression = 0u32; // BI_RGB
                let stride = ((w as usize * bit_count as usize + 31) / 32) * 4;
                let mut buf = vec![0u8; stride * h as usize];
                let lines = GetDIBits(
                    hdc,
                    hbm,
                    0,
                    h,
                    Some(buf.as_mut_ptr() as *mut _),
                    &mut bmi,
                    DIB_RGB_COLORS,
                );
                if lines == 0 {
                    return None;
                }
                Some(buf)
            };

            let color = read_bitmap(info.hbmColor, 32);
            let mask = if color.is_some() {
                read_bitmap(info.hbmMask, 1)
            } else {
                None
            };
            let _ = DeleteDC(hdc).ok();
            let _ = DeleteObject(info.hbmMask).ok();
            let _ = DeleteObject(info.hbmColor).ok();
            let mut color = color?;

            let w = (color.len() / 4).max(1);
            // GetDIBits 给的是 BGRA 且多为自下而上（biHeight 已取负转 top-down 后即按行序），
            // 交换 R/B 到 RGBA；全零 alpha（老式无 alpha 通道图标）用掩码位补齐。
            let all_transparent = color.chunks_exact(4).all(|px| px[3] == 0);
            for (index, px) in color.chunks_exact_mut(4).enumerate() {
                px.swap(0, 2);
                if all_transparent {
                    let x = index % w;
                    let byte = mask.as_ref().and_then(|m| m.get(x / 8)).copied().unwrap_or(0);
                    let opaque = (byte >> (7 - (x % 8))) & 1 == 0; // 0 = 不透明
                    px[3] = if opaque { 255 } else { 0 };
                }
            }

            let side = (w as f64).sqrt().round() as u32;
            let (width, height) = if w > 0 && side * side == w as u32 {
                (side, side)
            } else {
                (w as u32, 1)
            };
            Some(FileIconData {
                width,
                height,
                rgba_base64: b64_encode(&color),
            })
        }
    })();

    unsafe {
        let _ = DestroyIcon(sfi.hIcon);
    }
    result
}

/// 「系统」格子兜底：桌面图标被隐藏后，「此电脑 / 回收站」也随之消失 ——
/// 这两个系统入口不该跟着没了。同步时确保存在一个「系统」格子放这两个虚拟路径
/// （CLSID；打开经 ShellExecute、图标经 SHGetFileInfo 均可正常解析）。
/// 用户点 × 移除过（dismissed 名单）的不强行塞回。
fn ensure_system_box(
    conn: &Connection,
    dismissed: &std::collections::HashSet<String>,
) -> Result<(), String> {
    const SYSTEM_ENTRIES: [(&str, &str); 2] = [
        ("此电脑", "::{20D04FE0-3AEA-1069-A2D8-08002B30309D}"),
        ("回收站", "::{645FF040-5081-101B-9F08-00AA002F954E}"),
    ];
    let missing: Vec<(&str, &str)> = SYSTEM_ENTRIES
        .iter()
        .copied()
        .filter(|(_, clsid)| !dismissed.contains(*clsid))
        .filter(|(_, clsid)| {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM grid_items WHERE file_path = ?1",
                    params![clsid],
                    |row| row.get(0),
                )
                .unwrap_or(0);
            count == 0
        })
        .collect();
    if missing.is_empty() {
        return Ok(());
    }

    let box_id: i64 = match conn.query_row(
        "SELECT id FROM grid_boxes WHERE name = '系统' LIMIT 1",
        [],
        |row| row.get(0),
    ) {
        Ok(id) => id,
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            let occupied: i64 = conn
                .query_row("SELECT COUNT(*) FROM grid_boxes", [], |row| row.get(0))
                .map_err(|err| format!("统计格子数失败：{err}"))?;
            let pos_x = ARRANGE_ORIGIN_X + (occupied % ARRANGE_COLUMNS) * ARRANGE_STEP_X;
            let pos_y = ARRANGE_ORIGIN_Y + (occupied / ARRANGE_COLUMNS) * ARRANGE_STEP_Y;
            let sort = next_sort(
                conn,
                "SELECT COALESCE(MAX(sort) + 1, 0) FROM grid_boxes",
                None,
            )?;
            let now = now_iso();
            conn.execute(
                "INSERT INTO grid_boxes \
                 (name, pos_x, pos_y, width, height, sort, created_at, updated_at) \
                 VALUES ('系统', ?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![pos_x, pos_y, ARRANGE_BOX_W, ARRANGE_BOX_H, sort, now, now],
            )
            .map_err(|err| format!("创建系统格子失败：{err}"))?;
            conn.last_insert_rowid()
        }
        Err(err) => return Err(format!("查询系统格子失败：{err}")),
    };

    let mut item_sort = next_sort(
        conn,
        "SELECT COALESCE(MAX(sort) + 1, 0) FROM grid_items WHERE box_id = ?1",
        Some(box_id),
    )?;
    let created = now_iso();
    for (name, clsid) in missing {
        conn.execute(
            "INSERT INTO grid_items (box_id, file_path, display_name, sort, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![box_id, clsid, name, item_sort, created],
        )
        .map_err(|err| format!("登记系统条目「{name}」失败：{err}"))?;
        item_sort += 1;
    }
    Ok(())
}

/// 桌面同步 —— 格子层「接管桌面」的数据引擎（前端周期调用）：
///
/// 1. 清理失效引用（桌面文件已被删除 / 移走的条目）；
/// 2. 增量收纳：桌面上还没进格子的文件按类型收进对应格子（缺格子则新建）；
/// 3. 用户点 × 移除过的文件（dismissed 名单）不违背其意愿。
///
/// 因此**桌面根目录的每个可见文件都始终在某个格子里**：新建的文件几秒内
/// 自动出现，删掉的自动消失 —— 这是与「腾讯桌面整理」对齐的核心体验。
#[tauri::command]
pub async fn grid_desktop_sync(app: AppHandle) -> Result<DesktopSyncReport, String> {
    let root = dirs::desktop_dir().ok_or_else(|| "无法定位桌面目录".to_string())?;
    let conn = connect(&app)?;
    let dismissed = read_dismissed(&conn)?;
    let pruned = prune_missing_items(&conn, &root)?;
    let arrange = auto_arrange_inner(&conn, &root, &dismissed)?;
    ensure_system_box(&conn, &dismissed)?;
    Ok(DesktopSyncReport { arrange, pruned })
}

/// 布局文件里的单条引用。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutItem {
    pub file_path: String,
    pub display_name: String,
    pub sort: i64,
}

/// 布局文件里的单个格子。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutBox {
    pub name: String,
    pub pos_x: i64,
    pub pos_y: i64,
    pub width: i64,
    pub height: i64,
    pub sort: i64,
    pub items: Vec<LayoutItem>,
}

/// 桌面布局快照（备份文件的内容；`version` 供将来结构升级时判断兼容性）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridLayout {
    pub version: i64,
    pub exported_at: String,
    pub boxes: Vec<LayoutBox>,
}

/// 布局还原结果摘要。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutImportReport {
    pub boxes: usize,
    pub items: usize,
    /// 快照里指向的文件当前已不存在（引用仍会恢复，打开时才提示 —— 不静默丢弃）
    pub missing_files: usize,
}

/// 组装当前布局快照（内部原语：导出到文件与「备份到本机」共用）。
fn build_layout(conn: &Connection) -> Result<GridLayout, String> {
    let box_rows: Vec<GridBox> = {
        let sql = format!(
            "SELECT {BOX_COLUMNS}, \
             (SELECT COUNT(*) FROM grid_items i WHERE i.box_id = b.id) AS item_count \
             FROM grid_boxes b ORDER BY b.sort ASC, b.id ASC"
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|err| format!("导出布局失败：{err}"))?;
        // 分两步绑定：`mapped` 必须比 `stmt` 后声明（drop 顺序倒过来），
        // 否则借用中的迭代器会先于语句被释放 —— E0597。
        let mapped = stmt
            .query_map([], row_to_box_with_count)
            .map_err(|err| format!("导出布局失败：{err}"))?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("导出布局失败：{err}"))?
    };

    let mut boxes: Vec<LayoutBox> = Vec::with_capacity(box_rows.len());
    for row in box_rows {
        let mut stmt = conn
            .prepare(
                "SELECT file_path, display_name, sort FROM grid_items \
                 WHERE box_id = ?1 ORDER BY sort ASC, id ASC",
            )
            .map_err(|err| format!("导出布局失败：{err}"))?;
        let items = stmt
            .query_map(params![row.id], |item| {
                Ok(LayoutItem {
                    file_path: item.get(0)?,
                    display_name: item.get(1)?,
                    sort: item.get(2)?,
                })
            })
            .map_err(|err| format!("导出布局失败：{err}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("导出布局失败：{err}"))?;
        boxes.push(LayoutBox {
            name: row.name,
            pos_x: row.pos_x,
            pos_y: row.pos_y,
            width: row.width,
            height: row.height,
            sort: row.sort,
            items,
        });
    }

    Ok(GridLayout {
        version: 1,
        exported_at: now_iso(),
        boxes,
    })
}

/// 把一份布局快照落到库里（**替换式**：先清空现有格子，再按快照重建）。
///
/// 调用方 `grid_layout_restore` 会先把当前布局另存为「还原前自动备份」，
/// 因此这一步虽是破坏性的，但始终有回退路径。
fn apply_layout(conn: &mut Connection, layout: &GridLayout) -> Result<LayoutImportReport, String> {
    if layout.version != 1 {
        return Err(format!(
            "布局快照版本不受支持（{0}，当前支持 1）",
            layout.version
        ));
    }

    let tx = conn
        .transaction()
        .map_err(|err| format!("还原布局失败：{err}"))?;

    // 清空（grid_items 由外键 ON DELETE CASCADE 级联，这里显式删两遍更直观）
    tx.execute("DELETE FROM grid_items", [])
        .map_err(|err| format!("清空旧条目失败：{err}"))?;
    tx.execute("DELETE FROM grid_boxes", [])
        .map_err(|err| format!("清空旧格子失败：{err}"))?;

    let created = now_iso();
    let mut item_total = 0usize;
    let mut missing = 0usize;

    for (index, entry) in layout.boxes.iter().enumerate() {
        tx.execute(
            "INSERT INTO grid_boxes \
             (name, pos_x, pos_y, width, height, sort, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                clean_name(Some(entry.name.clone())),
                entry.pos_x,
                entry.pos_y,
                entry.width.max(160),
                entry.height.max(120),
                if entry.sort != 0 { entry.sort } else { index as i64 },
                created,
                created,
            ],
        )
        .map_err(|err| format!("还原格子「{}」失败：{err}", entry.name))?;
        let box_id = tx.last_insert_rowid();

        for (item_index, item) in entry.items.iter().enumerate() {
            if !std::path::Path::new(&item.file_path).exists() {
                missing += 1;
            }
            tx.execute(
                "INSERT INTO grid_items (box_id, file_path, display_name, sort, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    box_id,
                    item.file_path,
                    item.display_name,
                    if item.sort != 0 { item.sort } else { item_index as i64 },
                    created,
                ],
            )
            .map_err(|err| format!("还原条目「{}」失败：{err}", item.display_name))?;
            item_total += 1;
        }
    }

    tx.commit()
        .map_err(|err| format!("提交布局还原失败：{err}"))?;

    Ok(LayoutImportReport {
        boxes: layout.boxes.len(),
        items: item_total,
        missing_files: missing,
    })
}

/// 导出当前桌面布局快照（供「导出到文件 / 分享给别人」等外部通道使用）。
#[tauri::command]
pub async fn grid_layout_export(app: AppHandle) -> Result<GridLayout, String> {
    let conn = connect(&app)?;
    build_layout(&conn)
}

/// 用一份外部布局快照覆盖当前布局（替换式；调用方需自行确认）。
#[tauri::command]
pub async fn grid_layout_import(
    app: AppHandle,
    layout: GridLayout,
) -> Result<LayoutImportReport, String> {
    let mut conn = connect(&app)?;
    apply_layout(&mut conn, &layout)
}

// ————————————————————————————————————————————————————————————————
// 布局快照（备份 / 还原布局）
//
// 存 `grid_meta`：`key = "layout:<uuid>"`，`value = 快照 JSON`。
// 之所以不落成文件：备份/还原本就是「同一台机器上两种桌面摆放方式来回切」，
// 放库里既省一次文件对话框，也天然跟着数据库备份走（见 commands/backup.rs）。
// ————————————————————————————————————————————————————————————————

/// `grid_meta` 中布局快照的键前缀。
const META_KEY_LAYOUT_PREFIX: &str = "layout:";

/// 还原前自动备份使用的固定 id（幂等覆盖，不随还原次数堆积）。
const LAYOUT_AUTO_BACKUP_ID: &str = "auto-before-restore";

/// 布局快照摘要（列表用；不带完整 layout，省往返体积）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutSnapshotMeta {
    pub id: String,
    pub name: String,
    pub saved_at: String,
    pub box_count: usize,
    pub item_count: usize,
}

/// 落库的快照完整内容。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LayoutSnapshot {
    id: String,
    name: String,
    saved_at: String,
    layout: GridLayout,
}

/// 快照 → 摘要。
fn snapshot_meta(snapshot: &LayoutSnapshot) -> LayoutSnapshotMeta {
    LayoutSnapshotMeta {
        id: snapshot.id.clone(),
        name: snapshot.name.clone(),
        saved_at: snapshot.saved_at.clone(),
        box_count: snapshot.layout.boxes.len(),
        item_count: snapshot
            .layout
            .boxes
            .iter()
            .map(|box_item| box_item.items.len())
            .sum(),
    }
}

/// 写入一份快照（同 id 覆盖）。
fn save_snapshot(conn: &Connection, snapshot: &LayoutSnapshot) -> Result<(), String> {
    let value = serde_json::to_string(snapshot)
        .map_err(|err| format!("序列化布局快照失败：{err}"))?;
    conn.execute(
        "INSERT INTO grid_meta (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![format!("{META_KEY_LAYOUT_PREFIX}{}", snapshot.id), value],
    )
    .map_err(|err| format!("保存布局快照失败：{err}"))?;
    Ok(())
}

/// 读一份快照（不存在返回中文错误）。
fn load_snapshot(conn: &Connection, snapshot_id: &str) -> Result<LayoutSnapshot, String> {
    let key = format!("{META_KEY_LAYOUT_PREFIX}{snapshot_id}");
    let raw: String = conn
        .query_row(
            "SELECT value FROM grid_meta WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .map_err(|_| format!("找不到布局快照（{snapshot_id}）"))?;
    serde_json::from_str(&raw).map_err(|err| format!("解析布局快照失败：{err}"))
}

/// 把当前桌面布局备份成一份本机快照。
#[tauri::command]
pub async fn grid_layout_save(
    app: AppHandle,
    name: Option<String>,
) -> Result<LayoutSnapshotMeta, String> {
    let conn = connect(&app)?;
    let layout = build_layout(&conn)?;
    let saved_at = now_iso();
    let label = match name {
        Some(raw) if !raw.trim().is_empty() => raw.trim().to_string(),
        _ => format!("布局 {saved_at}"),
    };
    let snapshot = LayoutSnapshot {
        id: uuid::Uuid::new_v4().to_string(),
        name: label,
        saved_at,
        layout,
    };
    save_snapshot(&conn, &snapshot)?;
    Ok(snapshot_meta(&snapshot))
}

/// 列出全部布局快照（按保存时间倒序；含「还原前自动备份」）。
#[tauri::command]
pub async fn grid_layout_list(app: AppHandle) -> Result<Vec<LayoutSnapshotMeta>, String> {
    let conn = connect(&app)?;
    let mut stmt = conn
        .prepare("SELECT value FROM grid_meta WHERE key LIKE ?1")
        .map_err(|err| format!("读取布局快照失败：{err}"))?;
    let rows = stmt
        .query_map(params![format!("{META_KEY_LAYOUT_PREFIX}%")], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|err| format!("读取布局快照失败：{err}"))?;

    let mut metas: Vec<LayoutSnapshotMeta> = Vec::new();
    for row in rows {
        let raw = row.map_err(|err| format!("读取布局快照失败：{err}"))?;
        // 单条解析失败只跳过这一条，不让一份坏数据废掉整个列表
        if let Ok(snapshot) = serde_json::from_str::<LayoutSnapshot>(&raw) {
            metas.push(snapshot_meta(&snapshot));
        }
    }
    metas.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
    Ok(metas)
}

/// 从某份快照还原布局（替换式）。
///
/// **还原前自动备份**：先把当前布局另存为「还原前自动备份」（固定 id，覆盖式），
/// 于是「还原错了」也能再还原回来 —— 破坏性操作必须有回退路径。
#[tauri::command]
pub async fn grid_layout_restore(
    app: AppHandle,
    snapshot_id: String,
) -> Result<LayoutImportReport, String> {
    let mut conn = connect(&app)?;
    let snapshot = load_snapshot(&conn, &snapshot_id)?;

    // 自动备份当前布局（失败不阻断还原：这是「额外保险」，不是前置条件）
    if let Ok(current) = build_layout(&conn) {
        let auto = LayoutSnapshot {
            id: LAYOUT_AUTO_BACKUP_ID.to_string(),
            name: "还原前自动备份".to_string(),
            saved_at: now_iso(),
            layout: current,
        };
        let _ = save_snapshot(&conn, &auto);
    }

    apply_layout(&mut conn, &snapshot.layout)
}

/// 删除一份布局快照。
#[tauri::command]
pub async fn grid_layout_delete(app: AppHandle, snapshot_id: String) -> Result<(), String> {
    let conn = connect(&app)?;
    let affected = conn
        .execute(
            "DELETE FROM grid_meta WHERE key = ?1",
            params![format!("{META_KEY_LAYOUT_PREFIX}{snapshot_id}")],
        )
        .map_err(|err| format!("删除布局快照失败：{err}"))?;
    if affected == 0 {
        return Err("布局快照不存在或已被删除".to_string());
    }
    Ok(())
}

