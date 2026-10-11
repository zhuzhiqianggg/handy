//! B 方案运行时：**不接管原生桌面**，只「遥控」图标位置。
//!
//! 配套文档：`docs/04-review/PLAN-B-PHASED.md`（Step 2 / Step 4）。
//!
//! # 它做什么（Step 4 起：**唯一模式**，没有开关）
//!
//! ① 启动期 [`ensure_native_layout`]：快照图标位置 → 备份并清掉「自动排列 / 对齐网格」
//!    → 记下 Explorer 的图标间距；② 每次重排后 [`desktop_icon_layout_apply`] 把登记条目
//! 按格子网格摆到原生图标上；③ 用户随时可 [`desktop_icon_layout_restore`] 一键还原。
//!
//! # 曾经是「默认关」的可开关能力（V101 时）
//!
//! Step 2 把它做成开关，是为了先在真实桌面上验证再切默认 —— 因为它会**写用户桌面图标的
//! 位置**（`LVM_SETITEMPOSITION`）与**注册表偏好**（`Bags\1\Desktop` 的 `FFlags`）。
//! 用户 10-10 真机验收通过后，Step 4 把开关去掉：接管路线整体退场，B 方案不再有
//! 「关掉」这个状态（关掉 = 格子空框，见方案文档 §3 Step 4 的说明）。
//!
//! # 几何（B 模式）
//!
//! 图标单元格尺寸取 **Explorer 自己的间距**（`LVM_GETITEMSPACING`，本机实测 76×88），
//! 这样图标之间不会互相压。为了和布局引擎对齐，传给引擎的「图标基准」是
//! `spacing_y - BOX_CELL_EXTRA_H`：引擎内部 `cell_h = icon + BOX_CELL_EXTRA_H` 恰好
//! 等于 `spacing_y`，`cell_w = icon + CELL_EXTRA_W` 略宽于 `spacing_x`（只多不挤）。
//!
//! 位置计算与前端找同一份 [`crate::commands::grid::b_content_frame`]，保证
//! 「底板画到哪」与「图标摆到哪」永远一致。

use std::collections::HashMap;

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::AppHandle;

use crate::db;
use crate::platform::desktop_icons as di;

/// `grid_meta` 键：启用前 `FFlags` 的原值（十进制字符串）。
pub(crate) const META_FFLAGS_BACKUP: &str = "fflags_backup";
/// `grid_meta` 键：启用前的图标位置快照（JSON，`[[x,y], …]` 按下标）。
pub(crate) const META_POS_BACKUP: &str = "icon_pos_backup";
/// `grid_meta` 键：本次测量到的图标纵向间距（布局引擎按它定格子高）。
pub(crate) const META_SPACING_Y: &str = "icon_spacing_y";

fn connect(app: &AppHandle) -> Result<Connection, String> {
    let path = db::db_path(app)?;
    db::open(&path)
}

fn meta_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM grid_meta WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO grid_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|err| format!("写入配置失败：{err}"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn listview() -> Result<windows::Win32::Foundation::HWND, String> {
    crate::commands::grid::desktop_icon_view()
        .ok_or_else(|| "找不到桌面图标视图（Explorer 未运行 / 已被第三方桌面工具接管）".to_string())
}

/// 状态快照（前端「设置中心 → 桌面整理」直接显示，便于自证）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IconControlStatus {
    /// B 模式是否生效。**Step 4 起恒为 true** —— 保留字段只为不改前端类型；
    /// 语义已从「用户开没开」变成「遥控链路是否可用」。
    pub enabled: bool,
    /// 桌面图标视图是否已关掉「自动排列」（遥控的**前提**）
    pub autoarrange_off: bool,
    /// 当前 `FFlags`（十进制，便于和备份对照）
    pub fflags: Option<u32>,
    /// 启用前备份的 `FFlags`
    pub fflags_backup: Option<u32>,
    /// 桌面图标总数
    pub icon_count: usize,
    /// 本轮成功摆位的图标数
    pub placed: usize,
    /// 本轮未能匹配到桌面图标的登记条目数（名字对不上）
    pub unmatched: usize,
    /// Explorer 的图标间距 `(宽, 高)`
    pub spacing: (i32, i32),
    /// 位置快照条数（> 0 表示「还原到接管前」可用）
    pub snapshot: usize,
}

#[cfg(target_os = "windows")]
fn snapshot_len(conn: &Connection) -> usize {
    meta_get(conn, META_POS_BACKUP)
        .and_then(|raw| serde_json::from_str::<Vec<(i32, i32)>>(&raw).ok())
        .map(|v| v.len())
        .unwrap_or(0)
}

#[cfg(not(target_os = "windows"))]
fn snapshot_len(_conn: &Connection) -> usize {
    0
}

/// 汇总一份状态（找不到桌面图标视图时也返回，只是各计数为 0）。
fn status_of(conn: &Connection, placed: usize, unmatched: usize) -> IconControlStatus {
    #[cfg(target_os = "windows")]
    let (count, spacing, autoarrange_off, fflags) = match listview() {
        Ok(list) => (
            di::item_count(list),
            di::icon_spacing(list),
            !di::autoarrange_on(list),
            di::read_folder_flags(),
        ),
        Err(_) => (0, (76, 88), false, di::read_folder_flags()),
    };
    #[cfg(not(target_os = "windows"))]
    let (count, spacing, autoarrange_off, fflags) = (0usize, (76, 88), false, None);

    IconControlStatus {
        enabled: true,
        autoarrange_off,
        fflags,
        fflags_backup: meta_get(conn, META_FFLAGS_BACKUP).and_then(|v| v.parse::<u32>().ok()),
        icon_count: count,
        placed,
        unmatched,
        spacing,
        snapshot: snapshot_len(conn),
    }
}

/// 读状态（不改任何东西）。
#[tauri::command]
pub async fn desktop_icon_control_get(app: AppHandle) -> Result<IconControlStatus, String> {
    let conn = connect(&app)?;
    Ok(status_of(&conn, 0, 0))
}

/// 摆位：把每个格子里的登记条目按「Explorer 间距网格」铺进格子内容区。
///
/// 返回 `(成功摆位数, 未匹配数)`。
#[cfg(target_os = "windows")]
fn apply_layout(conn: &Connection, app: &AppHandle) -> Result<(usize, usize), String> {
    let list = listview()?;
    let spacing = di::icon_spacing(list);
    let arg = crate::commands::grid::b_icon_arg_for_spacing(spacing.1);
    let names = di::item_names(list)?;

    // 显示名 → 下标。桌面上显示名就是文件名（带不带扩展名取决于用户偏好），
    // 所以两种形式都登记；同名冲突时保留先出现的那个。
    let mut index_of: HashMap<String, usize> = HashMap::with_capacity(names.len());
    for (idx, name) in names.iter().enumerate() {
        let key = name.trim().to_lowercase();
        index_of.entry(key.clone()).or_insert(idx);
        if let Some((stem, _)) = key.rsplit_once('.') {
            index_of.entry(stem.to_string()).or_insert(idx);
        }
    }

    // 工作区原点（物理像素）—— 格子坐标是相对工作区的。
    let (work_x, work_y) = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let p = m.work_area().position;
            (p.x, p.y)
        })
        .unwrap_or((0, 0));

    // 桌面列表框客户区原点（屏幕坐标）—— 图标坐标是相对它的。
    let (client_x, client_y) = crate::commands::grid::window_client_origin(list);

    let boxes: Vec<(i64, i64, i64, i64, i64)> = {
        let mut stmt = conn
            .prepare(
                "SELECT id, pos_x, pos_y, width, height FROM grid_boxes
                 WHERE kind NOT IN ('note', 'calendar')
                 ORDER BY sort ASC, id ASC",
            )
            .map_err(|err| format!("读取格子失败：{err}"))?;
        let mapped = stmt
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })
            .map_err(|err| format!("读取格子失败：{err}"))?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("读取格子失败：{err}"))?
    };

    let mut placements: Vec<(usize, i32, i32)> = Vec::new();
    let mut unmatched = 0usize;

    for (box_id, bx, by, bw, bh) in boxes {
        let items: Vec<(String, String)> = {
            let mut stmt = conn
                .prepare(
                    "SELECT file_path, display_name FROM grid_items
                     WHERE box_id = ?1 ORDER BY sort ASC, id ASC",
                )
                .map_err(|err| format!("读取条目失败：{err}"))?;
            let mapped = stmt
                .query_map(params![box_id], |row| Ok((row.get(0)?, row.get(1)?)))
                .map_err(|err| format!("读取条目失败：{err}"))?;
            mapped
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| format!("读取条目失败：{err}"))?
        };
        if items.is_empty() {
            continue;
        }
        let frame = crate::commands::grid::b_content_frame(bw, bh, arg, spacing.1);

        for (i, (_path, display)) in items.iter().enumerate() {
            let key = display.trim().to_lowercase();
            let found = index_of.get(&key).copied().or_else(|| {
                key.rsplit_once('.')
                    .and_then(|(stem, _)| index_of.get(stem).copied())
            });
            let Some(index) = found else {
                unmatched += 1;
                continue;
            };
            let col = (i as i64) % frame.cols;
            let row = (i as i64) / frame.cols;
            let screen_x =
                i64::from(work_x) + bx + frame.origin_dx + col * frame.cell_w;
            let screen_y =
                i64::from(work_y) + by + frame.origin_dy + row * frame.cell_h;
            placements.push((
                index,
                (screen_x - i64::from(client_x)) as i32,
                (screen_y - i64::from(client_y)) as i32,
            ));
        }
    }

    let placed = di::set_positions(list, &placements);
    Ok((placed, unmatched))
}

#[cfg(not(target_os = "windows"))]
fn apply_layout(_conn: &Connection, _app: &AppHandle) -> Result<(usize, usize), String> {
    Err("桌面图标遥控仅支持 Windows".to_string())
}

/// **启动期幂等装配**（Step 4：取代原来的「开启 B 模式」开关）。
///
/// 做四件事，每一件都**只在第一次**做（快照 / 备份不能反复覆盖，否则「还原到进入前」
/// 这个承诺就没了）：
///
/// ① 快照全部图标位置（`icon_pos_backup`）—— 用户点「还原图标布局」的凭据；
/// ② 备份 `FFlags`（`fflags_backup`）—— 退出 / 关闭整理时还原「自动排列 / 对齐网格」用；
/// ③ 关掉「自动排列」（先动当前视图 = 立刻生效，再写注册表 = Explorer 重启后仍生效）；
/// ④ 记下 Explorer 的图标纵向间距 —— 布局引擎据此把格子高对齐到原生图标网格。
///
/// 找不到桌面图标视图（Explorer 没跑 / 被第三方桌面工具接管）时**不算失败**：静默返回，
/// 下次重排或下次启动会再试。`apply_layout` 本身也会重测间距，两条路互为兜底。
///
/// 幂等：反复调用只是重复读几行、写同样的值。
pub fn ensure_native_layout(app: &AppHandle) {
    let Ok(conn) = connect(app) else {
        return;
    };
    #[cfg(target_os = "windows")]
    {
        let Ok(list) = listview() else {
            return;
        };
        // ① 位置快照（只存一次；反复覆盖会把「原始布局」弄丢）
        if meta_get(&conn, META_POS_BACKUP).is_none() {
            match di::positions(list) {
                Ok(pos) => {
                    let raw = serde_json::to_string(&pos).unwrap_or_else(|_| "[]".to_string());
                    let _ = meta_set(&conn, META_POS_BACKUP, &raw);
                }
                Err(err) => crate::logging::write_line(
                    "grid",
                    &format!("图标位置快照失败（不影响摆位，只是「还原」暂不可用）：{err}"),
                ),
            }
        }
        // ② FFlags 备份（同样只存一次）
        if meta_get(&conn, META_FFLAGS_BACKUP).is_none() {
            if let Some(flags) = di::read_folder_flags() {
                let _ = meta_set(&conn, META_FFLAGS_BACKUP, &flags.to_string());
            }
        }
        // ③ 关「自动排列 / 对齐网格」：**先动当前视图**（立刻生效），再写注册表
        //    （Explorer 重启后仍生效）。两条路都必须走 —— 只写注册表要等 Explorer 重启，
        //    只动视图则重启就打回原形。
        di::set_autoarrange(list, false);
        if let Some(flags) = di::read_folder_flags() {
            let cleared = di::flags_cleared(flags);
            if cleared != flags {
                if let Err(err) = di::write_folder_flags(cleared) {
                    crate::logging::write_line(
                        "grid",
                        &format!("写桌面 FFlags 失败（本次只在当前视图关了自动排列）：{err}"),
                    );
                }
            }
        }
        // ④ 记下间距（布局引擎据此定格子高）
        let spacing = di::icon_spacing(list);
        let _ = meta_set(&conn, META_SPACING_Y, &spacing.1.to_string());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = &conn;
    }
    // 保险：万一历史版本把图标藏了（接管态残留），这里立刻还给系统 ——
    // B 方案下图标必须由 Explorer 画，否则「遥控」没有对象。
    crate::commands::grid::restore_desktop_icons(app);

    // ⑤ 启动即摆位：自动排列已经关掉，图标停在关掉那一刻的密集网格位置 ——
    //    不在这里摆一次，格子底板和图标就一直是两张皮，直到用户碰巧触发一次重排
    //    （2026-10-11「整理失效」事故的另一半根因）。
    apply_after_relayout(app);
}

/// 重新摆位（改了格子 / 条目之后调）。返回本轮摆位计数。
#[tauri::command]
pub async fn desktop_icon_layout_apply(app: AppHandle) -> Result<IconControlStatus, String> {
    let conn = connect(&app)?;
    let (placed, unmatched) = apply_layout(&conn, &app)?;
    Ok(status_of(&conn, placed, unmatched))
}

/// **Rust 端摆位入口**：任何「格子几何变了」的 Rust 命令（一键整理 / 重排 / 重置）
/// 在改完 DB 之后调它，把原生图标按新格子重摆一次。
///
/// # 为什么必须有这条（2026-10-11「整理失效」事故）
///
/// V102 里摆位只有一条路：前端 `relayoutSoon` → `gridRelayout` →
/// `.then(() => ipc.desktopIconLayoutApply())`。于是**启动装配关掉自动排列之后**
/// 图标停在关掉那一刻的密集网格位置（没人摆它们），用户点「一键整理」格子底板重排了、
/// 图标却原地不动 —— 表现就是「整理失效」。
///
/// 教训：**「底板画到哪」与「图标摆到哪」必须由同一段逻辑保证**，不能指望前端记得
/// 再发一条 IPC（前端不发 = 图标不摆 = 没有任何报错）。前端那条 `.then()` 保留作
/// 双保险，但真正的保证在这里。
///
/// 失败打日志（`grid` 通道）不 panic —— 摆不上图标格子底板还在，下一轮重排会再试。
pub fn apply_after_relayout(app: &AppHandle) {
    let Ok(conn) = connect(app) else {
        return;
    };
    match apply_layout(&conn, app) {
        Ok((placed, unmatched)) => {
            if placed > 0 || unmatched > 0 {
                crate::logging::write_line(
                    "grid",
                    &format!(
                        "图标摆位：成功 {placed} 个 / 未匹配 {unmatched} 个（未匹配 = 格子里的条目在桌面图标视图里找不到同名项）"
                    ),
                );
            }
        }
        Err(err) => crate::logging::write_line("grid", &format!("图标摆位失败：{err}")),
    }
}

/// **一键把桌面还给系统**：还原图标位置 **+** 还原「自动排列 / 对齐网格」偏好。
///
/// # 为什么两件事必须一起做（决策 2 / 3 的合流点）
///
/// 方案里决策 2 定的是「退出不还原位置」、决策 3 定的是「还原偏好原值」。**两者在
/// 「退出」这一点上互相打架**：单独把「自动排列」恢复成开，Explorer 下一次刷新（F5 /
/// 新建文件 / 重启）就会立刻按它自己的网格把图标**重新打散** —— 于是「保留位置」这个
/// 承诺自动作废，还不如主动还回去。
///
/// 所以实现取**合流**：位置与偏好绑定，**要么都保持、要么都还原**，还原入口只有一个
/// —— 这里。App 退出时两者都不动（同 Fences / 腾讯桌面整理：整理生效期间桌面归 Handy，
/// 重启 Handy 继续生效）。
#[tauri::command]
pub async fn desktop_icon_layout_restore(app: AppHandle) -> Result<IconControlStatus, String> {
    let conn = connect(&app)?;
    #[cfg(target_os = "windows")]
    {
        let raw = meta_get(&conn, META_POS_BACKUP)
            .ok_or_else(|| "没有可还原的快照（本机还没进入过桌面整理）".to_string())?;
        let saved: Vec<(i32, i32)> =
            serde_json::from_str(&raw).map_err(|err| format!("快照损坏：{err}"))?;
        let list = listview()?;
        let placements: Vec<(usize, i32, i32)> = saved
            .iter()
            .enumerate()
            .map(|(idx, (x, y))| (idx, *x, *y))
            .collect();
        let placed = di::set_positions(list, &placements);
        // 偏好一起还：先恢复视图里的 `LVS_AUTOARRANGE` 位，再写回备份的 `FFlags`
        // （只做前者，Explorer 一重启就打回原形；只做后者，当前这张桌面要等刷新才变）。
        if let Some(flags) = meta_get(&conn, META_FFLAGS_BACKUP).and_then(|v| v.parse::<u32>().ok())
        {
            di::set_autoarrange(list, di::flags_autoarrange_on(flags));
            let _ = di::write_folder_flags(flags);
        }
        crate::logging::write_line(
            "grid",
            &format!("用户点「还原桌面图标布局」：已还原 {placed} 个图标的位置与自动排列偏好"),
        );
        return Ok(status_of(&conn, placed, 0));
    }
    #[cfg(not(target_os = "windows"))]
    Err("桌面图标遥控仅支持 Windows".to_string())
}
