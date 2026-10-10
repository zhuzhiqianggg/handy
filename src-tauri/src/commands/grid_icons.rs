//! B 方案运行时：**不接管原生桌面**，只「遥控」图标位置。
//!
//! 配套文档：`docs/04-review/PLAN-B-PHASED.md`（Step 2）。
//!
//! # 它做什么
//!
//! | 开关 | 行为 |
//! | --- | --- |
//! | 关（默认） | **一切照旧** —— V101 的接管模型，一个像素都不动 |
//! | 开 | ① 快照图标位置 ② 备份并清掉「自动排列 / 对齐网格」 ③ 把图标摆进各格子的网格 |
//!
//! # 为什么必须「默认关」
//!
//! 这一步会**写用户桌面图标的位置**（`LVM_SETITEMPOSITION`）与**注册表偏好**
//! （`Bags\1\Desktop` 的 `FFlags`）。旧模型随时可退回，所以先把新模型做成一个
//! **可开关**的能力，由用户在真实桌面上验证后再切换默认值 —— 而不是直接替换。
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

/// `grid_meta` 键：B 模式开关（`"1"` / `"0"`）。
pub(crate) const META_ICON_CONTROL: &str = "icon_control";
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

fn meta_clear(conn: &Connection, key: &str) {
    let _ = conn.execute("DELETE FROM grid_meta WHERE key = ?1", params![key]);
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
    /// B 模式是否开启
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
        enabled: meta_get(conn, META_ICON_CONTROL).as_deref() == Some("1"),
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

/// 开启 / 关闭 B 模式。
///
/// 开启：快照图标位置 → 备份 `FFlags` → 关「自动排列」→ 落盘间距 → 立即摆一次。
/// 关闭：还原 `FFlags` → 恢复 `LVS_AUTOARRANGE` → 清掉开关与间距。
#[tauri::command]
pub async fn desktop_icon_control_set(
    app: AppHandle,
    enabled: bool,
) -> Result<IconControlStatus, String> {
    let conn = connect(&app)?;
    #[cfg(target_os = "windows")]
    {
        let list = listview()?;
        if enabled {
            // ① 快照（只在第一次开时存，避免反复开关把「原始布局」覆盖掉）
            if meta_get(&conn, META_POS_BACKUP).is_none() {
                match di::positions(list) {
                    Ok(pos) => {
                        let raw = serde_json::to_string(&pos).unwrap_or_else(|_| "[]".to_string());
                        meta_set(&conn, META_POS_BACKUP, &raw)?;
                    }
                    Err(err) => {
                        crate::logging::write_line(
                                "grid",
                                &format!("图标位置快照失败（不阻断启用）：{err}"),
                            );
                    }
                }
            }
            // ② 备份并清 FFlags（只清自动排列 / 对齐网格两位）
            if meta_get(&conn, META_FFLAGS_BACKUP).is_none() {
                if let Some(flags) = di::read_folder_flags() {
                    meta_set(&conn, META_FFLAGS_BACKUP, &flags.to_string())?;
                }
            }
            // ③ 关「自动排列」：**先动当前视图**（立刻生效），再写注册表（Explorer 重启后仍生效）
            di::set_autoarrange(list, false);
            if let Some(flags) = di::read_folder_flags() {
                let cleared = di::flags_cleared(flags);
                if cleared != flags {
                    if let Err(err) = di::write_folder_flags(cleared) {
                        crate::logging::write_line(
                                "grid",
                                &format!("写桌面 FFlags 失败（本次只在内存里关了自动排列）：{err}"),
                            );
                    }
                }
            }
            // ④ 记下间距（布局引擎据此定格子高）与开关
            let spacing = di::icon_spacing(list);
            meta_set(&conn, META_SPACING_Y, &spacing.1.to_string())?;
            meta_set(&conn, META_ICON_CONTROL, "1")?;
            crate::commands::grid::set_icon_control_runtime(true);
            // 保险：万一上一版把图标藏了（接管态），这里立刻还给系统 —— B 模式下
            // 图标必须由 Explorer 画，否则「遥控」没有对象。
            crate::commands::grid::restore_desktop_icons(&app);
        } else {
            // 还原偏好：先恢复 LVS_AUTOARRANGE 位，再写回备份的 FFlags
            let backup = meta_get(&conn, META_FFLAGS_BACKUP).and_then(|v| v.parse::<u32>().ok());
            if let Some(flags) = backup {
                di::set_autoarrange(list, di::flags_autoarrange_on(flags));
                let _ = di::write_folder_flags(flags);
            }
            meta_clear(&conn, META_ICON_CONTROL);
            meta_clear(&conn, META_SPACING_Y);
            crate::commands::grid::set_icon_control_runtime(false);
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (listview(), enabled);
        return Err("桌面图标遥控仅支持 Windows".to_string());
    }

    let (placed, unmatched) = if enabled {
        match apply_layout(&conn, &app) {
            Ok(v) => v,
            Err(err) => {
                crate::logging::write_line("grid", &format!("B 模式首次摆位失败：{err}"));
                (0, 0)
            }
        }
    } else {
        (0, 0)
    };
    Ok(status_of(&conn, placed, unmatched))
}

/// 重新摆位（改了格子/条目之后调）。
#[tauri::command]
pub async fn desktop_icon_layout_apply(app: AppHandle) -> Result<IconControlStatus, String> {
    let conn = connect(&app)?;
    if meta_get(&conn, META_ICON_CONTROL).as_deref() != Some("1") {
        return Err("B 模式未开启（不会动你的桌面图标）".to_string());
    }
    let (placed, unmatched) = apply_layout(&conn, &app)?;
    Ok(status_of(&conn, placed, unmatched))
}

/// 还原到「开启 B 模式之前」的图标布局。
#[tauri::command]
pub async fn desktop_icon_layout_restore(app: AppHandle) -> Result<IconControlStatus, String> {
    let conn = connect(&app)?;
    #[cfg(target_os = "windows")]
    {
        let raw = meta_get(&conn, META_POS_BACKUP)
            .ok_or_else(|| "没有可还原的快照（从未开启过 B 模式）".to_string())?;
        let saved: Vec<(i32, i32)> =
            serde_json::from_str(&raw).map_err(|err| format!("快照损坏：{err}"))?;
        let list = listview()?;
        let placements: Vec<(usize, i32, i32)> = saved
            .iter()
            .enumerate()
            .map(|(idx, (x, y))| (idx, *x, *y))
            .collect();
        let placed = di::set_positions(list, &placements);
        return Ok(status_of(&conn, placed, 0));
    }
    #[cfg(not(target_os = "windows"))]
    Err("桌面图标遥控仅支持 Windows".to_string())
}
