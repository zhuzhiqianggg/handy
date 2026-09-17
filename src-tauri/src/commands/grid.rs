//! 桌面网格挂件（desktop grid widget）——**真实收纳型**桌面整理（V33 起重定）。
//!
//! ## 模型（V33 转向，用户实测反馈驱动）
//!
//! 旧模型是**文件引用型**：格子只登记桌面文件的路径引用，文件一动不动。实测下来
//! 它与桌面原图标**完全重复**（同一批文件在桌面和格子里各显示一份），用户的原话
//! 是「并不是整理收纳，而是复制了一份而已」。
//!
//! 新模型是**真实收纳型**：
//!   - 每个收纳格绑定一个真实目录 `桌面/Handy整理/<格子名>/`（与「归类文件」
//!     共用同一个根目录，用户只需认一个目录）；
//!   - **拖进格子 = 真把文件移进该目录**（同名不覆盖，冲突自动改名）；
//!     文件离开桌面根目录 → 桌面图标自然消失 → 不再重复；
//!   - 条目上的 × = **移出格子**（把文件移回桌面根目录），不是删除；
//!   - **默认不自动收录桌面任何东西**（不藏图标、不搬文件）：桌面图标与快捷
//!     方式一律留在原位，格子只呈现「已经收纳进来的文件」。
//!
//! 格子还是**挂件容器**：`kind` 区分 `folder`（收纳格）/ `note`（便签）/
//! `calendar`（日历 + 今日计划）/ `system`（此电脑 · 回收站入口）。非 folder
//! 类型的格子不绑定目录、不参与磁盘对账，内容存在 `content` 列里。
//!
//! ## 桌面层挂件窗
//!
//! `grid-overlay` 无边框透明窗，用 `SetWindowPos(hwnd, 桌面宿主)` 贴在桌面窗口
//! **正上方**（V20 修复：旧实现用 `HWND_BOTTOM` 把它压到了壁纸之下，用户看到的
//! 是「格子建了但桌面上什么都没有」）。
//!
//! ## 点击穿透
//!
//! 窗口创建后即 `set_ignore_cursor_events(true)`；Rust 侧轻量轮询线程每
//! [`POLL_INTERVAL_MS`] 毫秒取全局光标位置，与前端上报的盒子区域
//! （[`grid_overlay_update_regions`]，挂件窗内**物理像素**）做命中测试，命中
//! （或前端拖拽期显式申请，见 [`grid_set_interactive`]）才切回可交互。这样透明
//! 区域始终把点击让给桌面，而盒子区域可交互、可接收文件拖放。
//!
//! ## 稳定性（V33 修复用户实测的「闪一下就没了」）
//!
//! 1. **心跳自愈只在冷启动失败时生效**：旧策略是「90 秒没心跳就销毁重建」，
//!    而 WebView2 对贴桌面层的窗口会做后台定时器节流，心跳间隔很容易被拉到 90 秒
//!    以上 → 误判成白屏 → **周期性销毁重建** → 用户看到「闪一下没了 / 又出来了」。
//!    现在只认「本次显示后从未收到过心跳」（真正的冷启动白屏），且带冷却与次数上限；
//! 2. **Z 序校验去抖**：间隔放宽到 [`REASSERT_TICKS`] 个周期，且要求连续两次
//!    判定不一致才重排 —— 避免第三方桌面工具插队时每 2 秒 `SetWindowPos` 一次；
//! 3. **生命周期日志**：`%LOCALAPPDATA%/Handy/grid-debug.log` 记录显示 / 收起 /
//!    重建 / Z 序重排，出问题可直接看文件，不靠猜。
//!
//! 数据契约：`db/migrations.rs` v4（建表）+ v6（`kind` / `content`）。
//! 三方向一致：迁移 SQL = 本文件结构体 = `src/types/grid.ts`。
//!
//! 全部命令均为 `async fn`（项目 P0 约定：同步命令会楔死 WebView2 COM STA），
//! 错误一律中文可读，SQL 一律参数化绑定。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
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

/// 光标轮询间隔（毫秒）。
///
/// V35：60ms → **25ms**。原因是一条实测反馈：「鼠标移上去有时候识别不到，光标没变成拖动」。
/// 根因是**先有鸡还是先有蛋** —— 挂件窗默认 `ignore_cursor_events(true)`（整窗穿透），
/// 要收到任何鼠标事件，必须先由本线程用全局光标位置判定「进区域了」再把穿透关掉。
/// 这个判定越慢，用户就越常遇到「鼠标已经在格子上、但按钮/光标样式还是桌面那套」；
/// 压着鼠标快速扫过去时甚至可能在按下的一瞬间还没切过来，于是**拖拽压根不启动**。
/// 25ms ≈ 40 次/秒，仍只是一次 `GetCursorPos` + 一次 `outer_position`，开销可忽略。
const POLL_INTERVAL_MS: u64 = 25;

/// 命中区域外扩（物理像素）。
///
/// V35：与上面的提速配套。鼠标是**连续移动**的，而判定是**离散采样**的：真实进入
/// 盒子的那一刻与前一次采样之间总会差一小段。外扩一圈（4px）让窗口提前一点变成
/// 可交互，把「扫过去来不及」的时间窗补掉。4px 小于桌面图标间距，不会明显影响
/// 贴着格子边缘点击桌面文件。
const HIT_PADDING: f64 = 4.0;

/// Z 序自检的**时间**间隔（秒）。
///
/// # 为什么是「秒」而不是「多少个轮询周期」（V35 修的坑）
///
/// V34 这里是 `REASSERT_TICKS = 40`，含义随 `POLL_INTERVAL_MS` 走：当时 60ms × 40 ≈ 2.4 秒。
/// V35 为了拖拽手感把轮询提到 **25ms**，同一个 40 就悄悄变成 **1 秒** ——
/// 自检频率翻了 2.4 倍，而这一点在两边代码里都看不出来。
/// **轮询周期是「手感参数」，不该顺手改掉自愈的节奏**，所以这里改用时间。
const REASSERT_INTERVAL_SECS: u64 = 3;

/// 判定「我还在不在桌面上方」时，最多往下走多少个窗口。
///
/// 见 [`z_verdict`]：桌面正上方那一格是**公共地段**，中间夹几层很正常，
/// 所以判据是「往下走一小段能不能碰到桌面」，而不是「正下方必须正好是桌面」。
/// 走满这么多层还没碰到桌面，就认为「被压得很高」（同样需要纠正）。
const REASSERT_SCAN_STEPS: usize = 24;

/// 连续纠正失败多少次后，退到 [`REASSERT_GIVEUP_BACKOFF_SECS`] 的长间隔。
///
/// **这条是「永不停止地闪」的保险丝**：只要判据和现实有一点对不上，
/// 无限重试就会变成无限重排 —— 用户看到的就是「一直闪、偶尔又出来」。
/// 宁可少纠正几次，也绝不允许进入无限循环。
const REASSERT_MAX_FIXES: u32 = 5;

/// 触发保险丝后的冷却（秒）：期间只计数不再动手，过后再试一小轮。
const REASSERT_GIVEUP_BACKOFF_SECS: u64 = 300;

/// 收纳根目录名（桌面下的一级目录；与「归类文件」共用，避免两个相似目录）。
const STORAGE_ROOT_NAME: &str = "Handy整理";

/// 收纳根目录名（历史沿用的另一个名字，作为兜底：若只存在它则继续沿用）。
const LEGACY_STORAGE_ROOT_NAME: &str = "Handy收纳";

/// 冷启动白屏宽限期（秒）：本次显示后这么久还没收到过一次心跳，才判定前端没起来。
const HEARTBEAT_COLD_START_SECS: u64 = 45;

/// 两次自动重建之间的最小间隔（秒）：冷却，避免重建风暴。
const HEARTBEAT_REBUILD_COOLDOWN_SECS: u64 = 300;

/// 单次进程内自动重建的次数上限（超过只记日志，交给用户手动「显示格子」）。
const HEARTBEAT_REBUILD_MAX: u32 = 3;


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
///
/// `kind`：`folder`（收纳格，绑定真实目录）/ `note`（便签）/ `calendar`（日历 +
/// 今日计划）/ `system`（此电脑 · 回收站入口）。非 `folder` 的格子不绑目录。
/// `content`：挂件自有数据（便签正文 / 日历配置 JSON），收纳格恒为空串。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridBox {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub content: String,
    /// 配色键（`''` = 默认色）。V35 引入：多个便签并存时需要一眼分清谁是谁。
    pub accent: String,
    pub pos_x: i64,
    pub pos_y: i64,
    pub width: i64,
    pub height: i64,
    pub sort: i64,
    pub item_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// 挂件条目（与 `grid_items` 表对应）。
///
/// V33 起 `file_path` 指向**收纳目录里的真实文件**（不再是指向桌面文件的引用），
/// 表本身降级为登记缓存 —— 真相在磁盘目录，每次列举时按目录对账。
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
const BOX_COLUMNS: &str = "b.id, b.name, b.kind, b.content, b.accent, b.pos_x, b.pos_y, b.width, \
                           b.height, b.sort, b.created_at, b.updated_at";

/// 行 → 盒子实体（SQL 必须附带 `item_count` 计数列）。
fn row_to_box_with_count(row: &Row) -> rusqlite::Result<GridBox> {
    Ok(GridBox {
        id: row.get("id")?,
        name: row.get("name")?,
        kind: row.get("kind")?,
        content: row.get("content")?,
        accent: row.get("accent")?,
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

// —— 收纳目录（V33 的真实收纳层：格子 = 桌面/Handy整理/<格子名>/） ——

/// 收纳根目录：`桌面/Handy整理`（与「归类文件」同一根，用户只需认一个目录）。
///
/// 兜底：若只存在历史的 `Handy收纳` 目录，则继续沿用，避免凭空多出一个空目录。
fn storage_root() -> Result<PathBuf, String> {
    let desktop = desktop_root()?;
    let primary = desktop.join(STORAGE_ROOT_NAME);
    if primary.is_dir() {
        return Ok(primary);
    }
    let legacy = desktop.join(LEGACY_STORAGE_ROOT_NAME);
    if legacy.is_dir() {
        return Ok(legacy);
    }
    Ok(primary)
}

/// 桌面根目录。
fn desktop_root() -> Result<PathBuf, String> {
    dirs::desktop_dir().ok_or_else(|| "无法定位桌面目录".to_string())
}

/// 目录名清洗：Windows 非法字符换下划线，去首尾空白与结尾句点，空则用缺省名。
fn clean_segment(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.trim().chars() {
        if matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || (ch as u32) < 0x20
        {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    let trimmed = out.trim().trim_end_matches(['.', ' ']).trim();
    if trimmed.is_empty() {
        "未命名".to_string()
    } else {
        // 过长名字会把整条路径撑爆（Windows MAX_PATH），截到 60 字符
        trimmed.chars().take(60).collect()
    }
}

/// 格子对应的真实收纳目录。
fn box_dir(root: &Path, box_name: &str) -> PathBuf {
    root.join(clean_segment(box_name))
}

/// 建目录（幂等）。
fn ensure_dir(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(path)
        .map_err(|err| format!("创建收纳目录失败（{}）：{err}", path.display()))
}

/// 枚举收纳目录里的条目（跳过隐藏 / 系统文件与点开头项；目录同样算条目）。
fn list_dir_items(dir: &Path) -> Vec<(String, String)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<(String, String)> = Vec::new();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::fs::MetadataExt;
            const HIDDEN_OR_SYSTEM: u32 = 0x2 | 0x4;
            if meta.file_attributes() & HIDDEN_OR_SYSTEM != 0 {
                continue;
            }
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        out.push((entry.path().to_string_lossy().to_string(), name));
    }
    out.sort_by(|a, b| a.1.to_lowercase().cmp(&b.1.to_lowercase()));
    out
}

/// 冲突安全移动：目标同名时自动追加 ` (2)`、` (3)` …，**绝不覆盖**。
fn move_with_conflict_rename(src: &Path, dest_dir: &Path) -> Result<PathBuf, String> {
    let file_name = src
        .file_name()
        .ok_or_else(|| format!("无法从路径取文件名：{}", src.display()))?
        .to_string_lossy()
        .to_string();
    let file_path = Path::new(&file_name);
    let stem = file_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| file_name.clone());
    let ext = file_path
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();

    let mut target = dest_dir.join(&file_name);
    let mut index = 2;
    while target.exists() {
        if index > 999 {
            return Err(format!("目标目录同名文件过多，无法移动：{file_name}"));
        }
        target = dest_dir.join(format!("{stem} ({index}){ext}"));
        index += 1;
    }

    match std::fs::rename(src, &target) {
        Ok(()) => Ok(target),
        Err(err) => {
            // 跨卷移动（`fs::rename` 不支持）→ 退化成「复制 + 删除源」。
            //
            // ⚠️ 目录必须走递归复制：`std::fs::copy` 只能复制单个文件，对目录会直接
            // 报错。V34 把文件夹纳入收纳之后，这条路径才真正会被踩到（桌面被重定向
            // 到另一个盘时，`fs::rename` 必然失败）。
            if src.is_dir() {
                copy_dir_recursive(src, &target).map_err(|copy_err| {
                    format!("移动失败（{err}）；目录复制兜底也失败：{copy_err}")
                })?;
                std::fs::remove_dir_all(src)
                    .map_err(|remove_err| format!("目录复制成功但删除原目录失败：{remove_err}"))?;
                return Ok(target);
            }
            std::fs::copy(src, &target)
                .map_err(|copy_err| format!("移动失败（{err}）；复制兜底也失败：{copy_err}"))?;
            std::fs::remove_file(src)
                .map_err(|remove_err| format!("复制成功但删除原文件失败：{remove_err}"))?;
            Ok(target)
        }
    }
}

/// 递归复制目录（跨卷移动文件夹时的兜底）。
///
/// 标准库只提供「复制单个文件」，目录得自己走下去。失败一律原样上抛 ——
/// 调用方会把它拼进中文错误里，不做静默吞错。
fn copy_dir_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// 某盒子的登记条目（按 sort 升序、id 升序稳定排序）。
fn list_registry_items(conn: &Connection, box_id: i64) -> Result<Vec<GridItem>, String> {
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

/// 按磁盘目录对账某个收纳格：补齐新出现的文件、清掉已消失的登记，返回对账结果。
///
/// 真相在磁盘目录，`grid_items` 只是给前端提供稳定 id 的登记缓存。
/// 非 `folder` 类型的格子（便签 / 日历 / 系统）不绑目录，直接返回登记行。
fn reconcile_box(
    conn: &Connection,
    box_id: i64,
    box_name: &str,
    kind: &str,
    root: &Path,
) -> Result<Vec<GridItem>, String> {
    if kind != "folder" {
        return list_registry_items(conn, box_id);
    }
    let dir = box_dir(root, box_name);
    ensure_dir(&dir)?;
    let on_disk = list_dir_items(&dir);
    let disk_paths: std::collections::HashSet<String> =
        on_disk.iter().map(|(path, _)| path.clone()).collect();

    let registered = list_registry_items(conn, box_id)?;
    // 清理：登记还在、磁盘上没了 → 删登记
    for item in &registered {
        if !disk_paths.contains(&item.file_path) {
            conn.execute("DELETE FROM grid_items WHERE id = ?1", params![item.id])
                .map_err(|err| format!("清理失效条目失败：{err}"))?;
        }
    }
    // 补齐：磁盘上有、登记里没有 → 补登记（例如用户在资源管理器里手工拖进去的）
    let known: std::collections::HashSet<String> = registered
        .iter()
        .filter(|item| disk_paths.contains(&item.file_path))
        .map(|item| item.file_path.clone())
        .collect();
    let mut sort = registered.iter().map(|item| item.sort).max().unwrap_or(0);
    for (path, name) in &on_disk {
        if known.contains(path) {
            continue;
        }
        sort += 1;
        conn.execute(
            "INSERT OR IGNORE INTO grid_items (box_id, file_path, display_name, sort, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![box_id, path, name, sort, now_iso()],
        )
        .map_err(|err| format!("登记收纳条目失败：{err}"))?;
    }
    list_registry_items(conn, box_id)
}

/// 格子类型白名单：未知值一律回落成收纳格（`folder`），不制造半残数据。
fn clean_kind(kind: Option<String>) -> String {
    match kind.as_deref() {
        Some("note") => "note".to_string(),
        Some("calendar") => "calendar".to_string(),
        // V34 起「系统格」已取消（用户要求：原生快捷方式不动态整理）；v7 迁移把历史
        // 系统格删掉了。这里不再接受 system，免得哪天有调用方又把它造回来。
        _ => "folder".to_string(),
    }
}

/// 配色键清洗：只认**一眼分辨率高、色相区分大**的固定几个键，其余一律回落默认。
///
/// 白名单而不是「随便存字符串」的原因：颜色最终要映射到 Tailwind 类名/内联色值，
/// 让任意字符串流进样式是没必要的风险面；而用户也确实只需要「这几个能分清」。
fn clean_accent(accent: Option<String>) -> String {
    match accent.as_deref() {
        Some("amber") | Some("rose") | Some("sky") | Some("emerald") | Some("violet")
        | Some("slate") => accent.unwrap_or_default(),
        _ => String::new(),
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
    kind: Option<String>,
    content: Option<String>,
    accent: Option<String>,
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
            // 缺省落点 = 靠右自动流（与「一键收纳」共用同一套排布，见 arrange_position）
            let (auto_x, auto_y) = arrange_position(layout_work_width(&app), cascade);
            conn.execute(
                "INSERT INTO grid_boxes \
                 (name, kind, content, accent, pos_x, pos_y, width, height, sort, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    clean_name(name),
                    clean_kind(kind),
                    content.unwrap_or_default(),
                    clean_accent(accent),
                    pos_x.unwrap_or(auto_x),
                    pos_y.unwrap_or(auto_y),
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
            // 重命名收纳格时**目录要跟着改名**，否则格子会指向一个凭空新建的空目录
            // （用户会看到「改个名字文件全没了」）。目标目录已存在则不动磁盘，只改名。
            if let Some(raw_name) = name.clone() {
                let next_name = clean_name(Some(raw_name));
                if let Ok(previous) = load_box(&app, id) {
                    if previous.kind == "folder" && previous.name != next_name {
                        if let Ok(root) = storage_root() {
                            let from = box_dir(&root, &previous.name);
                            let to = box_dir(&root, &next_name);
                            if from.is_dir() && !to.exists() {
                                std::fs::rename(&from, &to).map_err(|err| {
                                    format!("重命名收纳目录失败（{} → {}）：{err}", from.display(), to.display())
                                })?;
                            }
                        }
                    }
                }
            }
            // 动态 SET：只更新显式传入的字段
            let mut sets: Vec<&'static str> = Vec::new();
            let mut values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
            if let Some(v) = name {
                sets.push("name = ?");
                values.push(Box::new(clean_name(Some(v))));
            }
            if let Some(v) = kind {
                sets.push("kind = ?");
                values.push(Box::new(clean_kind(Some(v))));
            }
            if let Some(v) = content {
                sets.push("content = ?");
                values.push(Box::new(v));
            }
            if let Some(v) = accent {
                sets.push("accent = ?");
                values.push(Box::new(clean_accent(Some(v))));
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

/// 删除盒子。**收纳进来的文件不会被删除**：目录里还有东西就原样保留（只是不再有
/// 格子显示它）；目录已空才顺手删掉空目录，避免满桌面攒空文件夹。
#[tauri::command]
pub async fn grid_box_delete(app: AppHandle, box_id: i64) -> Result<(), String> {
    let entity = load_box(&app, box_id)?;
    let conn = connect(&app)?;
    let affected = conn
        .execute("DELETE FROM grid_boxes WHERE id = ?1", params![box_id])
        .map_err(|err| format!("删除盒子失败：{err}"))?;
    if affected == 0 {
        return Err(format!("盒子不存在或已被删除（id={box_id}）"));
    }
    // grid_items 由外键 ON DELETE CASCADE 自动清理（db::open 已启用 foreign_keys）
    if entity.kind == "folder" {
        if let Ok(root) = storage_root() {
            let dir = box_dir(&root, &entity.name);
            if dir.is_dir() && list_dir_items(&dir).is_empty() {
                let _ = std::fs::remove_dir(&dir);
            }
        }
    }
    Ok(())
}

/// 写挂件数据（便签正文 / 日历配置 JSON 等）。收纳格一般不使用。
#[tauri::command]
pub async fn grid_box_set_content(
    app: AppHandle,
    box_id: i64,
    content: String,
) -> Result<(), String> {
    let conn = connect(&app)?;
    let affected = conn
        .execute(
            "UPDATE grid_boxes SET content = ?1, updated_at = ?2 WHERE id = ?3",
            params![content, now_iso(), box_id],
        )
        .map_err(|err| format!("保存挂件数据失败：{err}"))?;
    if affected == 0 {
        return Err(format!("盒子不存在或已被删除（id={box_id}）"));
    }
    Ok(())
}

// —— 条目 CRUD（真实收纳：文件真的会在收纳目录里进出） ——

/// 把文件放进某个收纳格 = **真的把文件移进**该格子的收纳目录。
///
/// - 目标同名**绝不覆盖**，冲突自动改名（`名称 (2).扩展名`）；
/// - 文件已在收纳目录内 → 明确报错，不做无意义搬运；
/// - 跨卷移动自动退化成「复制 + 删除源」，失败时中文错误说明是哪一步失败。
#[tauri::command]
pub async fn grid_item_add(
    app: AppHandle,
    box_id: i64,
    file_path: String,
    display_name: Option<String>,
) -> Result<GridItem, String> {
    let raw = file_path.trim().to_string();
    if raw.is_empty() {
        return Err("文件路径为空".to_string());
    }
    let source = PathBuf::from(&raw);
    if !source.exists() {
        return Err(format!("文件不存在：{raw}"));
    }
    let entity = load_box(&app, box_id)?;
    if entity.kind != "folder" {
        return Err("该格子不是收纳格，不能放文件".to_string());
    }
    let root = storage_root()?;
    let dir = box_dir(&root, &entity.name);
    ensure_dir(&dir)?;
    if source.parent().map(|parent| parent == dir.as_path()).unwrap_or(false) {
        return Err("该文件已经在格子里了".to_string());
    }

    let moved = move_with_conflict_rename(&source, &dir)?;
    let moved_path = moved.to_string_lossy().to_string();
    let display = match display_name {
        Some(value) if !value.trim().is_empty() => value.trim().to_string(),
        _ => moved
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| moved_path.clone()),
    };

    let conn = connect(&app)?;
    // 并发/重复拖放的兜底：登记已存在则直接返回既有行
    let existing = conn
        .query_row(
            "SELECT id, box_id, file_path, display_name, sort, created_at \
             FROM grid_items WHERE box_id = ?1 AND file_path = ?2",
            params![box_id, moved_path],
            row_to_item,
        )
        .ok();
    if let Some(item) = existing {
        return Ok(item);
    }

    let sort = next_sort(
        &conn,
        "SELECT COALESCE(MAX(sort) + 1, 0) FROM grid_items WHERE box_id = ?1",
        Some(box_id),
    )?;
    let created = now_iso();
    conn.execute(
        "INSERT INTO grid_items (box_id, file_path, display_name, sort, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![box_id, moved_path, display, sort, created],
    )
    .map_err(|err| format!("登记收纳条目失败：{err}"))?;

    Ok(GridItem {
        id: conn.last_insert_rowid(),
        box_id,
        file_path: moved_path,
        display_name: display,
        sort,
        created_at: created,
    })
}

/// 把条目移出格子：**文件移回桌面根目录**（不是删除），随后清掉登记。
///
/// `dismiss` 是旧版前端参数（曾经表示「不再自动收录」），V33 起自动收录已取消，
/// 该参数不再使用 —— 保留形参以免旧调用报「参数不匹配」。
#[tauri::command]
pub async fn grid_item_delete(
    app: AppHandle,
    item_id: i64,
    dismiss: Option<bool>,
) -> Result<(), String> {
    let _ = dismiss;
    let conn = connect(&app)?;
    let (path, box_id): (String, i64) = conn
        .query_row(
            "SELECT file_path, box_id FROM grid_items WHERE id = ?1",
            params![item_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "挂件条目不存在或已被删除".to_string())?;

    let entity = load_box(&app, box_id)?;
    if entity.kind == "folder" {
        // 收纳格：把文件搬回桌面根目录（不是删除）
        let source = PathBuf::from(&path);
        if source.exists() {
            let desktop = desktop_root()?;
            move_with_conflict_rename(&source, &desktop)?;
        }
    } else {
        // 虚拟条目（系统格子里的此电脑 / 回收站等）：记入「用户不要它」名单，
        // 否则每次对账都会被 ensure_system_box 重新塞回来
        let mut set = read_dismissed(&conn)?;
        set.insert(path.clone());
        let _ = write_dismissed(&conn, &set);
    }

    let affected = conn
        .execute("DELETE FROM grid_items WHERE id = ?1", params![item_id])
        .map_err(|err| format!("删除挂件条目失败：{err}"))?;
    if affected == 0 {
        return Err("挂件条目不存在或已被删除".to_string());
    }
    Ok(())
}

/// 移动条目到另一个格子 = **真的把文件移到目标格子的收纳目录**。
#[tauri::command]
pub async fn grid_item_move(
    app: AppHandle,
    item_id: i64,
    target_box_id: i64,
) -> Result<(), String> {
    let conn = connect(&app)?;
    let path: String = conn
        .query_row(
            "SELECT file_path FROM grid_items WHERE id = ?1",
            params![item_id],
            |row| row.get(0),
        )
        .map_err(|_| "挂件条目不存在或已被删除".to_string())?;
    let target = load_box(&app, target_box_id)?;
    if target.kind != "folder" {
        return Err("目标不是收纳格，不能放文件".to_string());
    }
    let root = storage_root()?;
    let dir = box_dir(&root, &target.name);
    ensure_dir(&dir)?;

    let source = PathBuf::from(&path);
    if !source.exists() {
        return Err("源文件已不存在（可能已被移动或删除）".to_string());
    }
    if source.parent().map(|parent| parent == dir.as_path()).unwrap_or(false) {
        return Ok(()); // 已在目标目录里，无需搬运
    }
    let moved = move_with_conflict_rename(&source, &dir)?;
    let moved_path = moved.to_string_lossy().to_string();
    let display = moved
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| moved_path.clone());

    conn.execute(
        "UPDATE grid_items SET box_id = ?1, file_path = ?2, display_name = ?3 WHERE id = ?4",
        params![target_box_id, moved_path, display, item_id],
    )
    .map_err(|err| format!("更新收纳条目失败：{err}"))?;
    Ok(())
}

/// 某盒子的条目列表。收纳格按磁盘目录对账后返回；其它类型直接返回登记行。
#[tauri::command]
pub async fn grid_item_list(app: AppHandle, box_id: i64) -> Result<Vec<GridItem>, String> {
    let conn = connect(&app)?;
    let entity = load_box(&app, box_id)?;
    let root = storage_root()?;
    reconcile_box(&conn, entity.id, &entity.name, &entity.kind, &root)
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

/// 挂件窗相对桌面的纵深位置。
#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ZVerdict {
    /// 就在桌面「那一带」：往下走一段能碰到桌面 ⇒ 层级正确，什么都不用做。
    InDesktopBand,
    /// 一路走到底都没碰到桌面 ⇒ 被压在桌面**下面**（用户看到的是「格子不见了」）。
    BelowDesktop,
    /// 走了 [`REASSERT_SCAN_STEPS`] 层还没碰到桌面 ⇒ 被顶得**很高**（会盖住别的窗口）。
    TooHigh,
}

/// 从「自己往下走看到的窗口链」判定纵深。
///
/// 抽成纯函数是为了能测 —— 这条判据历史上错过两次，不能再靠肉眼审。
///
/// - `chain`：从自己**正下方那一个**开始，依次往下的窗口（最多 [`REASSERT_SCAN_STEPS`] 个）
/// - `hit_bottom`：还没走满 [`REASSERT_SCAN_STEPS`] 就走到底了（Z 序末端）
#[cfg(target_os = "windows")]
fn classify_chain(chain: &[HWND], host: HWND, hit_bottom: bool) -> ZVerdict {
    if chain.contains(&host) {
        // 往下走一段能碰到桌面 ⇒ 我们在它上面。**中间夹着谁都不算问题**：
        // 输入法助手窗、本应用主窗常年就停在这一带。
        return ZVerdict::InDesktopBand;
    }
    if hit_bottom {
        ZVerdict::BelowDesktop
    } else {
        ZVerdict::TooHigh
    }
}

/// 判定挂件窗相对桌面宿主的纵深（走链部分，见 [`classify_chain`]）。
#[cfg(target_os = "windows")]
fn z_verdict(hwnd: HWND) -> Option<ZVerdict> {
    use windows::Win32::UI::WindowsAndMessaging::{GetWindow, GW_HWNDNEXT};
    let host = desktop_host()?;
    if host == hwnd {
        return Some(ZVerdict::InDesktopBand);
    }
    let mut chain: Vec<HWND> = Vec::with_capacity(REASSERT_SCAN_STEPS);
    let mut hit_bottom = false;
    let mut cursor = hwnd;
    for _ in 0..REASSERT_SCAN_STEPS {
        // SAFETY: 有效 HWND，仅查询 Z 序。
        let next = unsafe { GetWindow(cursor, GW_HWNDNEXT) }.unwrap_or_else(|_| null_hwnd());
        if next.0.is_null() {
            hit_bottom = true;
            break;
        }
        chain.push(next);
        if next == host {
            break;
        }
        cursor = next;
    }
    Some(classify_chain(&chain, host, hit_bottom))
}

/// 周期复位：**只在 Z 序真的不对时**才重排。
///
/// 每次都无脑 `SetWindowPos` 会让窗口反复重绘 —— 那正是「闪一下」的观感来源。
/// 判据见 [`z_verdict`]（V35 前是「正下方必须正好是桌面」，那条在真实桌面上
/// 几乎永远不成立，是本轮修掉的核心缺陷）。
///
/// 三重保险，确保**永远不会变成无限重排**：
///   1. 判据宽容（`InDesktopBand` 就算对）⇒ 稳态下一次都不会触发；
///   2. 自检有**时间**间隔（[`REASSERT_INTERVAL_SECS`]）⇒ 不会跟着轮询提速而变密；
///   3. 连续纠正失败到 [`REASSERT_MAX_FIXES`] 次就退避 [`REASSERT_GIVEUP_BACKOFF_SECS`] 秒
///      ⇒ 就算判据和现实仍对不上，也只会偶发纠正，不会连续闪。
fn reassert_attach(win: &WebviewWindow) {
    #[cfg(target_os = "windows")]
    {
        if AttachMode::current() != AttachMode::Desktop {
            return;
        }
        let Ok(hwnd) = overlay_hwnd(win) else {
            return;
        };

        // 保险丝：上次触发后退避期内直接不动手（每轮只判断时间，不碰窗口）。
        let now = unix_secs();
        let retry_at = REASSERT_RETRY_AT.load(Ordering::Relaxed);
        if retry_at > now {
            return;
        }

        match z_verdict(hwnd) {
            Some(ZVerdict::InDesktopBand) => {
                // 层级正确：清零计数。走到这里说明判据和现实一致，可以重新信任自愈。
                REASSERT_MISMATCH.store(0, Ordering::Relaxed);
                REASSERT_FIXES.store(0, Ordering::Relaxed);
                REASSERT_GAVE_UP.store(false, Ordering::Relaxed);
                return;
            }
            None => return, // 拿不到桌面宿主：判不了就别乱动
            Some(verdict) => {
                // 去抖：连续两次判定不对才动手（滤掉第三方桌面工具的瞬时抢层）。
                if REASSERT_MISMATCH.fetch_add(1, Ordering::Relaxed) + 1 < 2 {
                    return;
                }
                REASSERT_MISMATCH.store(0, Ordering::Relaxed);

                let fixes = REASSERT_FIXES.fetch_add(1, Ordering::Relaxed) + 1;
                if fixes > REASSERT_MAX_FIXES {
                    REASSERT_FIXES.store(0, Ordering::Relaxed);
                    REASSERT_RETRY_AT.store(now + REASSERT_GIVEUP_BACKOFF_SECS, Ordering::Relaxed);
                    if !REASSERT_GAVE_UP.swap(true, Ordering::Relaxed) {
                        grid_log(&format!(
                            "Z 序自动纠正已连续失败 {REASSERT_MAX_FIXES} 次，暂停 {REASSERT_GIVEUP_BACKOFF_SECS} 秒（避免一直闪）。\
                             判据可能与此机环境不符，请在反馈里带上这行日志。"
                        ));
                    }
                    return;
                }

                let Some(host) = desktop_host() else {
                    return;
                };
                grid_log(&format!(
                    "Z 序不对（{verdict:?}，第 {fixes} 次纠正），重新贴回桌面层（overlay={:?} host={:?}）",
                    hwnd.0, host.0
                ));
                let _ = place_above_desktop(hwnd);
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = win;
    }
}

/// 用户主动「隐藏再显示格子」时复位 Z 序自愈的状态（保险丝重新上膛）。
fn reset_reassert_state() {
    REASSERT_MISMATCH.store(0, Ordering::Relaxed);
    REASSERT_FIXES.store(0, Ordering::Relaxed);
    REASSERT_RETRY_AT.store(0, Ordering::Relaxed);
    REASSERT_GAVE_UP.store(false, Ordering::Relaxed);
}

/// 「显示桌面」（Win+D）/ 最小化之后把挂件层捞回来。
///
/// # 为什么需要这个
///
/// 用户原话：「wind+d 显示桌面后桌面的格子又全都丢失了……按理这个是桌面的一部分，
/// 就算显示桌面它也是显示的」。
///
/// Win+D 的实现就是**给所有顶层窗口发一条最小化** —— 我们的挂件窗虽然被
/// [`place_above_desktop`] 插在桌面窗口的正上方，但它**并不是桌面的子窗口**，
/// 所以在 Win+D 的世界里它就是一个普通顶层窗，一样被最小化掉。
///
/// 真要让 Win+D 碰不到它，得 `SetParent` 成桌面的子窗口 —— 那会让坐标体系变成
/// 相对父窗、且 Explorer 重建 WorkerW 时会连带我们，得不偿失。
/// 所以选**「被最小化就立刻捞回来」**：轮询里判 [`IsIconic`]，命中就用
/// `SW_SHOWNOACTIVATE` 还原（不抢焦点），再重新贴回桌面层。
/// 25ms 的轮询周期意味着用户基本看不到这一下。
///
/// 返回 `true` = 本次真的做了还原（供调用方决定是否继续走后续判定）。
fn restore_if_minimized(win: &WebviewWindow) -> bool {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            IsIconic, ShowWindow, SW_SHOWNOACTIVATE,
        };
        let Ok(hwnd) = overlay_hwnd(win) else {
            return false;
        };
        // SAFETY: hwnd 为本进程窗口的有效句柄；两个 API 都只作用于该窗口。
        let minimized = unsafe { IsIconic(hwnd).as_bool() };
        if !minimized {
            return false;
        }
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
        // 还原会把窗口抛回顶层 → 贴桌模式下必须立刻按基准层插回去；
        // 普通窗口模式（用户手动切过）不做 Z 序调整，免得凭空改变他的预期。
        if AttachMode::current() == AttachMode::Desktop {
            let _ = place_above_desktop(hwnd);
        }
        mark_overlay_shown();
        grid_log("挂件层被最小化（多半是 Win+D / 显示桌面），已还原并重新贴回桌面层");
        true
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = win;
        false
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
    // 外扩一圈：见 HIT_PADDING 的说明（补掉「离散采样 vs 连续移动」的时间窗）
    regions.iter().any(|r| {
        rel_x >= r.x - HIT_PADDING
            && rel_y >= r.y - HIT_PADDING
            && rel_x <= r.x + r.width + HIT_PADDING
            && rel_y <= r.y + r.height + HIT_PADDING
    })
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

/// 挂件窗「意外消失」后的重建冷却（秒）。
///
/// 与白屏自愈的冷却分开记：那条是「窗口在、前端没起来」，这条是「窗口整个没了」。
const RESURRECT_COOLDOWN_SECS: u64 = 30;

/// 上次自动重建「消失的挂件窗」的时刻（unix 秒；用于 [`RESURRECT_COOLDOWN_SECS`]）。
static LAST_RESURRECT_AT: AtomicU64 = AtomicU64::new(0);

/// 启动（或确认已在运行的）光标轮询线程。
///
/// 生命周期：窗口被销毁后不再无条件退出 —— 见下面窗口丢失分支的说明，只有当
/// 「用户要的是收起态」时才退出并复位 `POLLER_RUNNING`。
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
            // Z 序自检按**时间**触发（V35：以前按轮询周期数算，轮询一提速就跟着变密，
            // 把自检从 2.4 秒一次变成 1 秒一次，用户看到的就是「一直闪」）。
            let mut last_reassert = std::time::Instant::now();
            // 窗口连续"不在"的轮询次数：把「该不该重建」的判定降到约 30 秒一次，
            // 否则每 60ms 就要查一次库。
            let mut missing_ticks: u64 = 0;
            loop {
                std::thread::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS));
                let Some(win) = app.get_webview_window(GRID_LABEL) else {
                    // 窗口已销毁 → 图标若仍在代管必须先还回去
                    release_icons_if_taken(&app);
                    // V34：**格子层不该"没了就没了"**。用户对桌面整理的预期是
                    // 「它就是桌面的一部分，除非 Handy 主程序退出」。所以这里区分两种
                    // 情况，而不是一律退出线程：
                    //   - 用户要的是显示态（overlay_visible = 1）→ 重建挂件层；
                    //   - 用户主动收起了 → 线程退出，不做无谓重建。
                    missing_ticks += 1;
                    if missing_ticks % 500 == 1 {
                        if !read_overlay_visible(&app) {
                            break;
                        }
                        let now = unix_secs();
                        if now.saturating_sub(LAST_RESURRECT_AT.load(Ordering::Relaxed))
                            >= RESURRECT_COOLDOWN_SECS
                        {
                            LAST_RESURRECT_AT.store(now, Ordering::Relaxed);
                            grid_log("挂件窗已不在，但状态是「显示中」，自动重建挂件层");
                            if let Err(err) = show_overlay(&app) {
                                grid_log(&format!("重建挂件窗失败：{err}"));
                            }
                        }
                    }
                    continue;
                };
                missing_ticks = 0;
                // V35：Win+D /「显示桌面」会给所有顶层窗发最小化 —— 挂件窗虽然贴在桌面
                // 正上方，但并不是桌面的子窗口，一样会被最小化掉。这里每轮检查一次，
                // 被最小化就立刻还原（用户看到的是「格子一直都在」）。
                if restore_if_minimized(&win) {
                    // 刚还原：这一轮先不判穿透/心跳，下一轮（25ms 后）再照常走
                    last_ignore = None;
                    continue;
                }
                if !win.is_visible().unwrap_or(false) {
                    if last_ignore != Some(true) {
                        let _ = win.set_ignore_cursor_events(true);
                        last_ignore = Some(true);
                    }
                    // 挂件不可见却还代管着图标 = 泄漏（非 grid_overlay_hide 路径的隐藏）
                    release_icons_if_taken(&app);
                    continue;
                }
                // 周期性校验层级（层级不对才重排）：Explorer 重启 / 别的窗口插队后自愈。
                // 按**时间**触发，与轮询周期解耦（见 REASSERT_INTERVAL_SECS 的说明）。
                if last_reassert.elapsed() >= std::time::Duration::from_secs(REASSERT_INTERVAL_SECS) {
                    last_reassert = std::time::Instant::now();
                    reassert_attach(&win);
                }
                // 白屏自愈（V33 收窄）：**只在冷启动后从未收到过心跳**时才判定前端没起来。
                // 稳态心跳可能被 WebView2 后台节流拉长到几分钟，绝不能据此销毁重建 ——
                // 那正是用户看到的「闪一下就没了 / 莫名又出来了」。
                {
                    let shown_at = OVERLAY_SHOWN_AT.load(Ordering::Relaxed);
                    let now = unix_secs();
                    // 「显示之后一次心跳都没有」才是前端没起来；稳态心跳被节流不影响判定
                    let no_beat_since_show = HEARTBEAT_SEQ.load(Ordering::Relaxed)
                        == SHOWN_HEARTBEAT_SEQ.load(Ordering::Relaxed);
                    let cold_failed = shown_at > 0
                        && no_beat_since_show
                        && now.saturating_sub(shown_at) > HEARTBEAT_COLD_START_SECS;
                    if cold_failed {
                        let attempts = REBUILD_ATTEMPTS.load(Ordering::Relaxed);
                        let cooldown_ok =
                            now.saturating_sub(LAST_REBUILD_AT.load(Ordering::Relaxed))
                                > HEARTBEAT_REBUILD_COOLDOWN_SECS;
                        if attempts < HEARTBEAT_REBUILD_MAX && cooldown_ok {
                            REBUILD_ATTEMPTS.store(attempts + 1, Ordering::Relaxed);
                            LAST_REBUILD_AT.store(now, Ordering::Relaxed);
                            grid_log(&format!(
                                "前端冷启动无心跳（显示后超过 {HEARTBEAT_COLD_START_SECS} 秒仍无心跳，第 {} 次重建）",
                                attempts + 1
                            ));
                            let _ = win.close();
                            std::thread::sleep(std::time::Duration::from_secs(2));
                            if let Err(err) = show_overlay(&app) {
                                grid_log(&format!("挂件窗重建失败：{err}"));
                            }
                            continue;
                        }
                        if attempts >= HEARTBEAT_REBUILD_MAX
                            && !REBUILD_GAVE_UP.swap(true, Ordering::Relaxed)
                        {
                            grid_log("挂件前端多次冷启动失败，已放弃自动重建（请手动收起再显示格子）");
                        }
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
    // 已存在 → 先 show 再归位。
    //
    // ⚠️ 顺序不能反（V34 修的关键 bug）：`show()` 会把窗口提到 Z 序**顶层**，
    // 若先 `apply_attach` 贴到桌面层、再 `show`，刚贴好的层级立刻被顶掉 ——
    // 用户看到的就是「格子跑到我其他窗口上面了」；等他点一下别的窗口，那个窗口
    // 被激活盖过来，格子又像「消失」了。同一根因，两种表象。
    // 正确顺序：先让它显示，再把它按基准层插回「桌面正上方」。
    if let Some(existing) = app.get_webview_window(GRID_LABEL) {
        let _ = existing.show();
        let attach = apply_attach(&existing, mode);
        let _ = write_overlay_visible(app, true);
        mark_overlay_shown();
        ensure_poller(app.clone());
        // 用户主动「显示」= 重来一次：Z 序自愈的计数与退避全部复位
        reset_reassert_state();
        grid_log("显示挂件层（复用已有窗口）");
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
    // 先 show 再归位：顺序理由同上（`show()` 会把窗口顶到 Z 序顶层）
    let _ = win.show();
    // 按基准层归位（默认「贴到桌面」；失败时窗口仍在，把原因透给前端）
    let attach = apply_attach(&win, mode);
    let _ = write_overlay_visible(app, true);
    // 冷启动基线：给 webview 启动 + React 挂载留出宽限（判定见轮询线程）
    mark_overlay_shown();
    // 新窗从零开始，自愈状态一并复位
    reset_reassert_state();
    grid_log("新建并显示挂件层");
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
    // 收起时把 Z 序自愈的计数清零：下次显示是干净的一轮
    reset_reassert_state();
    grid_log("收起挂件层");
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

/// 本次显示挂件窗的时刻（unix 秒，0 = 未显示）。
///
/// V33：自愈判据从「最后心跳距今多久」改成「显示后至今有没有收到过心跳」——
/// WebView2 对贴桌面层的窗口会做后台定时器节流，心跳间隔很容易被拉到 90 秒以上，
/// 旧判据会把它误判成白屏并**周期性销毁重建**（用户看到的「闪一下没了 / 又出来了」）。
static OVERLAY_SHOWN_AT: AtomicU64 = AtomicU64::new(0);

/// 心跳序号：每收到一次心跳 +1。只增不减，用于判断「显示之后有没有心跳过」。
static HEARTBEAT_SEQ: AtomicU64 = AtomicU64::new(0);

/// 本次显示挂件窗时的心跳序号基线（与当前序号相等 = 显示后一次心跳都没有）。
static SHOWN_HEARTBEAT_SEQ: AtomicU64 = AtomicU64::new(0);

/// 本进程内已自动重建挂件窗的次数（上限 [`HEARTBEAT_REBUILD_MAX`]，防重建风暴）。
static REBUILD_ATTEMPTS: AtomicU32 = AtomicU32::new(0);

/// 自动重建是否已放弃（多次失败后只记一次日志，不再刷屏）。
static REBUILD_GAVE_UP: AtomicBool = AtomicBool::new(false);

/// Z 序连续不匹配的次数（去抖用）。
static REASSERT_MISMATCH: AtomicU32 = AtomicU32::new(0);

/// 本轮已连续纠正失败的次数（到 [`REASSERT_MAX_FIXES`] 就退避）。
static REASSERT_FIXES: AtomicU32 = AtomicU32::new(0);

/// 退避期内不再纠正的截止时刻（unix 秒，0 = 不在退避）。
static REASSERT_RETRY_AT: AtomicU64 = AtomicU64::new(0);

/// 是否已触发过保险丝（只记一次日志，不刷屏）。
static REASSERT_GAVE_UP: AtomicBool = AtomicBool::new(false);

/// 上次自动重建的时刻（unix 秒；用于冷却 [`HEARTBEAT_REBUILD_COOLDOWN_SECS`]）。
static LAST_REBUILD_AT: AtomicU64 = AtomicU64::new(0);

/// `grid_meta` 中「挂件最近一次前端故障」的键名（管理页展示，供用户截图反馈）。
const META_KEY_OVERLAY_FAULT: &str = "overlay_last_fault";

/// 当前 unix 秒（失败返回 0）。
fn unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 挂件生命周期日志（追加到 `%LOCALAPPDATA%/Handy/grid-debug.log`）。
///
/// 现场排查只能靠文件：贴桌面层的窗口行为受第三方桌面工具影响很大，用户说
/// 「闪一下没了」时，只有日志能区分是「Z 序反复重排」「自动重建」还是「前端白屏」。
fn grid_log(message: &str) {
    use std::io::Write;
    let Some(base) = dirs::data_local_dir() else {
        println!("[Handy][挂件] {message}");
        return;
    };
    let dir = base.join("Handy");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("grid-debug.log");
    let line = format!("[{}] {message}\n", now_iso());
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = file.write_all(line.as_bytes());
    }
    println!("[Handy][挂件] {message}");
}

/// 记录当前时间为中心跳基线。
fn store_heartbeat_now() {
    LAST_HEARTBEAT.store(unix_secs(), Ordering::Relaxed);
    HEARTBEAT_SEQ.fetch_add(1, Ordering::Relaxed);
}

/// 标记「挂件窗刚被显示」：重置冷启动判定基线。
fn mark_overlay_shown() {
    OVERLAY_SHOWN_AT.store(unix_secs(), Ordering::Relaxed);
    SHOWN_HEARTBEAT_SEQ.store(HEARTBEAT_SEQ.load(Ordering::Relaxed), Ordering::Relaxed);
    REBUILD_GAVE_UP.store(false, Ordering::Relaxed);
}

/// 挂件前端心跳（每 10 秒一次；JS 存活即有心跳）。仅作诊断信息记录，不再触发重建。
#[tauri::command]
pub async fn grid_overlay_heartbeat() -> Result<(), String> {
    store_heartbeat_now();
    Ok(())
}

/// 挂件层的真实状态（管理页据此对齐开关，避免「按钮与实际状态相反」）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayStatus {
    /// 挂件窗当前是否真的显示着
    pub visible: bool,
    /// 挂件窗是否已创建（区分「没建过」与「建了但收起了」）
    pub exists: bool,
    /// 当前基准层：`desktop`（贴桌面）或 `normal`
    pub attach_mode: String,
    /// 系统桌面图标是否处于隐藏态
    pub icons_hidden: bool,
}

/// 查询挂件层真实状态（**唯一真相来源**：窗口本身，而不是前端局部 state）。
#[tauri::command]
pub async fn grid_overlay_status(app: AppHandle) -> Result<OverlayStatus, String> {
    let visible = app
        .get_webview_window(GRID_LABEL)
        .map(|win| win.is_visible().unwrap_or(false))
        .unwrap_or(false);
    let exists = app.get_webview_window(GRID_LABEL).is_some();
    Ok(OverlayStatus {
        visible,
        exists,
        attach_mode: read_attach_mode(&app).as_str().to_string(),
        icons_hidden: read_icons_hidden(&app),
    })
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

/// 一键整理的格子排布：**靠右自动流**（详见 [`arrange_position`]）。
const ARRANGE_MARGIN: i64 = 32;
const ARRANGE_STEP_X: i64 = 344;
const ARRANGE_STEP_Y: i64 = 268;
const ARRANGE_BOX_W: i64 = 320;
const ARRANGE_BOX_H: i64 = 244;
/// 单行最多摆几列（超宽屏也别一路排到左边缘之外）
const ARRANGE_MAX_COLUMNS: i64 = 8;

/// 按工作区宽度算一行能摆几列（至少 1 列、最多 [`ARRANGE_MAX_COLUMNS`] 列）。
fn arrange_columns(work_width: i64) -> i64 {
    ((work_width - ARRANGE_MARGIN) / ARRANGE_STEP_X).clamp(1, ARRANGE_MAX_COLUMNS)
}

/// 靠右自动流的落点：第 `index` 个格子（0 起）的逻辑像素坐标。
///
/// 用户建议原话：「建议格子靠右自动流布局」。直觉来自桌面图标 —— 从右边缘开始摆，
/// 摆满一列往左推一列，一行到底再换下一行；这样新格子永远落在眼睛习惯的位置，
/// 也不会把桌面左侧压满。
fn arrange_position(work_width: i64, index: i64) -> (i64, i64) {
    let columns = arrange_columns(work_width);
    let col = index % columns;
    let row = index / columns;
    // col = 0 最靠右，往左依次推进一列；`.`max(MARGIN) 兜住极窄工作区
    let x = (work_width - ARRANGE_MARGIN - ARRANGE_BOX_W - col * ARRANGE_STEP_X).max(ARRANGE_MARGIN);
    let y = ARRANGE_MARGIN + row * ARRANGE_STEP_Y;
    (x, y)
}

/// 一键收纳结果摘要（前端据此提示「收纳了几个条目、建了几个格子」）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoArrangeReport {
    /// 桌面根目录扫描到的可见条目数（含快捷方式 / 文件夹）
    pub scanned: usize,
    /// 本次真正移动进收纳目录的条目数（文件 + 文件夹）
    pub items_added: usize,
    /// 其中文件夹占的数量（V34 起文件夹也纳入收纳）
    pub folders_moved: usize,
    /// 本次新建的格子数
    pub boxes_created: usize,
    /// 复用了同名已有格子的次数
    pub boxes_reused: usize,
    /// 按设计跳过的条目数（只剩快捷方式 `.lnk` —— 用户要求留在桌面原位）
    pub skipped: usize,
    /// 单条目失败原因（不中断整批，前端原样展示给用户）
    pub failures: Vec<String>,
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

/// 一键收纳核心（连接与桌面目录由调用方给定）。
///
/// V33 起重写为**真移动**；V34 两处修正：
///   - **文件夹纳入收纳**（只留 `.lnk` 不动）：用户实测「文件夹的整理根本都不生效」，
///     根因就是这里把 `is_dir` 整个跳过 —— 「文件夹」格因此永远是空的；
///   - **靠右自动流排布**：新格子从工作区右边缘起、自右往左推进（见 [`arrange_position`]）。
///
/// `work_width` 是工作区（挂件窗）的逻辑宽度，用于算右对齐落点；<= 0 时退回 1280。
fn auto_arrange_inner(
    conn: &Connection,
    desktop: &Path,
    work_width: i64,
) -> Result<AutoArrangeReport, String> {
    use std::collections::HashMap;

    let width = if work_width > 0 { work_width } else { 1280 };
    let scanned = crate::commands::organizer::scan_items(desktop)?;
    let total_scanned = scanned.len();
    let storage = storage_root()?;
    ensure_dir(&storage)?;
    // 收纳根目录自己绝不能被搬进自己（`桌面/Handy整理` 也可能被 scan_items 扫到）
    let storage_key = storage.to_string_lossy().to_string();

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

    // 按类别分组（**只跳过快捷方式**；文件夹归「文件夹」组）
    let mut grouped: Vec<(String, Vec<usize>)> = Vec::new();
    for (index, item) in scanned.iter().enumerate() {
        if item.is_lnk || item.path == storage_key {
            continue;
        }
        let key = arrange_group_of(item);
        match grouped.iter_mut().find(|(name, _)| *name == key) {
            Some((_, bucket)) => bucket.push(index),
            None => grouped.push((key, vec![index])),
        }
    }
    grouped.sort_by_key(|(name, _)| arrange_group_rank(name));

    let mut report = AutoArrangeReport {
        scanned: total_scanned,
        items_added: 0,
        folders_moved: 0,
        boxes_created: 0,
        boxes_reused: 0,
        // 快捷方式按设计不动，明确计入「跳过」，让用户看到不是漏了
        skipped: scanned.iter().filter(|item| item.is_lnk).count(),
        failures: Vec::new(),
    };

    for (label, indices) in grouped {
        if indices.is_empty() {
            continue;
        }
        let dir = box_dir(&storage, &label);
        ensure_dir(&dir)?;

        let box_id: i64 = match existing.get(&label) {
            Some(id) => {
                report.boxes_reused += 1;
                *id
            }
            None => {
                let now = now_iso();
                let (pos_x, pos_y) = arrange_position(width, occupied);
                // 全表求最大值：该 SQL 无占位符，必须传 None
                let sort = next_sort(
                    conn,
                    "SELECT COALESCE(MAX(sort) + 1, 0) FROM grid_boxes",
                    None,
                )?;
                conn.execute(
                    "INSERT INTO grid_boxes \
                     (name, kind, pos_x, pos_y, width, height, sort, created_at, updated_at) \
                     VALUES (?1, 'folder', ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
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

        for index in indices {
            let Some(item) = scanned.get(index) else {
                continue;
            };
            let source = Path::new(&item.path);
            match move_with_conflict_rename(source, &dir) {
                Ok(_) => {
                    report.items_added += 1;
                    if item.is_dir {
                        report.folders_moved += 1;
                    }
                }
                Err(err) => report.failures.push(format!("{}：{err}", item.name)),
            }
        }

        // 移动完成后按目录对账 → 登记表与磁盘严格一致
        reconcile_box(conn, box_id, &label, "folder", &storage)?;
    }

    Ok(report)
}

/// 布局可用的逻辑宽度。
///
/// 优先用挂件窗自身的宽度 —— 格子的 `pos_x` 本来就是**相对挂件窗客户区**的，
/// 拿显示器宽度去算会在「窗口没铺满屏幕」时把格子推到窗口外面。
/// 窗口还没建时退回主显示器工作区宽度；都拿不到给 1280。
fn layout_work_width(app: &AppHandle) -> i64 {
    if let Some(win) = app.get_webview_window(GRID_LABEL) {
        if let (Ok(size), Ok(scale)) = (win.inner_size(), win.scale_factor()) {
            if scale > 0.0 && size.width > 0 {
                return (f64::from(size.width) / scale).round() as i64;
            }
        }
    }
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale = monitor.scale_factor();
        if scale > 0.0 {
            return (f64::from(monitor.work_area().size.width) / scale).round() as i64;
        }
    }
    1280
}

/// 一键收纳桌面：扫描 → 文件与文件夹按类型移动进 `桌面/Handy整理/<类别>/` → 每类一格。
///
/// **只有快捷方式（`.lnk`）不动**（用户明确要求「原生快捷方式不需要动态整理」）；
/// 文件夹按用户实测反馈一并收纳（V34：「文件夹的整理根本都不生效」）。
/// `dir` 仅供测试 / 自定义目录，缺省为用户桌面。
#[tauri::command]
pub async fn grid_auto_arrange(
    app: AppHandle,
    dir: Option<String>,
) -> Result<AutoArrangeReport, String> {
    let desktop: PathBuf = match dir {
        Some(value) if !value.trim().is_empty() => PathBuf::from(value.trim()),
        _ => desktop_root()?,
    };
    let conn = connect(&app)?;
    auto_arrange_inner(&conn, &desktop, layout_work_width(&app))
}

/// 对账全部收纳格：按磁盘目录补齐新出现的文件、清掉已消失的登记。
///
/// 返回 `(参与对账的收纳格数, 补登记数, 清理数)`。
fn reconcile_all_boxes(conn: &Connection, root: &Path) -> Result<(usize, usize, usize), String> {
    let boxes: Vec<(i64, String, String)> = {
        let mut stmt = conn
            .prepare("SELECT id, name, kind FROM grid_boxes ORDER BY sort ASC, id ASC")
            .map_err(|err| format!("读取格子失败：{err}"))?;
        let mapped = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|err| format!("读取格子失败：{err}"))?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("读取格子失败：{err}"))?
    };

    let mut counted = 0usize;
    let mut added = 0usize;
    let mut pruned = 0usize;
    for (box_id, name, kind) in boxes {
        if kind != "folder" {
            continue;
        }
        counted += 1;
        let before = list_registry_items(conn, box_id)?.len();
        let after = reconcile_box(conn, box_id, &name, &kind, root)?.len();
        if after >= before {
            added += after - before;
        } else {
            pruned += before - after;
        }
    }
    Ok((counted, added, pruned))
}

/// 桌面同步报告（V33 起 sync = **只对账，不收录**）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSyncReport {
    /// 参与对账的收纳格数
    pub boxes: usize,
    /// 收纳目录里新发现并登记的条目数（含用户在资源管理器里手工放进格子的文件）
    pub items_added: usize,
    /// 清理掉的失效登记数（文件已被移出 / 删除）
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
///
/// 取图标做成三级，越靠前越像桌面：
///   ① 系统图像列表 `SHIL_EXTRALARGE` = **48×48** —— 与桌面 / 资源管理器的
///      「中等图标」同尺寸；
///   ② 退到 `SHGetFileInfoW` 的 `SHGFI_LARGEICON` = 32×32；
///   ③ 全失败返回 `None`，由前端回退通用线条图标。
///
/// 三级都带 `SHGFI_LINKOVERLAY | SHGFI_ADDOVERLAYS` —— 这是用户那句「整理到格子里
/// 面的图标样式都变了」的正解：不带叠层标志时拿到的是**基础图标**，`.lnk` 会丢掉
/// 左下角那个小箭头，于是同一个快捷方式在桌面上和格子里长得不一样。
#[cfg(target_os = "windows")]
fn extract_icon_rgba_impl(path: &str) -> Option<FileIconData> {
    use windows::Win32::UI::WindowsAndMessaging::DestroyIcon;

    let icon = shell_icon_handle(path)?;
    let result = icon_to_rgba(icon);
    // SAFETY: icon 是本函数刚取得的 HICON 所有权，用完即销毁
    unsafe {
        let _ = DestroyIcon(icon);
    }
    result
}

/// 取一个「跟资源管理器一样」的图标句柄（优先 48×48）。
#[cfg(target_os = "windows")]
fn shell_icon_handle(path: &str) -> Option<windows::Win32::UI::WindowsAndMessaging::HICON> {
    use std::os::windows::ffi::OsStrExt;

    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
    use windows::Win32::UI::Shell::{
        SHGetFileInfoW, SHFILEINFOW, SHGFI_ADDOVERLAYS, SHGFI_ICON, SHGFI_LARGEICON,
        SHGFI_LINKOVERLAY, SHGFI_SYSICONINDEX,
    };

    let wide: Vec<u16> = std::ffi::OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    // ① 系统大图标列表（48×48）
    let mut sfi = SHFILEINFOW::default();
    let info_ok = unsafe {
        SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            FILE_ATTRIBUTE_NORMAL,
            Some(&mut sfi as *mut SHFILEINFOW as *mut _),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_SYSICONINDEX | SHGFI_LINKOVERLAY | SHGFI_ADDOVERLAYS,
        )
    };
    if info_ok != 0 {
        if let Some(icon) = image_list_icon(sfi.iIcon, SHIL_EXTRALARGE) {
            return Some(icon);
        }
    }

    // ② 退到 32×32 大图标（叠层照旧要）
    let mut fallback = SHFILEINFOW::default();
    let ok = unsafe {
        SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            FILE_ATTRIBUTE_NORMAL,
            Some(&mut fallback as *mut SHFILEINFOW as *mut _),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON | SHGFI_LINKOVERLAY | SHGFI_ADDOVERLAYS,
        )
    };
    if ok == 0 || fallback.hIcon.is_invalid() {
        return None;
    }
    Some(fallback.hIcon)
}

/// `SHIL_EXTRALARGE`：系统图像列表里 48×48 的那一档（`SHGetImageList` 的索引值）。
#[cfg(target_os = "windows")]
const SHIL_EXTRALARGE: i32 = 2;

/// 从系统图像列表取出第 `index` 个图标。
///
/// 为什么要绕这一道：`SHGetFileInfoW` 只给 32×32（`SHGFI_LARGEICON`）；要拿到桌面
/// 「中等图标」那种 48×48，只能进系统图像列表取。
///
/// windows-rs 0.58 把 `SHGetImageList` 包成了泛型返回（`Result<T>`），不再需要手写
/// IID —— 这里显式标注 `IImageList` 让类型推导落地。系统图像列表是进程内共享对象，
/// `SHGetImageList` 已加过引用计数，由 `IImageList` 自身负责释放，不泄漏。
///
/// 另注：0.58 的 `IImageList::GetIcon(i, flags) -> Result<HICON>` 是**返回值**式签名
/// （老版本是 `&mut HICON` 出参），`flags` 要裸 `u32`，所以 `ILD_TRANSPARENT` 取 `.0`。
#[cfg(target_os = "windows")]
fn image_list_icon(index: i32, size: i32) -> Option<windows::Win32::UI::WindowsAndMessaging::HICON> {
    use windows::Win32::UI::Controls::{IImageList, ILD_TRANSPARENT};
    use windows::Win32::UI::Shell::SHGetImageList;

    // SAFETY: 系统图像列表由 shell 维护、进程内共享；取出的 HICON 归调用方所有。
    unsafe {
        let list: IImageList = match SHGetImageList(size) {
            Ok(value) => value,
            Err(_) => return None,
        };
        match list.GetIcon(index, ILD_TRANSPARENT.0) {
            Ok(icon) if !icon.is_invalid() => Some(icon),
            _ => None,
        }
    }
}

/// `HICON` → RGBA 像素（统一处理 alpha 通道与 BGRA→RGBA 换序）。
#[cfg(target_os = "windows")]
fn icon_to_rgba(hicon: windows::Win32::UI::WindowsAndMessaging::HICON) -> Option<FileIconData> {
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, BITMAPINFO, BITMAPINFOHEADER,
        DIB_RGB_COLORS, HBITMAP,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetIconInfo, ICONINFO};

    unsafe {
        let mut info = ICONINFO::default();
        if GetIconInfo(hicon, &mut info).is_err() {
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
}

/// 桌面同步 —— 格子层的数据引擎（前端周期调用）：**只对账，不收录**。
///
/// V33 起这里不再「自动把桌面文件收进格子」—— 那正是用户抱怨「和桌面原图标
/// 完全重复、像复制了一份」的来源。现在只做一件事：按磁盘目录对账每个收纳格 ——
/// 用户在资源管理器里手工放进格子的文件会补登记，被移走 / 删除的会清掉登记。
///
/// V34 去掉了「兜底建系统格子」。此电脑 / 回收站是 Explorer **恒定显示**的桌面
/// 入口，不受任何桌面工具控制，格子里那份纯属重复（用户截图里两个「我的电脑」
/// 并排）；用户明确说「系统这个不需要」。已存在的系统格由迁移 v7 清掉。
///
/// 想批量收纳桌面文件，走显式的「一键收纳」（`grid_auto_arrange`），它**真移动**文件。
#[tauri::command]
pub async fn grid_desktop_sync(app: AppHandle) -> Result<DesktopSyncReport, String> {
    let root = storage_root()?;
    let conn = connect(&app)?;
    let (boxes, added, pruned) = reconcile_all_boxes(&conn, &root)?;
    Ok(DesktopSyncReport {
        boxes,
        items_added: added,
        pruned,
    })
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

/// Z 序纵深判据的回归。
///
/// 这条判据是本项目历史上**错过两次**的地方（V33 放宽周期、V34 收紧周期都是围绕它打转），
/// 而且它的失效方式特别隐蔽：判据错了不会报错，只会「每秒重排一次」——
/// 用户看到的是「格子一直闪、有时又出来」，代码里看不出任何异常。
/// 所以这里把判据的**语义**钉住，改的时候必须让这些断言仍然成立。
#[cfg(all(test, target_os = "windows"))]
mod z_verdict_tests {
    use super::*;
    use std::ffi::c_void;

    /// 造一个假句柄（只用于比较，不会交给系统 API）
    fn h(value: usize) -> HWND {
        HWND(value as *mut c_void)
    }

    #[test]
    fn desktop_directly_below_is_the_ideal_case() {
        let host = h(1);
        assert_eq!(
            classify_chain(&[host], host, false),
            ZVerdict::InDesktopBand
        );
    }

    #[test]
    fn interlopers_between_us_and_desktop_are_not_a_mismatch() {
        // ★ 这条就是 V35 修的核心缺陷。
        // 桌面正上方那一格是公共地段：搜狗输入法的 6 个隐藏助手窗、本应用主窗
        // 都会停在这儿。旧判据要求「正下方必须**正好**是桌面」，于是一出现邻居
        // 就判错位 ⇒ 每秒纠一次、永远纠不完 ⇒ 用户看到「一直闪」。
        // 现在只要往下走一段能碰到桌面就算对。
        let host = h(1);
        let chain = [h(0x708d4), h(0x2f0b72), h(0x1035a), host];
        assert_eq!(classify_chain(&chain, host, false), ZVerdict::InDesktopBand);
    }

    #[test]
    fn walking_to_the_bottom_without_finding_desktop_means_we_are_below_it() {
        // 被压在桌面下面 = 用户看到的「格子不见了」，必须纠正
        let host = h(1);
        let chain = [h(9), h(8)];
        assert_eq!(classify_chain(&chain, host, true), ZVerdict::BelowDesktop);
    }

    #[test]
    fn many_windows_above_us_means_we_are_too_high() {
        // 走满扫描预算还没碰到桌面 ⇒ 被顶得很高（会盖住别的窗口），也要纠正
        let host = h(1);
        let chain: Vec<HWND> = (100..100 + REASSERT_SCAN_STEPS).map(h).collect();
        assert_eq!(chain.len(), REASSERT_SCAN_STEPS);
        assert_eq!(classify_chain(&chain, host, false), ZVerdict::TooHigh);
    }

    #[test]
    fn empty_chain_at_bottom_is_below_desktop() {
        let host = h(1);
        assert_eq!(classify_chain(&[], host, true), ZVerdict::BelowDesktop);
    }

    #[test]
    fn scan_budget_is_big_enough_for_a_busy_desktop_edge() {
        // 保险丝不能因为「邻居多了几个」就误判成 TooHigh —— 给足余量。
        assert!(
            REASSERT_SCAN_STEPS >= 12,
            "桌面正上方是公共地段，扫描预算太小会把正常邻居算成「被顶得很高」"
        );
        // 纠正必须有上限，否则一旦判据与现实不符就是无限重排（= 一直闪）
        assert!(REASSERT_MAX_FIXES >= 1 && REASSERT_MAX_FIXES <= 10);
        assert!(REASSERT_GIVEUP_BACKOFF_SECS >= 60);
        // 自检节奏必须是时间量，不能跟着轮询周期走（V35 的教训）
        assert!(REASSERT_INTERVAL_SECS >= 1);
    }
}

