//! 桌面网格挂件（desktop grid widget）——「文件引用型」桌面整理（M2 改版）。
//!
//! 设计原则（用户明确否决 V12「建目录 + 移动文件」方案）：
//!   - **零磁盘副作用**：挂件条目只是原文件路径的**引用**（`grid_items.file_path`），
//!     打开经 shell 插件唤起系统默认程序打开**原文件**，从不移动 / 复制 / 重命名；
//!   - **桌面层挂件窗**：`grid-overlay` 无边框透明窗，位于壁纸之上、普通应用窗口之下
//!     —— Tauri 2 无 always-on-bottom API，Windows 经 `SetWindowPos(HWND_BOTTOM)`
//!     兜底压回（见 [`ensure_bottom`]）；
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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

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

/// 每隔多少个轮询周期把挂件窗重新压回 Z 序最底（其它窗口激活后挂件可能上浮）。
const BOTTOM_REASSERT_TICKS: u64 = 100;

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
#[tauri::command]
pub async fn grid_item_delete(app: AppHandle, item_id: i64) -> Result<(), String> {
    let conn = connect(&app)?;
    let affected = conn
        .execute("DELETE FROM grid_items WHERE id = ?1", params![item_id])
        .map_err(|err| format!("删除挂件条目失败：{err}"))?;
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

/// 将挂件窗压回 Z 序最底（壁纸之上、普通应用窗口之下）。
///
/// 方案选择：Tauri 2 **没有** `always_on_bottom` / `set_always_on_bottom` API
/// （仅有 `always_on_top`），故走 Windows 兜底 —— 取窗口 `HWND` 后调
/// `SetWindowPos(HWND_BOTTOM, SWP_NOMOVE|NOSIZE|NOACTIVATE)`。项目已依赖
/// `windows` crate（Win32_UI_WindowsAndMessaging 特性），无需新增依赖。
/// 其它平台暂不保证层级（返回成功，见交付报告的已知限制）。
fn ensure_bottom(win: &WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, HWND_BOTTOM, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        };
        let raw = win
            .hwnd()
            .map_err(|err| format!("获取挂件窗句柄失败：{err}"))?;
        // tauri 内部依赖的 windows crate 版本可能与本 crate 不同，按底层指针值转换
        let hwnd = HWND(raw.0 as _);
        unsafe {
            SetWindowPos(
                hwnd,
                HWND_BOTTOM,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            )
            .map_err(|err| format!("挂件窗压回桌面层失败：{err}"))?;
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = win;
        Ok(())
    }
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
                    break; // 窗口已销毁 → 线程退出
                };
                if !win.is_visible().unwrap_or(false) {
                    if last_ignore != Some(true) {
                        let _ = win.set_ignore_cursor_events(true);
                        last_ignore = Some(true);
                    }
                    continue;
                }
                tick += 1;
                // 周期性压回最底：应用窗口激活后挂件可能上浮（桌面挂件语义 = 永远垫底）
                if tick % BOTTOM_REASSERT_TICKS == 0 {
                    let _ = ensure_bottom(&win);
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

/// 创建（幂等复用）并显示挂件窗。
fn show_overlay(app: &AppHandle) -> Result<(), String> {
    // 已存在 → 显示 + 压回底层即可（同 note 窗的幂等约定，不开第二个）
    if let Some(existing) = app.get_webview_window(GRID_LABEL) {
        let _ = existing.show();
        let _ = ensure_bottom(&existing);
        ensure_poller(app.clone());
        return Ok(());
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
        .visible(true)
        .inner_size(width, height)
        .position(x, y)
        .build()
        .map_err(|err| format!("创建桌面挂件窗口失败：{err}"))?;

    // 默认点击穿透；光标命中盒子区域后由轮询线程开放交互
    let _ = win.set_ignore_cursor_events(true);
    let _ = ensure_bottom(&win);
    ensure_poller(app.clone());
    Ok(())
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

/// 一键整理桌面：扫描 → 按类型分组 → 每组一个格子 + 登记引用。
///
/// - **不移动 / 不复制 / 不重命名任何文件**，只新建格子与引用；
/// - 同名格子直接复用（再次整理是**增量补充**，不会越点越多格子）；
/// - 已登记过的文件全局去重，不会在多个格子里重复出现。
///
/// `dir` 仅供测试 / 自定义目录，缺省为用户桌面。
#[tauri::command]
pub async fn grid_auto_arrange(
    app: AppHandle,
    dir: Option<String>,
) -> Result<AutoArrangeReport, String> {
    use std::collections::{HashMap, HashSet};
    use std::path::PathBuf;

    let root: PathBuf = match dir {
        Some(value) if !value.trim().is_empty() => PathBuf::from(value.trim()),
        _ => dirs::desktop_dir().ok_or_else(|| "无法定位桌面目录".to_string())?,
    };

    // 复用 organizer 的扫描：已排除隐藏 / 系统文件与 symlink，并带好 by-type 类别
    let scanned = crate::commands::organizer::scan_items(&root)?;
    let total_scanned = scanned.len();

    let conn = connect(&app)?;

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
        // 本组里还没被登记过的文件
        let fresh: Vec<usize> = indices
            .into_iter()
            .filter(|index| {
                scanned
                    .get(*index)
                    .map(|item| !known.contains(&item.path))
                    .unwrap_or(false)
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

