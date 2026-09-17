//! 桌面网格挂件（desktop grid widget）——**呈现层**桌面整理（V37 起重定，V38 补完）。
//!
//! ## 模型：格子是桌面的另一种呈现方式，不拥有任何文件
//!
//! 这条结论走过两轮弯路，别再按中间任何一版推理：
//!
//! | 版本 | 模型 | 结局 |
//! | --- | --- | --- |
//! | V25–V32 | 引用登记，但**不接管桌面呈现** | 桌面与格子各显示一份，用户：「并不是整理收纳，而是复制了一份而已」 |
//! | V33–V36 | 真实收纳：`fs::rename` 进 `桌面/Handy整理/<格名>/` | 用户明确否决：「是桌面整理，不是让你把桌面上的东西都给我移动到一个目录下面去，这个完全是错误的」 |
//! | **V37 起** | **呈现层**：只登记引用 + 由格子接管桌面呈现 | 现行方案 |
//!
//! 现行三条硬规矩：
//!   1. **一个字节都不挪**：拖入 / 移出 / 换格子 / 一键整理，全部只改 `grid_items`
//!      的一行登记，文件永远留在桌面原位（对标腾讯桌面整理）；
//!   2. **桌面图标交给格子代管**（V38）：既然格子里的条目就是桌面文件的引用，
//!      原生图标与之并存就是「桌面又两个相同的内容」（用户原话）。所以「接管」
//!      = 隐藏 `SysListView32`，桌面上只留格子一份；偏好记在
//!      [`META_KEY_TAKEOVER`]，收起挂件 / 退出应用立刻把图标还给系统；
//!   3. **格子建了就在**（V38）：空格子也常驻显示。曾经按「空不占位」滤掉过，
//!      用户反馈是「动不动就不见了，我找不到不见的规律到底是什么」。
//!
//! 格子同时是**挂件容器**：`kind` 区分 `folder`（收纳格）/ `note`（便签）/
//! `calendar`（日历 + 今日计划）。非 folder 类型的格子不参与条目登记，内容存在
//! `content` 列里，位置由用户自己摆 —— **自动排布会绕开它们**（见 [`FlowPlacer`]）。
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
    /// 归类类别（`''` = 纯手动，不参与自动归类）。V37 引入：自动归类要认出
    /// 「哪个格子收文档、哪个收图片」，靠格子名匹配的话用户一改名就失联。
    pub category: String,
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
const BOX_COLUMNS: &str = "b.id, b.name, b.kind, b.content, b.accent, b.category, b.pos_x, b.pos_y, \
                           b.width, b.height, b.sort, b.created_at, b.updated_at";

/// 行 → 盒子实体（SQL 必须附带 `item_count` 计数列）。
fn row_to_box_with_count(row: &Row) -> rusqlite::Result<GridBox> {
    Ok(GridBox {
        id: row.get("id")?,
        name: row.get("name")?,
        kind: row.get("kind")?,
        content: row.get("content")?,
        accent: row.get("accent")?,
        category: row.get("category")?,
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

// —— 收纳目录：V33–V36 的「真实收纳」层已随 V37 的呈现层模型作废 ——
//
// 曾经这里有一整套 `storage_root()` / `box_dir()` / `ensure_dir()` / `list_dir_items()`：
// 格子 = `桌面/Handy整理/<格子名>/` 的真实目录，拖入即 `fs::rename`。
// V37 用户明确否掉后，这些函数全部成了无人调用的死代码（`grid_box_delete` 还在
// 偷偷删空目录，V38 也一并拔掉了）。
//
// 保留 `STORAGE_ROOT_NAME` / `LEGACY_STORAGE_ROOT_NAME` 两个常量 —— 它们不再是
// 「我们要写的目录」，而是「**永远不许进格子 / 永远不许参与归类**的目录名前缀」
// （见 [`is_storage_entry`]），以及「诊断与修复」卡片的扫描目标。
//
// 桌面上那批历史遗留目录请走 [`grid_legacy_reclaim`] / [`grid_legacy_cleanup`]：
// 先干跑预览、只移动不删除、桌面已有同名就跳过。

/// 桌面根目录。
fn desktop_root() -> Result<PathBuf, String> {
    dirs::desktop_dir().ok_or_else(|| "无法定位桌面目录".to_string())
}

/// 冲突安全移动：目标同名时自动追加 ` (2)`、` (3)` …，**绝不覆盖**。
///
/// ⚠️ 函数体开头有一道「目标不在源之内」的闸 —— 见 [`is_storage_entry`] 里记的那次
/// 事故：漏掉这道闸，一次误操作就能在磁盘上炸出几百层嵌套、上百 GB 的副本。
fn move_with_conflict_rename(src: &Path, dest_dir: &Path) -> Result<PathBuf, String> {
    // —— 血案防线（V37 立）——
    // 把目录移进它自己的子目录时，`fs::rename` 必然失败，随后会走到「递归复制 + 删源」
    // 的兜底路径：`copy_dir_recursive` 先 `create_dir_all(dest)` 再遍历源，而 dest 就在源
    // 内部 ⇒ 遍历会看见刚建出的目标并继续递归，一次调用就无限自我复制（磁盘取证：
    // `桌面\Handy整理\新格子 1\Handy整理\新格子 1\…` 重复约 1000 次、路径 7082 字符、
    // 5 份副本共 296 GB）。必须在**任何**磁盘操作之前拦下。
    if src.is_dir() {
        let src_norm = normalize_path(src);
        let dest_norm = normalize_path(dest_dir);
        if dest_norm == src_norm || dest_norm.starts_with(&src_norm) {
            return Err(format!(
                "拒绝把目录移动到它自己里面（{} → {}）",
                src.display(),
                dest_dir.display()
            ));
        }
    }
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

/// 某格子的条目列表（引用模型：**登记是真相，磁盘只做存在性校验**）。
///
/// V37 起不再「按磁盘目录对账」—— 格子不再拥有目录，条目就是桌面上某个文件的引用。
/// 文件被用户在资源管理器里删掉 / 改名后登记会失效，这里直接过滤并清行，
/// 免得格子里留一个点不动的幽灵图标。
fn list_live_items(conn: &Connection, box_id: i64) -> Result<Vec<GridItem>, String> {
    let registered = list_registry_items(conn, box_id)?;
    let mut live = Vec::with_capacity(registered.len());
    let mut pruned: Vec<i64> = Vec::new();
    for item in registered {
        // 虚拟条目（`::{CLSID}`，如「此电脑 / 回收站」）在磁盘上本就不存在 ——
        // 用 `exists()` 判会当场把它当成失效登记清掉，表现为「系统格子一刷新就空」。
        // V38 起显式豁免（`grid_open_path` 早已支持打开这类路径）。
        if item.file_path.starts_with("::") || Path::new(&item.file_path).exists() {
            live.push(item);
        } else {
            pruned.push(item.id);
        }
    }
    for id in pruned {
        conn.execute("DELETE FROM grid_items WHERE id = ?1", params![id])
            .map_err(|err| format!("清理失效条目失败：{err}"))?;
    }
    Ok(live)
}

/// 把某个**已存在**的路径登记进某格子（幂等）。**不移动任何文件** —— 这是 V37 引用模型
/// 唯一的写入通道，自动归类与手动拖入都走它。
///
/// 返回 `Ok(true)` = 新增了一条登记；`Ok(false)` = 按规则跳过（已有 / 用户说过不要 /
/// 已归属别的格子）。跳过不是错误，所以不进 `failures`。
fn register_item(
    conn: &Connection,
    box_id: i64,
    path: &Path,
    display: &str,
) -> Result<bool, String> {
    let stored = path.to_string_lossy().to_string();
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM grid_items WHERE box_id = ?1 AND file_path = ?2",
            params![box_id, stored],
            |row| row.get(0),
        )
        .map_err(|err| format!("检查登记失败：{err}"))?;
    if exists > 0 {
        return Ok(false);
    }
    // 用户明确说过「不要它」→ 尊重用户，自动归类不再加回来
    // （他重新拖进格子时会走 `clear_dismissed` 解禁）
    if read_dismissed(conn)?.contains(&stored) {
        return Ok(false);
    }
    // 归属唯一：已经在别的格子里的，不重复登记（用户想换位置应该拖动它）
    let elsewhere: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM grid_items WHERE file_path = ?1",
            params![stored],
            |row| row.get(0),
        )
        .map_err(|err| format!("检查归属失败：{err}"))?;
    if elsewhere > 0 {
        return Ok(false);
    }
    let sort = next_sort(
        conn,
        "SELECT COALESCE(MAX(sort) + 1, 0) FROM grid_items WHERE box_id = ?1",
        Some(box_id),
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO grid_items (box_id, file_path, display_name, sort, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![box_id, stored, display, sort, now_iso()],
    )
    .map_err(|err| format!("登记条目失败：{err}"))?;
    Ok(true)
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
            // 缺省落点：靠右流布局里第一块**不与任何已有格子（含便签 / 日历）相交**的空位
            // （V38 起复用 `FlowPlacer`，与「一键整理」的排布是同一套规则）
            let (work_w, work_h) = layout_work_size(&app);
            let (auto_x, auto_y) =
                free_slot_for(&conn, work_w, work_h, final_width, final_height);
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
            // V37：格子不再绑定磁盘目录，改名就只是改个名字 —— 早期这里会连带
            // `fs::rename` 收纳目录，那属于「动用户文件」的一部分，随收纳模型一并移除。
            //
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

/// 删除格子。**只删格子与它的登记，绝不碰磁盘**（V38）。
///
/// V33–V36 在这里还会顺手删掉「已经空了的收纳目录」—— 那是「格子 = 真实目录」模型
/// 的遗留。V37 换回呈现层后，格子与磁盘再无任何关系，用户桌面上的任何目录
/// （包括历史遗留的 `Handy整理/`）都只由「诊断与修复」卡片经用户确认后处理。
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

// —— 条目 CRUD（V37 呈现层：只是「哪个文件显示在哪个格子里」的登记，
//    三个写入口都不会对磁盘做任何增删改） ——

/// 把文件登记进某个收纳格 —— **只登记，文件一个字节都不动**（V37 起）。
///
/// V33–V36 走的是「真实收纳」：把文件 `fs::rename` 进 `桌面/Handy整理/<格子名>/`。
/// 用户装机实测后明确否掉了这个模型 ——「是桌面整理，不是让你把桌面上的东西都给我移动
/// 到一个目录下面去」。于是回到真正桌面工具的语义：**文件永远留在原处，格子只是桌面上
/// 这批图标的呈现层**（腾讯桌面整理就是这个行为）。
///
/// - 同一文件已在别的格子 → 视作「把它挪到这儿」，只改归属，不新增登记；
/// - `Handy整理*` 目录本身永远不许进格子（V36 事故的入口之一）；
/// - 登记前清掉该路径在「不要它」名单里的记录（用户重新拖进来就是改主意了）。
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
    if let Some(name) = source.file_name().and_then(|value| value.to_str()) {
        if is_storage_entry(name) {
            return Err("这是 Handy 自己的收纳目录，不能放进格子".to_string());
        }
    }
    let entity = load_box(&app, box_id)?;
    if entity.kind != "folder" {
        return Err("该格子不是收纳格，不能放文件".to_string());
    }
    let stored = source.to_string_lossy().to_string();
    let conn = connect(&app)?;
    let display = match display_name {
        Some(value) if !value.trim().is_empty() => value.trim().to_string(),
        _ => source
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| stored.clone()),
    };
    clear_dismissed(&conn, &stored)?;

    // 已在某个格子里（含本格）→ 只改归属，不新增登记
    if let Some((item_id, current_box)) = conn
        .query_row(
            "SELECT id, box_id FROM grid_items WHERE file_path = ?1",
            params![stored],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .ok()
    {
        if current_box != box_id {
            // 目标格若已有同路径的陈旧登记，先清掉，避免同一文件在目标格出现两行
            conn.execute(
                "DELETE FROM grid_items WHERE box_id = ?1 AND file_path = ?2",
                params![box_id, stored],
            )
            .map_err(|err| format!("更新条目归属失败：{err}"))?;
            let sort = next_sort(
                &conn,
                "SELECT COALESCE(MAX(sort) + 1, 0) FROM grid_items WHERE box_id = ?1",
                Some(box_id),
            )?;
            conn.execute(
                "UPDATE grid_items SET box_id = ?1, sort = ?2, display_name = ?3 WHERE id = ?4",
                params![box_id, sort, display, item_id],
            )
            .map_err(|err| format!("更新条目归属失败：{err}"))?;
            grid_log(&format!(
                "条目「{display}」改归属到格子「{}」（文件未移动）",
                entity.name
            ));
        }
        return conn
            .query_row(
                "SELECT id, box_id, file_path, display_name, sort, created_at \
                 FROM grid_items WHERE id = ?1",
                params![item_id],
                row_to_item,
            )
            .map_err(|err| format!("读取条目失败：{err}"));
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
        params![box_id, stored, display, sort, created],
    )
    .map_err(|err| format!("登记收纳条目失败：{err}"))?;
    grid_log(&format!(
        "登记「{display}」到格子「{}」（文件留在 {stored}，未移动）",
        entity.name
    ));

    Ok(GridItem {
        id: conn.last_insert_rowid(),
        box_id,
        file_path: stored,
        display_name: display,
        sort,
        created_at: created,
    })
}

/// 把条目移出格子 —— **只删登记，文件原位不动、更不删除**（V37 起）。
///
/// 同时把路径记入「不要它」名单：否则下一次自动归类又会把它塞回同一个格子，
/// 用户看到的是「点了 × 却怎么都去不掉」。
///
/// `dismiss` 是旧版前端参数（曾经表示「不再自动收录」），保留形参以免旧调用报错。
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

    let mut set = read_dismissed(&conn)?;
    set.insert(path.clone());
    let _ = write_dismissed(&conn, &set);

    let affected = conn
        .execute("DELETE FROM grid_items WHERE id = ?1", params![item_id])
        .map_err(|err| format!("删除挂件条目失败：{err}"))?;
    if affected == 0 {
        return Err("挂件条目不存在或已被删除".to_string());
    }
    let short = Path::new(&path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    grid_log(&format!(
        "从格子「{}」移出「{short}」（文件未删除，仍在 {path}）",
        entity.name
    ));
    Ok(())
}

/// 把一个条目挪到另一个格子 —— **只改归属，文件原位不动**（V37 起）。
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
    // 目标格若已有同路径的陈旧登记 → 先删掉，避免同一文件在目标格出现两行
    conn.execute(
        "DELETE FROM grid_items WHERE box_id = ?1 AND file_path = ?2 AND id <> ?3",
        params![target_box_id, path, item_id],
    )
    .map_err(|err| format!("整理目标格子失败：{err}"))?;
    let sort = next_sort(
        &conn,
        "SELECT COALESCE(MAX(sort) + 1, 0) FROM grid_items WHERE box_id = ?1",
        Some(target_box_id),
    )?;
    conn.execute(
        "UPDATE grid_items SET box_id = ?1, sort = ?2 WHERE id = ?3",
        params![target_box_id, sort, item_id],
    )
    .map_err(|err| format!("更新收纳条目失败：{err}"))?;
    let short = Path::new(&path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    grid_log(&format!(
        "条目「{short}」改归属到格子「{}」（文件未移动）",
        target.name
    ));
    Ok(())
}

/// 某格子的条目列表（引用模型：登记为真相，磁盘只做存在性校验）。
#[tauri::command]
pub async fn grid_item_list(app: AppHandle, box_id: i64) -> Result<Vec<GridItem>, String> {
    let conn = connect(&app)?;
    let entity = load_box(&app, box_id)?;
    list_live_items(&conn, entity.id)
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
///
/// ⚠️ 这是**瞬时状态**（此刻图标是不是被我们藏着），不是偏好 —— 与
/// [`META_KEY_TAKEOVER`] 分开记：收起挂件 / 退出应用会立刻恢复图标，但用户的
/// 「由格子接管桌面」偏好要留着，下次显示格子时依它重新隐藏。
const META_KEY_ICONS_HIDDEN: &str = "desktop_icons_hidden";

/// `grid_meta` 中「是否由格子层接管桌面呈现」的键名（V38）。
///
/// 值 = `"1"`：整理桌面后隐藏系统桌面图标，桌面只由格子画 —— 用户 V38 原话
/// 「不是整理了图标都收纳到格子里面 但是桌面原来的图标还在原地 没有消失
/// 相当于桌面又两个相同的内容了」。`"0"` / 缺失 = 原生图标与格子共存。
const META_KEY_TAKEOVER: &str = "desktop_takeover";

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

/// 读「整理由格子层接管桌面呈现」偏好（V38）。
fn read_takeover(app: &AppHandle) -> bool {
    let Ok(conn) = connect(app) else {
        return false;
    };
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM grid_meta WHERE key = ?1",
            params![META_KEY_TAKEOVER],
            |row| row.get(0),
        )
        .ok();
    raw.as_deref() == Some("1")
}

/// 写「整理由格子层接管桌面呈现」偏好（V38）。
fn write_takeover(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let conn = connect(app)?;
    conn.execute(
        "INSERT INTO grid_meta (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![META_KEY_TAKEOVER, if enabled { "1" } else { "0" }],
    )
    .map_err(|err| format!("保存桌面接管偏好失败：{err}"))?;
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

/// 把某个路径从「不要它」名单里去掉。
///
/// 用户把它重新拖进格子 = 改主意了；不清掉这一条，下次自动归类又会绕开它，
/// 表现为「我明明放进去了，一刷新又没了」。
fn clear_dismissed(conn: &Connection, path: &str) -> Result<(), String> {
    let mut set = read_dismissed(conn)?;
    if set.remove(path) {
        write_dismissed(conn, &set)?;
    }
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

/// 切换「由格子接管桌面呈现」（V38）：`true` = 隐藏原生桌面图标，`false` = 共存。
///
/// 与 `grid_desktop_icons_set` 的区别：那条是**一次性**动作（开关一下就走），
/// 这条会**记住**用户的选择，此后每次显示格子都按它执行（收起挂件 / 退出应用
/// 依然立刻把图标还给系统，见 `grid_overlay_hide` / `restore_desktop_icons`）。
///
/// 返回「此刻图标是否确实处于隐藏态」—— 隐藏失败（例如被第三方桌面工具接管了
/// 图标视图）时返回 false，前端据此提示用户「本机不支持自动隐藏，桌子会同时显示
/// 格子与原图标」。
#[tauri::command]
pub async fn grid_takeover_set(app: AppHandle, enabled: bool) -> Result<bool, String> {
    write_takeover(&app, enabled)?;
    Ok(takeover_icons(&app, enabled))
}

/// 读「是否由格子接管桌面呈现」偏好 + 此刻图标的真实可见性。
#[tauri::command]
pub async fn grid_takeover_get(app: AppHandle) -> Result<TakeoverState, String> {
    Ok(TakeoverState {
        enabled: read_takeover(&app),
        icons_visible: desktop_icons_visible(),
    })
}

/// 桌面接管状态（前端工具栏据此显示「原生图标：已隐藏 / 已显示」）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TakeoverState {
    /// 用户的偏好：整理后是否由格子接管桌面呈现
    pub enabled: bool,
    /// 此刻系统桌面图标是否可见（隐藏失败 / 已被收起时会与 enabled 不一致）
    pub icons_visible: bool,
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
                    // V39：接管也要自检 —— 图标被系统恢复（Win+D / 显示桌面 / Explorer 重建）
                    // 之后必须重新藏起来，否则桌面就永久变成「格子 + 原图标」两份内容。
                    reassert_takeover(&app);
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
///
/// 返回「此刻图标是否确实被我们藏起来了」（V38 起把结果透给调用方，让 UI 能说实话）。
fn takeover_icons(app: &AppHandle, hidden: bool) -> bool {
    let applied = matches!(desktop_icons_apply(hidden), Ok(true));
    match (hidden, applied) {
        (true, true) => {
            let _ = write_icons_hidden(app, true);
        }
        (true, false) => {
            grid_log("未找到系统桌面图标视图，跳过隐藏（可能已被第三方桌面工具接管）");
        }
        (false, false) => {}
        (false, true) => {
            let _ = write_icons_hidden(app, false);
        }
    }
    // 只有真正把图标藏起来才标记代管；恢复或失败一律解除
    let taken = applied && hidden;
    ICONS_TAKEN.store(taken, Ordering::Relaxed);
    taken
}

/// 兜底恢复：挂件层已不可见但图标仍在代管 → 立即还给系统（轮询线程调用）。
fn release_icons_if_taken(app: &AppHandle) {
    if ICONS_TAKEN.swap(false, Ordering::Relaxed) {
        let _ = desktop_icons_apply(false);
        let _ = write_icons_hidden(app, false);
        // ⚠️ V39 起走 grid_log 落盘：V38 这里是 println!，**只进控制台、不写 handy.log**，
        // 于是「图标被谁还回去了」在复盘时完全看不见 —— 用户反馈「源图标还在」时，
        // 这个盲区让排查多绕了一大圈。
        grid_log("挂件层已不可见，把系统桌面图标还给系统");
    }
}

/// **接管自检**（V39）：偏好要求接管、图标却露出来了 → 重新隐藏。
///
/// # 为什么必须有这一步（用户反馈「源图标还在」的真根因）
///
/// 轮询线程里有一条兜底：挂件窗一旦不可见就 [`release_icons_if_taken`]（把图标还给系统）。
/// 这是 V30.1 的教训（最小化 Handy 后桌面空着没人管），本身没错 —— **错在还回去之后
/// 没有任何路径再收回来**：用户按一次 Win+D（或点「显示桌面」、Explorer 重建、Z 序纠正
/// 的瞬间），挂件窗短暂不可见 → 图标归还 → 此后永远是「格子 + 原图标」两份内容，
/// 正是用户截图里那句「源图标还在」。
///
/// 所以这里补上对称的另一半：只要偏好还是「接管」，就周期性确认图标确实被藏住了，
/// 没藏住就重新藏。与 Z 序自检同节奏（[`REASSERT_INTERVAL_SECS`]）、同样带保险丝。
fn reassert_takeover(app: &AppHandle) {
    if !read_takeover(app) {
        // 用户没选接管：清零计数，下次开启接管时从干净状态开始
        TAKEOVER_FIXES.store(0, Ordering::Relaxed);
        return;
    }
    if ICONS_TAKEN.load(Ordering::Relaxed) && !desktop_icons_visible() {
        // 已经藏好了：正常态
        TAKEOVER_FIXES.store(0, Ordering::Relaxed);
        return;
    }
    // 保险丝：连续失败到顶了 → 退避期内不再尝试（避免与第三方桌面工具互相打架）
    let now = unix_secs();
    if TAKEOVER_RETRY_AT.load(Ordering::Relaxed) > now {
        return;
    }
    if takeover_icons(app, true) {
        TAKEOVER_FIXES.store(0, Ordering::Relaxed);
        // 限流写日志：正常态不刷屏，但保留「确实被系统恢复过」这条证据
        if now.saturating_sub(LAST_TAKEOVER_LOG_AT.load(Ordering::Relaxed))
            >= TAKEOVER_LOG_INTERVAL_SECS
        {
            LAST_TAKEOVER_LOG_AT.store(now, Ordering::Relaxed);
            grid_log("桌面图标曾被系统恢复（多为 Win+D / 显示桌面 / Explorer 重建），已重新接管");
        }
        return;
    }
    let fixes = TAKEOVER_FIXES.fetch_add(1, Ordering::Relaxed) + 1;
    if fixes >= TAKEOVER_MAX_FIXES {
        TAKEOVER_RETRY_AT.store(now + TAKEOVER_BACKOFF_SECS, Ordering::Relaxed);
        TAKEOVER_FIXES.store(0, Ordering::Relaxed);
        grid_log("连续多次无法隐藏系统桌面图标（多半被第三方桌面工具接管），暂停自动接管 5 分钟");
    }
}

/// 创建（幂等复用）并显示挂件窗。
///
/// 系统桌面图标的隐藏**不在这里决定**（V38）：由用户的「接管桌面」偏好
/// （[`META_KEY_TAKEOVER`]，一键整理时置位）决定，见 [`apply_takeover_pref`]。
/// V32 曾为了「原桌面 + 多一些格子」的共存形态彻底关掉自动隐藏 —— 那时格子只是
/// 额外一层；V37 起格子变成桌面的**呈现层**（文件不再移动），两份图标并存就成了
/// 用户眼里的「桌面有两个相同的内容」，所以又需要它回来，但必须是**用户可切换的偏好**
/// 而不是每次启动都擅自决定的动作。
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
        apply_takeover_pref(app);
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
    apply_takeover_pref(app);
    grid_log("新建并显示挂件层");
    ensure_poller(app.clone());
    attach
}

/// 按用户的「接管桌面」偏好决定此刻要不要隐藏系统桌面图标（V38）。
///
/// 三条路径都会调它：新建挂件窗、复用已有窗、应用启动恢复格子层 —— 于是
/// 「整理过 → 图标藏起来」这个状态在收起再显示、重启之后都保持一致。
fn apply_takeover_pref(app: &AppHandle) {
    if read_takeover(app) {
        let taken = takeover_icons(app, true);
        if !taken {
            grid_log("接管偏好为开，但本机隐藏桌面图标失败（格子与原图标将同时显示）");
        }
    }
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

// —— V39：接管自检（桌面图标被系统恢复后自动重新隐藏）——

/// 接管自检连续失败次数（到 [`TAKEOVER_MAX_FIXES`] 就退避，防与第三方桌面工具互相打架）。
static TAKEOVER_FIXES: AtomicU32 = AtomicU32::new(0);

/// 接管自检退避截止时刻（unix 秒，0 = 不在退避）。
static TAKEOVER_RETRY_AT: AtomicU64 = AtomicU64::new(0);

/// 上次「重新接管」写日志的时刻（unix 秒）—— 限流用，免得反复 Win+D 把日志刷爆。
static LAST_TAKEOVER_LOG_AT: AtomicU64 = AtomicU64::new(0);

/// 接管自检失败几次后退避（够覆盖「第三方工具抢着管」的持续失败，又不至于一两次抖动就放弃）。
const TAKEOVER_MAX_FIXES: u32 = 5;
/// 接管自检失败后的退避时长（秒）。
const TAKEOVER_BACKOFF_SECS: u64 = 300;
/// 「重新接管」日志的最小间隔（秒）。
const TAKEOVER_LOG_INTERVAL_SECS: u64 = 60;

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
/// 挂件层日志 —— 统一转发到 [`crate::logging`]（`%LOCALAPPDATA%\Handy\handy.log`）。
///
/// V37 之前日志写 `grid-debug.log`，且**只记窗口问题、写操作一行都不留** ——
/// V36 那次「桌面文件被复制成 5 份」因此只能靠事后翻磁盘才查清。现在统一一处，
/// 且每个会碰磁盘的命令都必须留痕（见各 `grid_item_*` / `grid_legacy_*`）。
fn grid_log(message: &str) {
    crate::logging::write_line("grid", message);
}

/// 这个文件名是不是 Handy 自己的收纳容器？
///
/// V36 血案：`桌面/Handy整理` 被当成普通文件夹参与了一次收纳 —— `fs::rename` 想把它
/// 移进自己的子目录，必然失败；随后退化成「递归复制 + 删除源」，在磁盘上炸出
/// **704 层嵌套、5 份共约 195 GB** 的副本。
///
/// 判据用「名字前缀」而不是「路径相等」：V33 写的是 `item.path == storage_key`，
/// 而归一化路径在 Windows 上受短名（`ADMINI~1`）、大小写、`\\?\` 前缀影响，
/// 字符串比较太容易漏 —— 一漏就是上面那种量级的破坏。
fn is_storage_entry(name: &str) -> bool {
    name.starts_with(STORAGE_ROOT_NAME) || name.starts_with(LEGACY_STORAGE_ROOT_NAME)
}

/// 尽力把路径规范化成可比较的形式（绝对路径 + 解析短名 / 大小写 / 软链）。
///
/// 用于「目标是不是落在源目录里面」这类安全判断 —— 目标目录**可能还不存在**
/// （正是要创建它），此时 `canonicalize` 会失败，于是退化成「规范化父目录 + 拼文件名」，
/// 逐级向上直到某个确实存在的祖先。
fn normalize_path(path: &Path) -> PathBuf {
    if let Ok(done) = std::fs::canonicalize(path) {
        return done;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) if !parent.as_os_str().is_empty() => {
            let mut base = normalize_path(parent);
            base.push(name);
            base
        }
        _ => path.to_path_buf(),
    }
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

/// 一键整理的格子排布：**靠右自动流**（详见 [`FlowPlacer`]）。
const ARRANGE_MARGIN: i64 = 32;
/// 相邻两列的**最小**间距（真实列宽随格子尺寸走，见 [`FlowPlacer::next`]）
const ARRANGE_GAP_X: i64 = 24;
/// 同一列内相邻两个格子的纵向间隙
const ARRANGE_GAP_Y: i64 = 24;
/// 格子最小尺寸（与前端 `MIN_BOX_W/H` 一致，布局时不得再小）
const MIN_BOX_W: i64 = 160;
const MIN_BOX_H: i64 = 120;
/// 单列最多放几个格子（防病态数据把一列排到无穷）
const ARRANGE_COLUMN_CAP: i64 = 40;

/// —— 内容驱动尺寸：格子内条目网格的度量（**必须与前端 `GridOverlay.tsx` 严格对齐**）——
///
/// 前端那一处（收纳格条目网格）是：
///   `grid gap-1 p-2` + `gridTemplateColumns: repeat(auto-fill, minmax(iconSize + 36px, 1fr))`，
///   单元格是 `flex flex-col items-center gap-1 p-1.5` + 图标 `iconSize` + 一行 11px 文字。
/// 所以单元格是 `(iconSize + 36) × (iconSize + 30)`（30 = 上下 padding 12 + 间距 4 + 一行文字 14）。
/// **改前端任何一个类名都要回来改这里**，否则算出来的尺寸会与实际渲染错位。
const CELL_EXTRA_W: i64 = 36;
const CELL_EXTRA_H: i64 = 30;
/// 网格 gap-1 / p-2
const GRID_GAP: i64 = 4;
const GRID_PAD: i64 = 8;
/// 格子标题栏 h-8 / 上下边框
const BOX_HEADER_H: i64 = 32;
const BOX_BORDER_H: i64 = 2;
/// 自动尺寸时单行最多几个条目单元格（再宽就不像「格子」而像面板了）
const AUTO_MAX_COLS: i64 = 4;
/// 自动尺寸的宽度上限
const AUTO_MAX_W: i64 = 520;

/// 新建格子 / 兜底排布时的默认尺寸（内容为空时的观感尺寸）。
const ARRANGE_BOX_W: i64 = 320;
const ARRANGE_BOX_H: i64 = 244;

/// 按**条目数量**算一个收纳格该多大（用户 V39 原话：「应该根据每个格子里面内容多少自动调整大小」）。
///
/// 规则：单元格按图标尺寸定死 → 用「尽量接近正方形」的方式挑列数（上限 [`AUTO_MAX_COLS`]）→
/// 行数 = ceil(n / 列数) → 反推外框。空格子给最小尺寸（它要显示「把文件拖到这里」的引导）。
///
/// 高度上限交由调用方给（`max_h`）：一个装了 60 个条目的格子如果照实高到 1200px，
/// 它会顶穿整个桌面；超过上限时**宁可让它内部滚动**（前端条目网格本来就是 `overflow-y-auto`），
/// 也不能让一个格子把桌面占满。
fn auto_box_size(items: usize, icon: i64, max_h: i64) -> (i64, i64) {
    let icon = icon.clamp(16, 256);
    let cell_w = icon + CELL_EXTRA_W;
    let cell_h = icon + CELL_EXTRA_H;
    let n = items.max(1) as i64;
    // 尽量方形：列数 ≈ sqrt(条目数 × 单元格高宽比)
    let cols = (((n as f64) * (cell_h as f64) / (cell_w as f64)).sqrt().ceil() as i64)
        .clamp(1, AUTO_MAX_COLS);
    let rows = (n + cols - 1) / cols;
    let w = cols * cell_w + (cols - 1) * GRID_GAP + 2 * GRID_PAD;
    let h = BOX_HEADER_H + BOX_BORDER_H + rows * cell_h + (rows - 1) * GRID_GAP + 2 * GRID_PAD;
    let max_h = max_h.max(MIN_BOX_H);
    (
        w.clamp(MIN_BOX_W, AUTO_MAX_W),
        h.clamp(MIN_BOX_H, max_h),
    )
}

/// 一个矩形（逻辑像素）—— 排布时的占位 / 禁区。
#[derive(Debug, Clone, Copy)]
struct SlotRect {
    x: i64,
    y: i64,
    w: i64,
    h: i64,
}

impl SlotRect {
    /// 两个矩形是否相交（边缘相接不算相交，允许紧贴）。
    fn intersects(&self, other: &SlotRect) -> bool {
        self.x < other.x + other.w
            && other.x < self.x + self.w
            && self.y < other.y + other.h
            && other.y < self.y + self.h
    }
}

/// **靠右自动流排布器**（V38 抽出、V39 换成首次适配，统一「一键整理」与「新建格子」两处落点）。
///
/// 规则（对应用户那两句「没有计算桌面合理的规划格子位置、流布局结构」、
/// 「格子自动流式布局，防止位置（重叠）」）：
///   1. 从工作区**右边缘**开始，一列之内自上而下摆，装不下再往左推一列；
///   2. 列宽统一（取本批格子里最宽的那个）—— 列若宽窄不一，右侧边缘就会参差，看着还是乱；
///   3. 每个格子用**自己的宽高**算占位，不假定所有格子一样大；
///   4. **首次适配**：每列都从顶部开始找第一个放得下的空洞（V38 用的是「游标只增不减」，
///      一列里被大格子切出来的空隙再也用不上，格子尺寸一不统一就浪费大片空间）；
///   5. `blocked` 里的矩形是禁区 —— 挂件锚点位置 + 已摆下的格子，撞上就往下让开。
///
/// 为什么是「自上而下的一列列」而不是「一行行」：桌面上图标本来就是左侧竖排，
/// 格子贴着右边缘竖向堆叠时视觉上像另一条「图标列」，横向铺开反而会横穿整个桌面。
struct FlowPlacer {
    margin: i64,
    work_w: i64,
    work_h: i64,
    /// 列宽（本批格子里最宽的；决定相邻两列右边界之间的距离）
    col_w: i64,
    /// 最多摆几列（由工作区宽度与列宽推导，不再写死 8）
    max_columns: i64,
    /// 已占用的矩形（禁区 + 已摆下的格子）
    blocked: Vec<SlotRect>,
}

impl FlowPlacer {
    fn new(work_w: i64, work_h: i64, col_w: i64, blocked: Vec<SlotRect>) -> Self {
        // 工作区尺寸拿不到时退回 1280×720，宁可摆得挤一点也不能算出负坐标
        let work_w = if work_w > 0 { work_w } else { 1280 };
        let work_h = if work_h > 0 { work_h } else { 720 };
        let col_w = col_w.clamp(MIN_BOX_W, AUTO_MAX_W);
        let usable = work_w - 2 * ARRANGE_MARGIN + ARRANGE_GAP_X;
        let max_columns = (usable / (col_w + ARRANGE_GAP_X)).clamp(1, ARRANGE_COLUMN_CAP);
        Self {
            margin: ARRANGE_MARGIN,
            work_w,
            work_h,
            col_w,
            max_columns,
            blocked,
        }
    }

    /// 第 `k` 列（0 = 最右）的右边界。
    fn col_right(&self, k: i64) -> i64 {
        self.work_w - self.margin - k * (self.col_w + ARRANGE_GAP_X)
    }

    /// 给一个 `w×h` 的格子找下一个落点。`None` = 桌面已经排不下了。
    fn next(&mut self, w: i64, h: i64) -> Option<(i64, i64)> {
        let h = h.max(MIN_BOX_H);
        for k in 0..self.max_columns {
            let x = self.col_right(k) - w;
            if x < self.margin {
                // 这一列连宽度都不够 → 再往左只会更糟
                break;
            }
            if let Some(y) = self.find_row(x, w, h) {
                self.blocked.push(SlotRect { x, y, w, h });
                return Some((x, y));
            }
        }
        None
    }

    /// 在列内（x 固定）**首次适配**：返回第一个「不与任何已占矩形相交、且不越出下边界」的 y。
    ///
    /// 候选 y 只有两类：顶部 margin，以及每个「横向与我们重叠」的已占矩形的下沿 + 间隙 ——
    /// 最优解必在这两类点上，所以逐个升序试即可，不用按像素扫描。
    fn find_row(&self, x: i64, w: i64, h: i64) -> Option<i64> {
        let mut candidates: Vec<i64> = vec![self.margin];
        for r in &self.blocked {
            if r.x < x + w && x < r.x + r.w {
                candidates.push(r.y + r.h + ARRANGE_GAP_Y);
            }
        }
        candidates.sort_unstable();
        candidates.dedup();
        for y in candidates {
            if y < self.margin {
                continue;
            }
            if y + h > self.work_h - self.margin {
                // 候选是升序的：这个都越界了，后面的更越界
                return None;
            }
            let rect = SlotRect { x, y, w, h };
            if !self.blocked.iter().any(|other| rect.intersects(other)) {
                return Some(y);
            }
        }
        None
    }

    /// 最后手段：桌面真的排不下时，**至少不要留在旧坐标上**（那正是用户看到「乱七八糟」的根因）。
    ///
    /// 做法：放到最左一列，位置取「所有横向相交的已占矩形下沿之下」，忽略下边界 ——
    /// 它可能压在别的格子上，但仍在同一个格子区域里、顺序也还在。调用方会把它计入
    /// `overflowed` 并在界面上如实告诉用户「桌面空间不足」。
    fn place_loose(&mut self, w: i64, h: i64) -> (i64, i64) {
        let k = self.max_columns - 1;
        let x = (self.col_right(k) - w).max(self.margin);
        let mut y = self.margin;
        for r in &self.blocked {
            if r.x < x + w && x < r.x + r.w {
                y = y.max(r.y + r.h + ARRANGE_GAP_Y);
            }
        }
        self.blocked.push(SlotRect { x, y, w, h });
        (x, y)
    }
}

/// 读出全部格子的几何（含挂件），按 `sort, id` 顺序。
///
/// 一并带出 `kind` 与**条目数**：V39 起「按内容量自动定尺寸」和「挂件归位到锚点」
/// 都要在排布阶段用到它们，没必要再为每个格子单独发一条 COUNT 查询。
fn load_box_rects(conn: &Connection) -> Result<Vec<GridBoxRect>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT b.id, b.kind, b.pos_x, b.pos_y, b.width, b.height, \
                    (SELECT COUNT(*) FROM grid_items i WHERE i.box_id = b.id) \
             FROM grid_boxes b ORDER BY b.sort ASC, b.id ASC",
        )
        .map_err(|err| format!("读取格子几何失败：{err}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(GridBoxRect {
                id: row.get(0)?,
                kind: row.get(1)?,
                x: row.get(2)?,
                y: row.get(3)?,
                w: row.get::<_, i64>(4)?.max(MIN_BOX_W),
                h: row.get::<_, i64>(5)?.max(MIN_BOX_H),
                items: row.get::<_, i64>(6)?.max(0) as usize,
            })
        })
        .map_err(|err| format!("读取格子几何失败：{err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("读取格子几何失败：{err}"))?;
    Ok(rows)
}

/// 排布用的格子几何（`kind != "folder"` = 便签 / 日历这类不参与自动排布的挂件）。
struct GridBoxRect {
    id: i64,
    kind: String,
    x: i64,
    y: i64,
    w: i64,
    h: i64,
    /// 已登记条目数（V39：按内容量自动定尺寸）
    items: usize,
}

impl GridBoxRect {
    fn rect(&self) -> SlotRect {
        SlotRect {
            x: self.x,
            y: self.y,
            w: self.w,
            h: self.h,
        }
    }

    /// 挂件（便签 / 日历）：位置由锚点决定，不参与格子流布。
    fn is_widget(&self) -> bool {
        self.kind != "folder"
    }
}

/// 挂件锚点：**声明式**的默认归属角落。
///
/// 用户 V39 原话：「日历默认放在右上角等，当然以后我们可能还会增加更多小挂件都可以固定位置」。
/// 所以这里不做特判散落在各处，而是一张表 —— **新增挂件只要加一行**。
///
/// 约定：`folder` 之外的 kind 都算挂件，位置由本表决定，且**不参与格子流布**（它们本身
/// 在流布局里是禁区，格子会绕开）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)] // 表驱动：TopLeft / BottomRight 预留给后续新挂件（见 [`widget_corner`]）
enum WidgetCorner {
    TopRight,
    TopLeft,
    BottomLeft,
    BottomRight,
}

/// 挂件 kind → 默认角落。表里没有的 kind 一律 `BottomLeft`（左侧竖排，不抢右侧的格子区）。
fn widget_corner(kind: &str) -> WidgetCorner {
    match kind {
        // 日历是桌面上一眼要看的东西，放右上角（用户点名的位置）
        "calendar" => WidgetCorner::TopRight,
        // 便签放左下角：右侧整片留给收纳格，便签也不至于挡住常用的右上角
        "note" => WidgetCorner::BottomLeft,
        _ => WidgetCorner::BottomLeft,
    }
}

/// 把挂件按锚点摆到该角落，返回它最终的矩形（供格子流布当禁区）。
///
/// `taken` 是**同角落已经摆下的挂件**：同类挂件可以有好几个（便签允许添加多个），
/// 不能让它们叠在同一处，所以同角落内按顺序竖排。
fn anchor_widget(
    corner: WidgetCorner,
    taken: &[SlotRect],
    work_w: i64,
    work_h: i64,
    w: i64,
    h: i64,
) -> SlotRect {
    let inner_w = work_w - 2 * ARRANGE_MARGIN;
    let inner_h = work_h - 2 * ARRANGE_MARGIN;
    let w = w.clamp(MIN_BOX_W, inner_w.max(MIN_BOX_W));
    let h = h.clamp(MIN_BOX_H, inner_h.max(MIN_BOX_H));
    // 堆太多时形如 5 个便签会把 y 推成负数（左上角之外，用户以为挂件丢了）——
    // 一律把 y 夹回可视区间：宁可与前一个重叠，也不能跑到屏幕外面去。
    let clamp_y = |y: i64| y.clamp(ARRANGE_MARGIN, (work_h - ARRANGE_MARGIN - h).max(ARRANGE_MARGIN));
    match corner {
        WidgetCorner::TopRight => {
            let x = work_w - ARRANGE_MARGIN - w;
            let y = taken
                .iter()
                .filter(|r| r.x + r.w >= x)
                .map(|r| r.y + r.h + ARRANGE_GAP_Y)
                .fold(ARRANGE_MARGIN, |acc, v| acc.max(v));
            SlotRect {
                x,
                y: clamp_y(y),
                w,
                h,
            }
        }
        WidgetCorner::TopLeft => {
            let x = ARRANGE_MARGIN;
            let y = taken
                .iter()
                .filter(|r| r.x <= x)
                .map(|r| r.y + r.h + ARRANGE_GAP_Y)
                .fold(ARRANGE_MARGIN, |acc, v| acc.max(v));
            SlotRect {
                x,
                y: clamp_y(y),
                w,
                h,
            }
        }
        WidgetCorner::BottomLeft => {
            let x = ARRANGE_MARGIN;
            let y = taken
                .iter()
                .filter(|r| r.x <= x)
                .map(|r| r.y - ARRANGE_GAP_Y - h)
                .fold(work_h - ARRANGE_MARGIN - h, |acc, v| acc.min(v));
            SlotRect {
                x,
                y: clamp_y(y),
                w,
                h,
            }
        }
        WidgetCorner::BottomRight => {
            let x = work_w - ARRANGE_MARGIN - w;
            let y = taken
                .iter()
                .filter(|r| r.x + r.w >= x)
                .map(|r| r.y - ARRANGE_GAP_Y - h)
                .fold(work_h - ARRANGE_MARGIN - h, |acc, v| acc.min(v));
            SlotRect {
                x,
                y: clamp_y(y),
                w,
                h,
            }
        }
    }
}

/// 一次「整理桌面」对布局做了什么（数值回报给前端，用户能看出工具干了什么）。
#[derive(Debug, Clone, Copy, Default)]
struct LayoutOutcome {
    /// 真正被挪动的格子数
    moved: usize,
    /// 按内容量调整过尺寸的格子数
    resized: usize,
    /// 被归位到锚点的挂件数
    anchored: usize,
    /// 桌面空间不足、只能压在别人身上的格子数（正常情况恒为 0）
    overflowed: usize,
}

/// **整理桌面布局**：挂件归位到锚点 → 收纳格按内容量定尺寸 → 靠右首次适配流布。
///
/// 为什么要「全量重排」而不是「只摆新格子」：用户实测（V38）点完整理后抱怨
/// 「格子是自动创建了但是很乱，没有计算桌面合理的规划格子位置」—— 根因是新建的格子
/// 按「已有格子个数」取槽位、而复用的旧格子**保留着自己当年的坐标**，两拨坐标凑在一起
/// 就是一团乱麻。所以整理这一步直接把所有格子重新排一遍。
///
/// V39 又补了三件（用户看着截图说「桌面很乱、格子该按内容量调整大小」）：
///   ① 格子**按条目数**算尺寸（`auto_box_size`）—— 装了 21 个快捷方式的格子和装了 2 个
///      文档的格子不该一样大；
///   ② 挂件**归位到锚点**（日历右上角、便签左下角），当禁区给格子绕；
///   ③ 排不下时**先缩到最小尺寸重试**，实在不行 `place_loose` 也要把它放进格子区 ——
///      V38 会「保持原位」，于是没排上的格子散落在桌面各处，正是用户看到的乱象
///      （日志实证：`重排格子：挪动 4 个……4 个没地方放（保持原位）`）。
fn layout_all_boxes(
    conn: &Connection,
    work_w: i64,
    work_h: i64,
    icon: i64,
) -> Result<LayoutOutcome, String> {
    let rows = load_box_rects(conn)?;
    let mut outcome = LayoutOutcome::default();
    // 单格高度上限：不超过可用高度（超出部分交给格子内部滚动）
    let max_h = (work_h - 2 * ARRANGE_MARGIN).max(MIN_BOX_H);

    // —— ① 收纳格按内容量定尺寸（先定尺寸，才能算出列宽） ——
    let mut sizes: std::collections::HashMap<i64, (i64, i64)> = std::collections::HashMap::new();
    for box_rect in rows.iter().filter(|r| !r.is_widget()) {
        let (w, h) = auto_box_size(box_rect.items, icon, max_h);
        if w != box_rect.w || h != box_rect.h {
            conn.execute(
                "UPDATE grid_boxes SET width = ?1, height = ?2, updated_at = ?3 WHERE id = ?4",
                params![w, h, now_iso(), box_rect.id],
            )
            .map_err(|err| format!("调整格子尺寸失败：{err}"))?;
            outcome.resized += 1;
        }
        sizes.insert(box_rect.id, (w, h));
    }

    // —— ② 挂件归位到锚点，并作为格子流布的禁区 ——
    let mut blocked: Vec<SlotRect> = Vec::new();
    for widget in rows.iter().filter(|r| r.is_widget()) {
        let corner = widget_corner(&widget.kind);
        let rect = anchor_widget(corner, &blocked, work_w, work_h, widget.w, widget.h);
        if rect.x != widget.x || rect.y != widget.y {
            conn.execute(
                "UPDATE grid_boxes SET pos_x = ?1, pos_y = ?2, updated_at = ?3 WHERE id = ?4",
                params![rect.x, rect.y, now_iso(), widget.id],
            )
            .map_err(|err| format!("摆放挂件失败：{err}"))?;
            outcome.anchored += 1;
        }
        blocked.push(rect);
    }

    // —— ③ 收纳格：统一列宽 + 靠右首次适配 ——
    let col_w = rows
        .iter()
        .filter(|r| !r.is_widget())
        .map(|r| sizes.get(&r.id).map(|(w, _)| *w).unwrap_or(r.w))
        .max()
        .unwrap_or(ARRANGE_BOX_W);
    let mut placer = FlowPlacer::new(work_w, work_h, col_w, blocked);
    for box_rect in rows.iter().filter(|r| !r.is_widget()) {
        let (w, h) = sizes
            .get(&box_rect.id)
            .copied()
            .unwrap_or((box_rect.w, box_rect.h));
        let placed = match placer.next(w, h) {
            Some(pos) => pos,
            None => {
                // 缩到最小尺寸再试一次（至少让它落在格子区里，而不是散在桌面上）
                let (x, y) = match placer.next(MIN_BOX_W, MIN_BOX_H) {
                    Some(pos) => {
                        conn.execute(
                            "UPDATE grid_boxes SET width = ?1, height = ?2 WHERE id = ?3",
                            params![MIN_BOX_W, MIN_BOX_H, box_rect.id],
                        )
                        .map_err(|err| format!("压缩格子失败：{err}"))?;
                        outcome.resized += 1;
                        pos
                    }
                    None => {
                        outcome.overflowed += 1;
                        placer.place_loose(w, h)
                    }
                };
                (x, y)
            }
        };
        if placed.0 == box_rect.x && placed.1 == box_rect.y {
            continue;
        }
        conn.execute(
            "UPDATE grid_boxes SET pos_x = ?1, pos_y = ?2, updated_at = ?3 WHERE id = ?4",
            params![placed.0, placed.1, now_iso(), box_rect.id],
        )
        .map_err(|err| format!("排布格子失败：{err}"))?;
        outcome.moved += 1;
    }

    grid_log(&format!(
        "整理布局：工作区 {work_w}×{work_h}，列宽 {col_w}，挪动 {} 个 / 按内容调整 {} 个尺寸 / \
         挂件归位 {} 个 / 空间不足 {} 个",
        outcome.moved, outcome.resized, outcome.anchored, outcome.overflowed
    ));
    Ok(outcome)
}

/// 给一个**即将新建**的格子算落点：不挪动任何已有格子，只找一块空位。
///
/// 全部已有格子（含挂件）都当禁区 —— 新建的格子永远不该叠在别人身上。
fn free_slot_for(conn: &Connection, work_w: i64, work_h: i64, w: i64, h: i64) -> (i64, i64) {
    let blocked: Vec<SlotRect> = load_box_rects(conn)
        .map(|rows| rows.iter().map(GridBoxRect::rect).collect())
        .unwrap_or_default();
    let mut placer = FlowPlacer::new(work_w, work_h, w, blocked);
    placer.next(w, h).unwrap_or_else(|| {
        // 排不下了（桌面已满）：退回右上角，至少保证落在可见区域里
        (ARRANGE_MARGIN, ARRANGE_MARGIN)
    })
}

/// 一键整理结果摘要（前端据此提示「登记了几个条目、建了几个格子、挪了几个格子」）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoArrangeReport {
    /// 桌面根目录扫描到的可见条目数（含快捷方式 / 文件夹）
    pub scanned: usize,
    /// 本次登记进格子的条目数（V37 起**只登记，不移动文件**）
    pub items_added: usize,
    /// 其中文件夹占的数量
    pub folders_moved: usize,
    /// 其中快捷方式（`.lnk`）占的数量
    pub lnk_added: usize,
    /// 本次新建的格子数
    pub boxes_created: usize,
    /// 复用了同名已有格子的次数
    pub boxes_reused: usize,
    /// 按规则跳过的条目数（自己的历史收纳容器 `Handy整理*` / `Handy收纳*`）
    pub skipped: usize,
    /// 本次被重新排布的格子数（V38：整理会**全量重排**，不只摆新格子）
    pub boxes_laid_out: usize,
    /// 按内容量调整过尺寸的格子数（V39）
    pub boxes_resized: usize,
    /// 被归位到锚点的挂件数（V39：日历 → 右上角，便签 → 左下角）
    pub widgets_anchored: usize,
    /// 桌面空间不足、只能压在别人身上的格子数（正常恒为 0；非 0 时前端要如实提示）
    pub boxes_overflowed: usize,
    /// 整理后系统桌面图标是否已由格子层接管（true = 原生图标已隐藏）
    pub icons_hidden: bool,
    /// 单条目失败原因（不中断整批，前端原样展示给用户）
    pub failures: Vec<String>,
}

/// 把扫描结果归入「格子名」：快捷方式 / 文件夹各自单独一组，其余按扩展名类别分组。
///
/// ⚠️ `.lnk` 必须归类（V38 改）：V34 时用户说过「原生快捷方式不需要动态整理」，
/// 那是在**图标仍显示在桌面**的前提下。V38 起整理会隐藏系统桌面图标、由格子代管
/// 桌面呈现 —— 这时若还跳过 `.lnk`，用户桌面上那二十几个程序快捷方式会**当场消失**
/// 且无处可点。归类（只登记、不移动）才是安全的做法。
fn arrange_group_of(item: &crate::commands::organizer::OrganizerItem) -> String {
    if item.is_lnk {
        return "快捷方式".to_string();
    }
    if item.is_dir {
        return "文件夹".to_string();
    }
    if item.category.is_empty() {
        return "其他".to_string();
    }
    item.category.clone()
}

/// 分组展示顺序：文件夹最前，快捷方式其次（桌面上最常用），「其他」最后。
fn arrange_group_rank(name: &str) -> i64 {
    match name {
        "文件夹" => 0,
        "快捷方式" => 1,
        "其他" => 3,
        _ => 2,
    }
}

/// 「系统」格里的虚拟条目：Explorer **恒定显示**、磁盘上没有对应文件的桌面入口。
///
/// 为什么 V38 又把它们请回来：V34 删掉「系统」格的依据是「此电脑 / 回收站本来就一直
/// 显示在桌面上，格子里那份纯属重复」。而现在整理会**隐藏原生桌面图标**，那三个入口
/// 若没人接管就彻底点不到了 —— 前提变了，结论就得跟着变。
///
/// 路径是 shell 命名空间 CLSID，`grid_open_path` 用 `ShellExecuteW` 直接打开；
/// `list_live_items` 对 `::` 开头显式豁免存在性校验（否则会被当成失效登记清掉）。
const SYSTEM_ENTRIES: [(&str, &str); 3] = [
    ("::{20D04FE0-3AEA-1069-A2D8-08002B30309D}", "此电脑"),
    ("::{645FF040-5081-101B-9F08-00AA002F954E}", "回收站"),
    ("::{59031A47-3F72-44A7-89C5-5595FE6B30EE}", "用户的文件"),
];

/// 确保存在「系统」格并补齐三个系统入口（幂等）。
fn ensure_system_box(conn: &Connection) -> Result<i64, String> {
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM grid_boxes WHERE name = ?1 AND kind = 'system' ORDER BY id LIMIT 1",
            params!["系统"],
            |row| row.get(0),
        )
        .ok();
    let box_id = match existing {
        Some(id) => id,
        None => {
            let now = now_iso();
            let sort = next_sort(conn, "SELECT COALESCE(MAX(sort) + 1, 0) FROM grid_boxes", None)?;
            conn.execute(
                "INSERT INTO grid_boxes \
                 (name, kind, category, pos_x, pos_y, width, height, sort, created_at, updated_at) \
                 VALUES ('系统', 'system', '', ?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                params![
                    ARRANGE_MARGIN,
                    ARRANGE_MARGIN,
                    ARRANGE_BOX_W,
                    MIN_BOX_H + 80,
                    sort,
                    now,
                ],
            )
            .map_err(|err| format!("创建「系统」格失败：{err}"))?;
            conn.last_insert_rowid()
        }
    };
    // 三个入口都是虚拟路径，register_item 会照常做「已存在 / 用户说过不要 / 已归属」
    // 三重检查，所以这里重复调用是幂等的
    for (path, name) in SYSTEM_ENTRIES {
        let _ = register_item(conn, box_id, Path::new(path), name);
    }
    Ok(box_id)
}

/// 一键归类核心（连接与桌面目录由调用方给定）。
///
/// V37 起重写为**只登记、不移动**：
///   - 用户否掉了 V33–V36 的「真实收纳」——「是桌面整理不是让你把桌面上的东西都给我
///     移动到一个目录下面去」。现在扫到的条目只是在格子里**登记一条引用**，
///     文件本体一个字节都不动；
///   - **文件夹照样归类**（只跳过自己的历史收纳容器）：用户实测「文件夹的整理根本都不生效」，
///     根因是早期这里把 `is_dir` 整个跳过 —— 「文件夹」格因此永远是空的；
///   - **快捷方式也归类**（V38）：整理后原生图标会被格子层接管，跳过 `.lnk` 会让
///     用户桌面上的程序快捷方式当场消失；
///   - **自己的收纳容器永不参与**：见 [`is_storage_entry`]（V36 那次 296 GB 事故）；
///   - **全量重排**（V38）：所有收纳格重新按靠右流布局摆放，见 [`layout_all_boxes`]。
///
/// `work_width` / `work_height` 是工作区（挂件窗）的逻辑尺寸；<= 0 时各自退回
/// 1280 / 720。
fn auto_arrange_inner(
    conn: &Connection,
    desktop: &Path,
    work_width: i64,
    work_height: i64,
) -> Result<AutoArrangeReport, String> {
    use std::collections::HashMap;

    let scanned = crate::commands::organizer::scan_items(desktop)?;
    let total_scanned = scanned.len();

    // 已有格子：名称 → id（新格子按类别名复用同名格子）
    let mut existing: HashMap<String, i64> = HashMap::new();
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
            existing.insert(name, id);
        }
    }

    // 按类别分组（文件夹 / 快捷方式各自一组，其余按扩展名类别）
    let mut grouped: Vec<(String, Vec<usize>)> = Vec::new();
    let mut skipped = 0usize;
    for (index, item) in scanned.iter().enumerate() {
        // 自己的收纳容器永不参与（V36 事故根源）：它一旦被当成普通文件夹归类，
        // 又有任何一次移动兜底逻辑走偏，就会自我复制成 296 GB
        if is_storage_entry(&item.name) {
            skipped += 1;
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
        lnk_added: 0,
        boxes_created: 0,
        boxes_reused: 0,
        skipped,
        boxes_laid_out: 0,
        boxes_resized: 0,
        widgets_anchored: 0,
        boxes_overflowed: 0,
        icons_hidden: false,
        failures: Vec::new(),
    };

    for (label, indices) in grouped {
        if indices.is_empty() {
            continue;
        }
        let box_id: i64 = match existing.get(&label) {
            Some(id) => {
                report.boxes_reused += 1;
                *id
            }
            None => {
                let now = now_iso();
                // 落点先给个临时值 —— 循环结束后统一全量重排（layout_all_boxes），
                // 这样「新建的」和「复用的」格子会被同一套流布局摆整齐，
                // 而不是新格子按槽位、旧格子留在当年的老坐标上各说各话。
                let sort = next_sort(
                    conn,
                    "SELECT COALESCE(MAX(sort) + 1, 0) FROM grid_boxes",
                    None,
                )?;
                conn.execute(
                    "INSERT INTO grid_boxes \
                     (name, kind, category, pos_x, pos_y, width, height, sort, created_at, updated_at) \
                     VALUES (?1, 'folder', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        label,
                        label,
                        ARRANGE_MARGIN,
                        ARRANGE_MARGIN,
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
                report.boxes_created += 1;
                id
            }
        };

        for index in indices {
            let Some(item) = scanned.get(index) else {
                continue;
            };
            // 只登记引用 —— 文件留在桌面原处，一个字节都不动
            match register_item(conn, box_id, Path::new(&item.path), &item.name) {
                Ok(true) => {
                    report.items_added += 1;
                    if item.is_dir {
                        report.folders_moved += 1;
                    }
                    if item.is_lnk {
                        report.lnk_added += 1;
                    }
                }
                Ok(false) => {}
                Err(err) => report.failures.push(format!("{}：{err}", item.name)),
            }
        }
    }

    // 系统入口格（此电脑 / 回收站 / 用户文件夹）：整理后原生图标由格子接管，
    // 这几个 Explorer 恒定显示的入口必须由格子补回来，否则用户就点不到它们了。
    if report.items_added > 0 {
        ensure_system_box(conn)?;
    }

    // 全量重排（含复用与新建设立的格子）：挂件归位 → 按内容量定尺寸 → 靠右首次适配流布
    let outcome = layout_all_boxes(conn, work_width, work_height, layout_icon_size())?;
    report.boxes_laid_out = outcome.moved;
    report.boxes_resized = outcome.resized;
    report.widgets_anchored = outcome.anchored;
    report.boxes_overflowed = outcome.overflowed;

    grid_log(&format!(
        "一键整理：扫到 {} 项，登记 {} 项（文件全部原地未动，含快捷方式 {}、文件夹 {}），\
         跳过 {} 个历史收纳容器，格子新建 {} / 复用 {} / 重排 {} / 按内容调尺寸 {} / \
         挂件归位 {} / 空间不足 {}，失败 {}",
        report.scanned,
        report.items_added,
        report.lnk_added,
        report.folders_moved,
        report.skipped,
        report.boxes_created,
        report.boxes_reused,
        report.boxes_laid_out,
        report.boxes_resized,
        report.widgets_anchored,
        report.boxes_overflowed,
        report.failures.len()
    ));
    Ok(report)
}

/// 排布用的桌面图标尺寸（逻辑像素）。
///
/// 单独包一层是为了**让纯逻辑的单测可以在任何平台跑**：`desktop_icon_size_cached()`
/// 只在 Windows 上有实现（要读注册表），非 Windows 给一个默认值即可 ——
/// 尺寸算法本身与平台无关，不该因为平台门锁而没法测。
#[cfg(target_os = "windows")]
fn layout_icon_size() -> i64 {
    desktop_icon_size_cached()
}

#[cfg(not(target_os = "windows"))]
fn layout_icon_size() -> i64 {
    32
}

/// 布局可用的逻辑尺寸 `(宽, 高)`。
///
/// 优先用挂件窗自身的尺寸 —— 格子的 `pos_x/pos_y` 本来就是**相对挂件窗客户区**的，
/// 拿显示器尺寸去算会在「窗口没铺满屏幕」时把格子推到窗口外面。
/// 窗口还没建时退回主显示器工作区；都拿不到给 1280×720。
///
/// V38 补上高度：排布改成「一列自上而下摆满再往左推一列」之后，**没有高度就算不出
/// 一列能放几个**，格子在纵向会越排越出去（用户实测截图里就是一路排到桌面底部之外）。
fn layout_work_size(app: &AppHandle) -> (i64, i64) {
    if let Some(win) = app.get_webview_window(GRID_LABEL) {
        if let (Ok(size), Ok(scale)) = (win.inner_size(), win.scale_factor()) {
            if scale > 0.0 && size.width > 0 && size.height > 0 {
                return (
                    (f64::from(size.width) / scale).round() as i64,
                    (f64::from(size.height) / scale).round() as i64,
                );
            }
        }
    }
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale = monitor.scale_factor();
        if scale > 0.0 {
            let area = monitor.work_area();
            return (
                (f64::from(area.size.width) / scale).round() as i64,
                (f64::from(area.size.height) / scale).round() as i64,
            );
        }
    }
    (1280, 720)
}

/// 一键整理桌面 —— 「桌面整理」模块的主入口（工具栏的整理按钮也走这里）。
///
/// 一次点击做完五件事（用户原话：「我点击整理应该是自动整理规划桌面」）：
///   ① 扫桌面 → 按类型（文件夹 / 快捷方式 / 图片 / 文档 / 压缩包 / 安装包 / 其他）分组；
///   ② **只登记引用**：文件一个字节都不动（V37 呈现层模型）；
///   ③ 每个类别一个格子，同名格子复用；
///   ④ **全量重排**所有格子（靠右流布局，避开便签 / 日历挂件）；
///   ⑤ 补上「系统」格（此电脑 / 回收站 / 用户文件夹）并**隐藏系统桌面图标** ——
///      桌面呈现此后完全由格子层负责，同一份内容不会再显示两遍。
///      这一步的偏好记在 `grid_meta.desktop_takeover`，收起挂件 / 退出应用都会
///      立刻把图标还给系统；工具栏的「原生桌面图标」开关可随时切回共存模式。
///
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
    let (work_w, work_h) = layout_work_size(&app);
    let mut report = auto_arrange_inner(&conn, &desktop, work_w, work_h)?;

    // 只有真的往里登记了东西才接管桌面 —— 空跑一次（桌面已干净）不该顺手把用户图标藏了
    if report.items_added > 0 {
        if let Err(err) = write_takeover(&app, true) {
            grid_log(&format!("保存桌面接管偏好失败：{err}"));
        }
        report.icons_hidden = takeover_icons(&app, true);
        if !report.icons_hidden {
            grid_log("接管桌面失败（未找到系统桌面图标视图），格子与原生图标将同时显示");
        }
    }
    Ok(report)
}

/// 对账全部收纳格：按磁盘目录补齐新出现的文件、清掉已消失的登记。
///
/// 返回 `(参与对账的收纳格数, 补登记数, 清理数)`。
fn reconcile_all_boxes(conn: &Connection) -> Result<(usize, usize, usize), String> {
    let boxes: Vec<i64> = {
        let mut stmt = conn
            .prepare("SELECT id FROM grid_boxes ORDER BY sort ASC, id ASC")
            .map_err(|err| format!("读取格子失败：{err}"))?;
        let mapped = stmt
            .query_map([], |row| row.get::<_, i64>(0))
            .map_err(|err| format!("读取格子失败：{err}"))?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("读取格子失败：{err}"))?
    };

    let mut counted = 0usize;
    let mut pruned = 0usize;
    for box_id in boxes {
        counted += 1;
        let before: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM grid_items WHERE box_id = ?1",
                params![box_id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        let live = list_live_items(conn, box_id)?.len();
        pruned += (before.max(0) as usize).saturating_sub(live);
    }
    Ok((counted, 0, pruned))
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

    // ⓪ shell 命名空间（`::{CLSID}`，如「此电脑 / 回收站 / 用户的文件」）：
    //    `SHGetFileInfoW` 把它当**文件路径**解析，必然失败 —— 必须先
    //    `SHParseDisplayName` 拿到 PIDL，再带 `SHGFI_PIDL` 求图标。
    //    V38 新增「系统」格时才发现这条分支缺失（此前格子只装真实文件路径）。
    if path.starts_with("::") {
        return virtual_shell_icon(&wide);
    }

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
        // 用户把桌面图标调大过（Ctrl+滚轮）时 48 那档会被拉糊 —— 那就先取 256 那档。
        // 只在确有必要时才要 JUMBO：256×256 RGBA 转 base64 约 350 KB，一个格子
        // 二十个图标就是 7 MB，白白拖慢首屏（用户 V37 反馈「图标应该跟桌面一样大」）。
        if desktop_icon_size_cached() > 64 {
            if let Some(icon) = image_list_icon(sfi.iIcon, SHIL_JUMBO) {
                return Some(icon);
            }
        }
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

/// shell 命名空间条目（`::{CLSID}`）的图标：字符串 → PIDL → 系统图像列表。
///
/// 失败一律 `None`（前端回退线条图标）—— 取不到图标不该阻断格子显示。
#[cfg(target_os = "windows")]
fn virtual_shell_icon(wide: &[u16]) -> Option<windows::Win32::UI::WindowsAndMessaging::HICON> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows::Win32::UI::Shell::{
        SHGetFileInfoW, SHParseDisplayName, SHFILEINFOW, SHGFI_PIDL, SHGFI_SYSICONINDEX,
    };

    // SAFETY: 入参是 NUL 结尾的宽字符串；SHParseDisplayName 分配的 PIDL 归调用方，
    // 用完 `CoTaskMemFree` 释放（Windows 规定的配对方式）。
    unsafe {
        let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
        if SHParseDisplayName(PCWSTR(wide.as_ptr()), None, &mut pidl, 0, None).is_err()
            || pidl.is_null()
        {
            return None;
        }
        let mut sfi = SHFILEINFOW::default();
        let ok = SHGetFileInfoW(
            PCWSTR(pidl as *const u16),
            FILE_ATTRIBUTE_NORMAL,
            Some(&mut sfi as *mut SHFILEINFOW as *mut _),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_SYSICONINDEX | SHGFI_PIDL,
        );
        CoTaskMemFree(Some(pidl as *const std::ffi::c_void));
        if ok == 0 {
            return None;
        }
        if desktop_icon_size_cached() > 64 {
            if let Some(icon) = image_list_icon(sfi.iIcon, SHIL_JUMBO) {
                return Some(icon);
            }
        }
        image_list_icon(sfi.iIcon, SHIL_EXTRALARGE)
    }
}

/// `SHIL_EXTRALARGE`：系统图像列表里 48×48 的那一档（`SHGetImageList` 的索引值）。
#[cfg(target_os = "windows")]
const SHIL_EXTRALARGE: i32 = 2;

/// `SHIL_JUMBO`：系统图像列表里 256×256 的那一档（Vista 起可用）。
///
/// 只有当系统桌面图标尺寸被调大到 > 64px 时才值得取它 —— 否则纯属浪费带宽
/// （见 [`shell_icon_handle`] 的说明）。
#[cfg(target_os = "windows")]
const SHIL_JUMBO: i32 = 4;

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
    let conn = connect(&app)?;
    let (boxes, added, pruned) = reconcile_all_boxes(&conn)?;
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
// —— V37：遗留收纳目录的还原与清理 ——
//
// V33–V36 的「真实收纳」把用户的桌面文件搬进了 `桌面/Handy整理/<容器>/`；V36 那次
// 事故还在桌面上留下 4 个副本（合计约 195 GB、最深 704 层 / 4961 字符路径）。
// 收纳模型既然已经改回「引用」，这些残留就必须能安全地撤回桌面 —— 而且**先给用户看清
// 将要发生什么**（`dry_run`），再动手。

/// 一个遗留收纳根目录的概况（还原前的预览用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyRootInfo {
    /// 目录名（`Handy整理` / `Handy整理 (2)` …）
    pub name: String,
    /// 绝对路径
    pub path: String,
    /// 将被上提回桌面的条目数（第一层容器的直接子项）
    pub entries: usize,
    /// 目录内条目总数（含嵌套垃圾，用于展示规模）
    pub total_entries: usize,
    /// 其中「自己套自己」的嵌套垃圾条目数
    pub nested_entries: usize,
    /// 占用字节数
    pub bytes: u64,
    /// 是否因条目上限被截断（真 ⇒ `total_entries` / `nested_entries` / `bytes` 都是**下界**）
    pub truncated: bool,
}

/// 还原报告。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReclaimReport {
    /// 上提回桌面的条目数
    pub moved: usize,
    /// 因桌面已有同名而跳过的条目数
    pub skipped: usize,
    /// 失败的条目（名称 + 原因）
    pub failures: Vec<String>,
    /// 处理过的遗留目录数
    pub roots: usize,
    /// 是否只是预演（true = 没动任何文件）
    pub dry_run: bool,
}

/// 清理报告。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupReport {
    /// 已删除（或预演将删除）的遗留目录数
    pub removed: usize,
    /// 释放（或预计释放）的字节数
    pub freed_bytes: u64,
    /// 因「还有条目没撤回桌面」而放弃删除的目录
    pub skipped: Vec<String>,
    /// 删除失败的目录
    pub failures: Vec<String>,
    /// 是否只是预演
    pub dry_run: bool,
}

/// 列出桌面上的遗留收纳目录（**只读**，不碰任何文件）。
#[tauri::command]
pub async fn grid_legacy_scan() -> Result<Vec<LegacyRootInfo>, String> {
    let desktop = desktop_root()?;
    Ok(scan_legacy_roots(&desktop))
}

/// 扫描桌面上的 `Handy整理*` / `Handy收纳*` 目录并统计。
fn scan_legacy_roots(desktop: &Path) -> Vec<LegacyRootInfo> {
    let Ok(entries) = std::fs::read_dir(desktop) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_storage_entry(&name) {
            continue;
        }
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let (total_entries, nested_entries, bytes, truncated) = walk_stats(&path);
        out.push(LegacyRootInfo {
            name,
            path: path.to_string_lossy().to_string(),
            entries: collect_reclaimable(&path).len(),
            total_entries,
            nested_entries,
            bytes,
            truncated,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// 收集某个遗留根里「该上提回桌面」的条目：`<容器>/<条目>` → 条目。
///
/// 容器本身是 Handy 建的（「文档」「图片」「新格子 3」…），用户的原始条目在它下面一层。
/// 容器内若出现同名收纳容器，那是 V36 递归复制炸出来的垃圾，**不算条目**（交给清理）。
fn collect_reclaimable(root: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    let Ok(containers) = std::fs::read_dir(root) else {
        return out;
    };
    let mut sorted: Vec<std::fs::DirEntry> = containers.flatten().collect();
    sorted.sort_by_key(|entry| entry.file_name());
    for container in sorted {
        let Ok(file_type) = container.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let Ok(kids) = std::fs::read_dir(container.path()) else {
            continue;
        };
        for kid in kids.flatten() {
            let name = kid.file_name().to_string_lossy().to_string();
            if is_storage_entry(&name) {
                continue; // 嵌套垃圾，不参与上提
            }
            out.push((name, kid.path()));
        }
    }
    out
}

/// 单棵树最多统计多少条目 —— 事故现场实测 **129,714 条 / 296 GB**，全量走一遍要一到两分钟。
///
/// 而 `grid_legacy_scan` 是**打开格子管理页就自动跑**的（用户不会先点按钮再等），
/// 一旦全量遍历，页面看起来就是「卡死」。所以必须封顶：超了就把 `truncated` 置真，
/// 界面显示「≥ N」——用户要的结论是「确实还有巨量残留、该清理了」，不是精确到个位。
const MAX_WALK_ENTRIES: usize = 10_000;

/// 统计一棵树的 `(条目总数, 嵌套垃圾数, 字节数, 是否被上限截断)`。
///
/// 显式栈遍历，1001 层也不会爆栈（实测最深 1001 层 / 路径 7082 字符 —— 递归写法在这里必炸）。
fn walk_stats(root: &Path) -> (usize, usize, u64, bool) {
    let mut total = 0usize;
    let mut nested = 0usize;
    let mut bytes = 0u64;
    let mut truncated = false;
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    'outer: while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if total >= MAX_WALK_ENTRIES {
                truncated = true;
                break 'outer;
            }
            total += 1;
            let name = entry.file_name().to_string_lossy().to_string();
            if is_storage_entry(&name) {
                nested += 1;
            }
            match entry.file_type() {
                Ok(file_type) if file_type.is_dir() => stack.push(entry.path()),
                Ok(_) => bytes += entry.metadata().map(|meta| meta.len()).unwrap_or(0),
                Err(_) => {}
            }
        }
    }
    (total, nested, bytes, truncated)
}

/// 把遗留收纳目录里的条目**上提回桌面根**（文件只移动，**绝不删除**）。
///
/// 规则：`Handy整理/<容器>/<条目>` → `桌面/<条目>`。
///
/// - **桌面已有同名就跳过**：4 个副本的内容已验证是主目录的子集，跳过可避免把同一个
///   文件搬回来两遍（也就不必让用户去清理一堆 `xxx (2)`）；
/// - `dry_run = true`（默认）只统计不落盘，UI 先给用户看数字再执行；
/// - 嵌套垃圾不参与上提，留给 [`grid_legacy_cleanup`] 整体删除。
#[tauri::command]
pub async fn grid_legacy_reclaim(dry_run: Option<bool>) -> Result<ReclaimReport, String> {
    let dry = dry_run.unwrap_or(true);
    let desktop = desktop_root()?;
    let roots = scan_legacy_roots(&desktop);
    let mut report = ReclaimReport {
        moved: 0,
        skipped: 0,
        failures: Vec::new(),
        roots: roots.len(),
        dry_run: dry,
    };
    for info in &roots {
        let root = PathBuf::from(&info.path);
        for (name, path) in collect_reclaimable(&root) {
            if desktop.join(&name).exists() {
                report.skipped += 1;
                continue;
            }
            if dry {
                report.moved += 1;
                continue;
            }
            match move_with_conflict_rename(&path, &desktop) {
                Ok(_) => report.moved += 1,
                Err(err) => report.failures.push(format!("{name}：{err}")),
            }
        }
    }
    if !dry {
        grid_log(&format!(
            "还原遗留收纳：上提 {} 项回桌面，跳过 {} 项（桌面已有同名），失败 {} 项",
            report.moved,
            report.skipped,
            report.failures.len()
        ));
    }
    Ok(report)
}

/// 删除遗留收纳目录（含最深 704 层的嵌套垃圾）。
///
/// ⚠️ 这是**真的删目录**，所以有两道闸：
///   ① `dry_run` 默认 true，UI 必须先给用户看「删几个、释放多少」；
///   ② 每个目录删除前检查：只要里面还有「桌面上找不到同名」的条目，就**跳过不删**并
///      报出来 —— 宁可少删，也绝不允许把用户还没撤回的文件清掉。
#[tauri::command]
pub async fn grid_legacy_cleanup(dry_run: Option<bool>) -> Result<CleanupReport, String> {
    let dry = dry_run.unwrap_or(true);
    let desktop = desktop_root()?;
    let roots = scan_legacy_roots(&desktop);
    let mut report = CleanupReport {
        removed: 0,
        freed_bytes: 0,
        skipped: Vec::new(),
        failures: Vec::new(),
        dry_run: dry,
    };
    for info in &roots {
        let root = PathBuf::from(&info.path);
        let leftovers: Vec<String> = collect_reclaimable(&root)
            .into_iter()
            .filter(|(name, _)| !desktop.join(name).exists())
            .map(|(name, _)| name)
            .collect();
        if !leftovers.is_empty() {
            report.skipped.push(format!(
                "{}：还有 {} 个条目没撤回桌面（{}），已跳过",
                info.name,
                leftovers.len(),
                leftovers.join("、")
            ));
            continue;
        }
        if dry {
            report.removed += 1;
            report.freed_bytes += info.bytes;
            continue;
        }
        match remove_tree_deep(&root) {
            Ok(()) => {
                report.removed += 1;
                report.freed_bytes += info.bytes;
            }
            Err(err) => report.failures.push(format!("{}：{err}", info.name)),
        }
    }
    if !dry {
        grid_log(&format!(
            "清理遗留收纳目录：删除 {} 个，释放约 {} 字节，跳过 {} 个，失败 {} 个",
            report.removed,
            report.freed_bytes,
            report.skipped.len(),
            report.failures.len()
        ));
    }
    Ok(report)
}

/// 删除一棵可能极深的目录树（事故造出过 **1001 层 / 7082 字符**的路径）。
///
/// 显式栈 + 后序删除：不递归（不会爆栈），每层都交给 `std::fs` 处理 —— Rust 在 Windows
/// 上会为路径补 `\\?\` 前缀，因此超过 `MAX_PATH` 也能删。
fn remove_tree_deep(root: &Path) -> Result<(), String> {
    let mut pending: Vec<PathBuf> = vec![root.to_path_buf()];
    let mut dirs: Vec<PathBuf> = Vec::new();
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            // 读不动就交给后面的 remove_dir 报准确错误
            dirs.push(dir);
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            match entry.file_type() {
                Ok(file_type) if file_type.is_dir() => pending.push(path),
                _ => std::fs::remove_file(&path)
                    .map_err(|err| format!("删除文件失败（{}）：{err}", path.display()))?,
            }
        }
        dirs.push(dir);
    }
    // 后序：`dirs` 里父在子之前，倒着删才是「先子后父」
    for dir in dirs.into_iter().rev() {
        std::fs::remove_dir(&dir)
            .map_err(|err| format!("删除目录失败（{}）：{err}", dir.display()))?;
    }
    Ok(())
}

// —— V37：桌面图标度量（让格子内图标与系统桌面同样大小） ——

/// 桌面图标的度量。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IconMetrics {
    /// 图标边长（逻辑像素）
    pub icon_size: i64,
    /// 图标横向间距（逻辑像素；0 = 没读到，前端按比例推）
    pub spacing: i64,
    /// 值从哪来：`registry` / `control-panel` / `default`（排查用）
    pub source: String,
}

/// 读系统桌面的图标尺寸，让格子内图标与原生桌面视觉一致。
///
/// 用户 V37 反馈「格子里面的图标大小应该跟正常桌面大小保持一致」。桌面图标尺寸存在
/// `HKCU\Software\Microsoft\Windows\Shell\Bags\1\Desktop` 的 `IconSize`（用户按
/// `Ctrl + 滚轮` 调桌面图标大小时 Windows 就改写它）。取不到再退到控制面板的
/// `Shell Icon Size`（默认 32），仍然取不到用 48。
///
/// 用 `reg query` 而不是注册表 API：只读一次，不必为此新增 windows crate feature。
#[tauri::command]
pub async fn desktop_icon_metrics() -> Result<IconMetrics, String> {
    use std::sync::atomic::Ordering;

    // 冷启动时记一次：这个数字决定格子图标渲染多大，是「图标怎么跟我桌面不一样大」
    // 这类反馈的**第一现场**。用户回传 handy.log 时能直接看到探测结果与来源。
    let cold = DESKTOP_ICON_SIZE.load(Ordering::Relaxed) == 0;
    let metrics = detect_icon_metrics();
    if cold {
        grid_log(&format!(
            "桌面图标尺寸探测：{}px（间距 {}，来源 {}）—— 格子图标与提取分辨率按此对齐",
            metrics.icon_size, metrics.spacing, metrics.source
        ));
    }
    Ok(metrics)
}

/// 探测实现（与命令分开，方便日志复用与将来加单测）。
fn detect_icon_metrics() -> IconMetrics {
    #[cfg(target_os = "windows")]
    {
        if let Some(size) = read_desktop_icon_size() {
            let spacing = reg_query_value(
                r"HKCU\Software\Microsoft\Windows\Shell\Bags\1\Desktop",
                "IconSpacing",
            )
            .and_then(|raw| parse_reg_int(&raw))
            .filter(|value| (16..=1024).contains(value))
            .unwrap_or(0);
            return IconMetrics {
                icon_size: size,
                spacing,
                source: "registry".to_string(),
            };
        }
    }
    IconMetrics {
        icon_size: 48,
        spacing: 0,
        source: "default".to_string(),
    }
}

/// 读桌面图标边长（同步读注册表；可能拉起一次 `reg` 子进程，调用方自行缓存）。
///
/// 只看两个位置：① 桌面 Bags 的 `IconSize`（用户按 `Ctrl + 滚轮` 改的就是它）；
/// ② 控制面板的 `Shell Icon Size`（老式通用设置）。都取不到返回 `None`。
#[cfg(target_os = "windows")]
fn read_desktop_icon_size() -> Option<i64> {
    if let Some(size) = reg_query_value(
        r"HKCU\Software\Microsoft\Windows\Shell\Bags\1\Desktop",
        "IconSize",
    )
    .and_then(|raw| parse_reg_int(&raw))
    {
        if (16..=512).contains(&size) {
            return Some(size);
        }
    }
    let fallback = reg_query_value(
        r"HKCU\Control Panel\Desktop\WindowMetrics",
        "Shell Icon Size",
    )
    .and_then(|raw| parse_reg_int(&raw))?;
    (16..=512).contains(&fallback).then_some(fallback)
}

/// 图标尺寸缓存（0 = 还没读过）。图标提取是逐条热路径，不能每次都拉起 `reg` 子进程。
#[cfg(target_os = "windows")]
static DESKTOP_ICON_SIZE: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);

/// 带缓存的桌面图标尺寸（读不到按 48）。
#[cfg(target_os = "windows")]
fn desktop_icon_size_cached() -> i64 {
    use std::sync::atomic::Ordering;
    let cached = DESKTOP_ICON_SIZE.load(Ordering::Relaxed);
    if cached != 0 {
        return cached;
    }
    let size = read_desktop_icon_size().unwrap_or(48);
    DESKTOP_ICON_SIZE.store(size, Ordering::Relaxed);
    size
}

/// 读一个注册表值的原始文本（`reg query <key> /v <name>` 输出的最后一列）。
#[cfg(target_os = "windows")]
fn reg_query_value(key: &str, name: &str) -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = std::process::Command::new("reg")
        .args(["query", key, "/v", name])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with(name) {
            continue;
        }
        // `    IconSize    REG_DWORD    0x30` → 取最后一段（值名本身可能含空格）
        return trimmed.split_whitespace().last().map(str::to_string);
    }
    None
}

/// `0x30` / `48` 都能解析。
#[cfg(target_os = "windows")]
fn parse_reg_int(raw: &str) -> Option<i64> {
    let trimmed = raw.trim();
    match trimmed.strip_prefix("0x").or_else(|| trimmed.strip_prefix("0X")) {
        Some(hex) => i64::from_str_radix(hex, 16).ok(),
        None => trimmed.parse::<i64>().ok(),
    }
}

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

/// 排布规则（`FlowPlacer` / 内容驱动尺寸 / 挂件锚点）。
///
/// 用户 V38 原话：「点击整理桌面后格子是自动创建了 但是很乱，没有计算桌面合理的
/// 规划格子位置 流布局结构」；V39 又说：「应该根据每个格子里面内容多少自动调整大小，
/// 格子自动流式布局，防止位置，日历默认放在右上角」。
///
/// 这些断言把「整齐」钉成**可复算**的东西 —— 否则下次改任何一个排布参数，
/// 「很乱」都会悄悄回来。
///
/// 刻意**不依赖 Windows API**（只用到纯几何与尺寸函数），所以在任何平台上都能跑。
#[cfg(test)]
mod flow_placer_tests {
    use super::{
        anchor_widget, auto_box_size, widget_corner, FlowPlacer, SlotRect, WidgetCorner,
        ARRANGE_GAP_X, ARRANGE_GAP_Y, ARRANGE_MARGIN, AUTO_MAX_W, BOX_BORDER_H, BOX_HEADER_H,
        CELL_EXTRA_H, CELL_EXTRA_W, GRID_GAP, GRID_PAD, MIN_BOX_H, MIN_BOX_W,
    };

    fn overlap(a: &SlotRect, b: &SlotRect) -> bool {
        a.intersects(b)
    }

    /// 排布测试统一用「1920×1080 工作区 + 320 列宽 + 图标 32px」这套现实参数。
    const WORK_W: i64 = 1920;
    const WORK_H: i64 = 1080;
    const COL_W: i64 = 320;
    /// 单格高度上限 —— 与 [`layout_all_boxes`] 传给 `auto_box_size` 的完全是同一个量，
    /// 测试若自己另写一个数，就会出现「函数按调用方给的上限夹、测试按另一个数断言」的假失败。
    const MAX_H: i64 = WORK_H - 2 * ARRANGE_MARGIN;

    fn placer(blocked: Vec<SlotRect>) -> FlowPlacer {
        FlowPlacer::new(WORK_W, WORK_H, COL_W, blocked)
    }

    // —————————————— 靠右流布局 ——————————————

    #[test]
    fn first_box_lands_in_the_top_right_corner() {
        let mut p = placer(Vec::new());
        let (x, y) = p.next(COL_W, 244).expect("首块必有位置");
        assert_eq!(y, ARRANGE_MARGIN, "首扎根在顶部");
        assert_eq!(
            x,
            WORK_W - ARRANGE_MARGIN - COL_W,
            "右边缘对齐（贴右边但不是贴死屏幕边缘）"
        );
    }

    #[test]
    fn stacks_down_before_flowing_left() {
        let mut p = placer(Vec::new());
        let first = p.next(COL_W, 244).unwrap();
        let second = p.next(COL_W, 244).unwrap();
        // 同一列：x 不动，y 往下退一格
        assert_eq!(second.0, first.0);
        assert_eq!(second.1, first.1 + 244 + ARRANGE_GAP_Y);

        // 一路摆到列尾，下一个必须换到左边一列，且回到顶部
        let mut saw_left_column = false;
        for _ in 0..16 {
            match p.next(COL_W, 244) {
                Some((x, y)) => {
                    if x < second.0 {
                        assert_eq!(y, ARRANGE_MARGIN, "换列后要回到顶部，而不是接着往下排");
                        saw_left_column = true;
                        break;
                    }
                }
                None => break,
            }
        }
        assert!(saw_left_column, "本列排满后必须往左推一列");
    }

    #[test]
    fn columns_are_derived_from_the_work_area_width_not_hardcoded() {
        // 窄桌面（900 宽）只放得下 2 列等宽列；列位置必须落在这个网格上，而不是硬编码的 8 列
        let first_col = 900 - ARRANGE_MARGIN - COL_W;
        let second_col = first_col - (COL_W + ARRANGE_GAP_X);
        let mut narrow = FlowPlacer::new(900, 600, COL_W, Vec::new());
        let mut count = 0;
        while let Some((x, _)) = narrow.next(COL_W, MIN_BOX_H) {
            assert!(
                x == first_col || x == second_col,
                "列位置必须落在等宽列网格上（{x} 既不是 {first_col} 也不是 {second_col}）"
            );
            count += 1;
            if count > 20 {
                panic!("窄桌面不该摆下这么多格子（列数推导错了？）");
            }
        }
        assert!(count > 1, "窄桌面至少还能竖着摞几个");
    }

    #[test]
    fn respects_widget_no_go_zones() {
        // 便签 / 日历是用户自己摆的，新排的格子不许压上去。
        // 禁区刻意挡住「右上角」这个首选项位置 —— 否则排布一开始走的就是 top-right，
        // 根本不会经过「让开」那条分支，这条测试就成了摆设。
        let widget = SlotRect {
            x: 1500,
            y: ARRANGE_MARGIN,
            w: 300,
            h: 200,
        };
        let mut p = placer(vec![widget]);
        let (x, y) = p.next(COL_W, 244).expect("禁区之外还有地方");
        let placed = SlotRect {
            x,
            y,
            w: COL_W,
            h: 244,
        };
        assert!(!overlap(&placed, &widget), "挂件位置必须让开");
        assert!(
            y >= widget.y + widget.h,
            "撞上禁区应该是往下让开，而不是横向漂移或叠上去"
        );
    }

    #[test]
    fn reuses_holes_instead_of_only_moving_down() {
        // V38 排布器的游标**只增不减**：一列里被大格子 / 挂件切出来的空隙再也用不上。
        // 格子尺寸一按内容量变得参差，这个缺陷立刻变成大片浪费 + 后面的格子排不下。
        let widget = SlotRect {
            x: 1568,
            y: 500,
            w: COL_W,
            h: 200,
        };
        let mut p = placer(vec![widget]);
        let a = p.next(COL_W, 244).expect("第一个格子");
        assert_eq!(a.1, ARRANGE_MARGIN);
        // 第二个（同样高）撞上挂件 → 让到挂件下面
        let b = p.next(COL_W, 244).expect("第二个格子");
        assert!(b.1 >= widget.y + widget.h, "撞上挂件要往下让开");

        // 第三个是矮格子：它应该回头塞进 a 与挂件之间那道空隙，而不是跟着 b 继续往下
        let c = p.next(COL_W, MIN_BOX_H).expect("矮格子");
        assert_eq!(
            c.1,
            a.1 + 244 + ARRANGE_GAP_Y,
            "留出来的空洞必须能被后面的小格子复用"
        );
        assert!(c.1 < b.1, "复用空洞的位置必然在 b 之上");
    }

    #[test]
    fn never_runs_off_the_bottom_nor_off_the_left() {
        let mut p = FlowPlacer::new(900, 500, COL_W, Vec::new());
        let mut placed = Vec::new();
        while let Some((x, y)) = p.next(COL_W, 244) {
            assert!(y + 244 <= 500 - ARRANGE_MARGIN, "不许排到桌面之外");
            assert!(x >= ARRANGE_MARGIN, "不许排到左边界之外");
            placed.push(SlotRect {
                x,
                y,
                w: COL_W,
                h: 244,
            });
        }
        assert!(!placed.is_empty(), "900×500 至少要摆得下一个格子");
    }

    #[test]
    fn reports_exhaustion_instead_of_piling_up() {
        // 极窄桌面：连一列都放不下 → 明确放弃，而不是返回负坐标或互相叠压
        let mut p = FlowPlacer::new(200, 400, COL_W, Vec::new());
        assert_eq!(p.next(COL_W, 244), None);
    }

    #[test]
    fn a_full_pass_never_overlaps() {
        // 尺寸参差（自动尺寸的真实形态）也要保证两两不重叠
        let sizes = [244i64, 120, 442, 178, 300, 120, 244, 442, 178, 244, 120, 300];
        let mut p = placer(Vec::new());
        let mut placed = Vec::new();
        for h in sizes {
            match p.next(COL_W, h) {
                Some((x, y)) => placed.push(SlotRect {
                    x,
                    y,
                    w: COL_W,
                    h,
                }),
                None => break,
            }
        }
        assert!(placed.len() >= 8, "1920×1080 至少要摆得下 8 个格子");
        for i in 0..placed.len() {
            for j in (i + 1)..placed.len() {
                assert!(
                    !overlap(&placed[i], &placed[j]),
                    "第 {i} 与第 {j} 个格子重叠了：{:?} vs {:?}",
                    placed[i],
                    placed[j]
                );
            }
        }
    }

    #[test]
    fn honours_each_boxs_own_size_and_a_minimum() {
        // 尺寸不统一才是常态（用户把某个格子拉宽 / 拉高过），不能按固定步进假定
        let mut p = placer(Vec::new());
        let (x, y) = p.next(8, 8).expect("极小尺寸也要有位置");
        // 高度被夹到 MIN_BOX_H；宽度由调用方保证（整理时会先按内容量定好尺寸）
        assert_eq!(x, WORK_W - ARRANGE_MARGIN - 8);
        assert_eq!(y, ARRANGE_MARGIN);
        let second = p.next(COL_W, 244).unwrap();
        assert_eq!(second.1, ARRANGE_MARGIN + MIN_BOX_H + ARRANGE_GAP_Y);
    }

    #[test]
    fn place_loose_never_leaves_a_box_outside_the_layout_band() {
        // 最后的兜底（桌面真的排不下）：宁可压在别人身上，也不能留在旧坐标散落桌面
        let mut p = FlowPlacer::new(900, 500, COL_W, Vec::new());
        while p.next(COL_W, 244).is_some() {}
        let (x, y) = p.place_loose(COL_W, 244);
        assert!(x >= ARRANGE_MARGIN && x <= WORK_W, "兜底也不能排到左边界之外");
        assert!(y >= ARRANGE_MARGIN);
    }

    // —————————————— 内容驱动尺寸 ——————————————

    /// 前端单元格度量：`(iconSize + 36) × (iconSize + 30)`（见 `CELL_EXTRA_W/H` 的说明）。
    fn cell(icon: i64) -> (i64, i64) {
        (icon + CELL_EXTRA_W, icon + CELL_EXTRA_H)
    }

    #[test]
    fn box_size_follows_item_count() {
        let icon = 32;
        let (cell_w, cell_h) = cell(icon);

        // 空格子：给最小尺寸（它要显示「把文件拖到这里」的引导）
        assert_eq!(auto_box_size(0, icon, MAX_H), (MIN_BOX_W, MIN_BOX_H));

        // 4 个条目：2 列 × 2 行（宽度低于最小尺寸时被夹到 MIN_BOX_W）
        let (w4, h4) = auto_box_size(4, icon, MAX_H);
        assert_eq!(
            w4,
            (2 * cell_w + GRID_GAP + 2 * GRID_PAD).max(MIN_BOX_W),
            "2 列的宽度"
        );
        assert_eq!(h4, BOX_HEADER_H + BOX_BORDER_H + 2 * cell_h + GRID_GAP + 2 * GRID_PAD);

        // 条目越多，格子越大（单调）—— 这正是用户那句「按内容多少自动调整大小」
        let (w21, h21) = auto_box_size(21, icon, MAX_H);
        assert!(h21 > h4, "21 个条目的格子必须比 4 个的高");
        assert!(w21 >= w4, "列数不会更少");

        // 列数有上限，不会排成一条长带
        let (w100, h100) = auto_box_size(100, icon, MAX_H);
        assert!(w100 <= AUTO_MAX_W, "宽度必须有上限");
        assert!(h100 <= MAX_H, "高度不得超过可用高度（超出交给格子内滚动）");
    }

    #[test]
    fn bigger_desktop_icons_make_bigger_boxes() {
        // V37 起格子图标跟着系统桌面图标尺寸走；尺寸算法必须同步跟着变，
        // 否则用户把桌面图标调大之后，格子里就会挤成一团。
        let (w32, h32) = auto_box_size(6, 32, MAX_H);
        let (w48, h48) = auto_box_size(6, 48, MAX_H);
        assert!(w48 >= w32 && h48 > h32);
    }

    #[test]
    fn size_is_clamped_into_the_legal_range() {
        for items in [0usize, 1, 7, 40, 500] {
            for icon in [16i64, 32, 48, 96, 256] {
                let (w, h) = auto_box_size(items, icon, MAX_H);
                assert!(w >= MIN_BOX_W && w <= AUTO_MAX_W, "{items}/{icon} 宽度越界：{w}");
                assert!(
                    h >= MIN_BOX_H && h <= MAX_H,
                    "{items}/{icon} 高度越界：{h}"
                );
            }
        }
        // 可用高度很小时也不能算出小于最小高度的格子
        let (_, h) = auto_box_size(30, 32, 100);
        assert_eq!(h, MIN_BOX_H);
    }

    // —————————————— 挂件锚点 ——————————————

    #[test]
    fn calendar_defaults_to_the_top_right_corner() {
        // 用户点名的位置：「日历默认放在右上角等」
        assert_eq!(widget_corner("calendar"), WidgetCorner::TopRight);
        let rect = anchor_widget(WidgetCorner::TopRight, &[], WORK_W, WORK_H, 360, 430);
        assert_eq!(rect.x + rect.w, WORK_W - ARRANGE_MARGIN, "贴右边界");
        assert_eq!(rect.y, ARRANGE_MARGIN, "贴顶");
    }

    #[test]
    fn note_defaults_to_the_bottom_left_corner() {
        assert_eq!(widget_corner("note"), WidgetCorner::BottomLeft);
        let rect = anchor_widget(WidgetCorner::BottomLeft, &[], WORK_W, WORK_H, 260, 220);
        assert_eq!(rect.x, ARRANGE_MARGIN, "贴左边界");
        assert_eq!(rect.y + rect.h, WORK_H - ARRANGE_MARGIN, "贴下边界");
    }

    #[test]
    fn same_corner_widgets_stack_without_overlapping() {
        // 便签允许添加多个（V35）：同角落的多个挂件必须竖排，不能叠在一起
        let first = anchor_widget(WidgetCorner::BottomLeft, &[], WORK_W, WORK_H, 260, 220);
        let second = anchor_widget(WidgetCorner::BottomLeft, &[first], WORK_W, WORK_H, 260, 220);
        assert!(!overlap(&first, &second), "同类挂件不得重叠");
        assert!(second.y < first.y, "后加的往上摞");

        let cal1 = anchor_widget(WidgetCorner::TopRight, &[], WORK_W, WORK_H, 360, 430);
        let cal2 = anchor_widget(WidgetCorner::TopRight, &[cal1], WORK_W, WORK_H, 360, 430);
        assert!(!overlap(&cal1, &cal2) && cal2.y > cal1.y, "右上角挂件往下摞");
    }

    #[test]
    fn unknown_widget_kinds_still_get_a_fixed_corner() {
        // 「以后我们可能还会增加更多小挂件都可以固定位置」——
        // 没登记过的 kind 也必须落在确定的角落，不能留在旧坐标上乱飘。
        let corner = widget_corner("weather");
        let rect = anchor_widget(corner, &[], WORK_W, WORK_H, 200, 160);
        assert!(rect.x >= ARRANGE_MARGIN && rect.y >= ARRANGE_MARGIN);
        assert!(rect.x + rect.w <= WORK_W - ARRANGE_MARGIN);
        assert!(rect.y + rect.h <= WORK_H - ARRANGE_MARGIN);
    }

    #[test]
    fn too_many_widgets_in_one_corner_never_leave_the_screen() {
        // 同角落堆到装不下时，y 会被推成负数（挂件跑到屏幕外，用户以为「挂件丢了」）。
        // 宁可重叠也必须留在可视区里。
        let mut taken: Vec<SlotRect> = Vec::new();
        for _ in 0..8 {
            let rect = anchor_widget(WidgetCorner::BottomLeft, &taken, WORK_W, WORK_H, 260, 300);
            assert!(
                rect.y >= ARRANGE_MARGIN && rect.y + rect.h <= WORK_H - ARRANGE_MARGIN,
                "第 {} 个便签被摆到了可视区之外：{rect:?}",
                taken.len() + 1
            );
            taken.push(rect);
        }
    }
}
