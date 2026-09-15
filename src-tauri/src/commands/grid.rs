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
