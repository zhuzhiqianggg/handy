//! 桌面整理（M2，V12）：scan / preview / apply / undo / list_plans。
//!
//! 数据契约：`db/schema.sql` 的 `organize_plans`（id TEXT PK / payload TEXT JSON /
//! applied INTEGER / created_at INTEGER）。**不可改表结构**——计划详情全部放在
//! payload JSON 内（含应用结果与撤销记录）。
//!
//! 职责与安全模型：
//!   - **preview 只算不搬**：规则引擎在 Rust 侧计算「哪些条目 → 哪个目标目录」，
//!     计划 JSON 落 `organize_plans`（applied=0）；目标目录由计划锁定；
//!   - **apply 前置校验**：应用前必须由前端二次确认（UI 责任），Rust 侧再校验一次
//!     「计划存在且 applied=0」，防重复执行；
//!   - **移动安全策略**（每条在对应函数注释展开）：
//!       ① 同名冲突：dest 已存在 → 自动改名 `name (2).ext` 递增，**永不覆盖**；
//!       ② 跳过：隐藏/系统属性文件、`.lnk`（快捷方式默认不整理）、文件夹
//!          （by-type 恒不搬；by-date 跟随 includeFolders 开关）、目标目录
//!          `Handy整理/` 本身（防二次整理）、symlink/junction（非普通文件）；
//!       ③ 单条失败不中断整体（failed 明细回写 payload）；
//!       ④ undo 逆序回滚：dest 缺失 → 跳过并记录；原位置被占用 → **不覆盖**、记录冲突；
//!   - `dir` 参数（`organizer_scan_desktop` / `organizer_preview_plan`）**仅供测试
//!     与自定义目录**：None = 用户真实桌面（运行时由用户亲自触发）。本模块的一切
//!     自动化测试只允许在 TEMP 沙箱目录内进行，**绝不**对真实用户目录做 apply/undo。
//!
//! 平台差异收敛在 `platform` 层（`enumerate_desktop_items` / `move_item`），
//! 规则引擎与安全策略在本模块，与 OS 无关。

use std::path::{Path, PathBuf};

use chrono::DateTime;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use uuid::Uuid;

use crate::db;
use crate::platform::{self, PlatformOps};

/// 整理目标根目录名（桌面下自动创建 `Handy整理/<类别>/`）
pub const TARGET_DIR_NAME: &str = "Handy整理";

/// by-type 六类扩展名映射表（写死常量，便于维护；扩展名小写、不带点）。
/// 顺序即匹配优先级；未命中 → 「其他」。文件夹不参与扩展名分类。
const EXT_CATEGORIES: &[(&str, &[&str])] = &[
    (
        "图片",
        &["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "heic", "ico", "tif", "tiff"],
    ),
    (
        "文档",
        &["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "csv", "rtf", "odt"],
    ),
    ("压缩包", &["zip", "rar", "7z", "tar", "gz", "bz2", "xz"]),
    (
        "音视频",
        &["mp3", "wav", "flac", "aac", "ogg", "m4a", "mp4", "avi", "mkv", "mov", "wmv", "flv"],
    ),
    ("安装包", &["exe", "msi", "msix", "appx", "apk", "dmg", "pkg"]),
];
const CATEGORY_OTHER: &str = "其他";

// —— 实体结构（serde camelCase 对齐前端 `types/organizer.ts`）——

/// 扫描条目（scan 输出；含被排除项，排除原因由 preview 层判定）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizerItem {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// `.lnk` 快捷方式（默认不整理，仅扫描展示）
    pub is_lnk: bool,
    /// 小写扩展名（无扩展名为空串）
    pub ext: String,
    /// 字节数（文件夹为 0）
    pub size: u64,
    /// 修改时间（Unix 秒）
    pub mtime: i64,
    /// by-type 分类名（文件夹为空串）
    pub category: String,
}

/// 扫描结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub dir: String,
    pub items: Vec<OrganizerItem>,
}

/// 规则（前端只传参，引擎在 Rust 侧）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct OrganizerRules {
    /// "by-type" | "by-date"
    pub mode: String,
    /// 是否整理文件夹（by-type 恒按 false 处理；by-date 可选开）
    pub include_folders: bool,
}

/// 计划条目：一条待执行的移动
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub name: String,
    pub source: String,
    pub dest: String,
    /// 分组名（by-type 类别 / by-date "YYYY-MM"）
    pub kind: String,
    pub size: u64,
}

/// 失败 / 跳过 / 冲突明细（apply 结果与 undo 记录复用）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedMove {
    pub name: String,
    pub source: String,
    pub dest: String,
    pub reason: String,
}

/// 计划 payload（存在 `organize_plans.payload` 的 JSON）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PlanPayload {
    pub rules: OrganizerRules,
    /// 目标根目录（计划锁定，apply 不再改）
    pub target_dir: String,
    /// 计划条目（apply 时逐条执行；成功的项 dest 回写为**实际**落地路径）
    pub items: Vec<PlanItem>,
    /// apply 结果：失败/跳过明细（成功应用后非空表示有部分失败）
    pub failed: Vec<FailedMove>,
    /// undo 已执行
    pub undone: bool,
    /// undo 跳过/冲突明细
    pub undo_skipped: Vec<FailedMove>,
}

/// 计划（DB 行 + payload 解析）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: String,
    pub payload: PlanPayload,
    pub applied: bool,
    pub created_at: i64,
}

/// apply 结果摘要
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReport {
    pub moved: usize,
    pub failed: Vec<FailedMove>,
}

/// undo 结果摘要
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoReport {
    pub restored: usize,
    pub skipped: Vec<FailedMove>,
}

// —— 基础工具 ——

fn now_secs() -> i64 {
    chrono::Utc::now().timestamp()
}

/// 打开独立短连接（与 notes/todos/clip 同策略）。
fn connect(app: &AppHandle) -> Result<Connection, String> {
    let path = db::db_path(app)?;
    db::open(&path)
}

/// 缺省桌面目录（`dirs` crate：Windows SHGetKnownFolderPath / macOS NSHomeDirectory 封装）。
fn default_desktop_dir() -> Result<PathBuf, String> {
    dirs::desktop_dir().ok_or_else(|| "无法定位桌面目录".to_string())
}

/// 解析扫描根目录：显式 `dir`（**仅供测试 / 自定义目录**）或用户桌面。
fn resolve_root(dir: Option<String>) -> Result<PathBuf, String> {
    match dir {
        Some(d) if !d.trim().is_empty() => Ok(PathBuf::from(d.trim().to_string())),
        _ => default_desktop_dir(),
    }
}

/// by-type 分类（扩展名 → 类别名；未命中 → 「其他」）
fn category_for(ext: &str) -> &'static str {
    for (category, exts) in EXT_CATEGORIES {
        if exts.contains(&ext) {
            return category;
        }
    }
    CATEGORY_OTHER
}

/// Windows 文件属性位：隐藏 / 系统判定（纯函数，便于无 FFI 单测）。
#[cfg(target_os = "windows")]
fn attrs_hidden_or_system(attrs: u32) -> bool {
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
    attrs & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0
}

/// 隐藏 / 系统文件判定（按路径）：
///   - Windows：`FILE_ATTRIBUTE_HIDDEN`(0x2) / `FILE_ATTRIBUTE_SYSTEM`(0x4)
///     经 `symlink_metadata` + `MetadataExt::file_attributes()` 读取（不跟随链接）；
///   - 其他平台：Unix 惯例的点开头隐藏文件。
/// 读取失败按「不隐藏」处理（move/rename 阶段还会再失败一次并记录，不静默丢数据）。
fn is_hidden_or_system_path(path: &Path) -> bool {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => {
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::fs::MetadataExt;
                attrs_hidden_or_system(meta.file_attributes())
            }
            #[cfg(not(target_os = "windows"))]
            {
                let _ = &meta; // 非 Windows 不使用属性位
                path.file_name()
                    .map(|n| n.to_string_lossy().starts_with('.'))
                    .unwrap_or(false)
            }
        }
        Err(_) => false,
    }
}

// —— 核心逻辑（无 Tauri 依赖，可被 TEMP 沙箱测试直接调用）——

/// 扫描目录直接子项（原始枚举 + 元数据补全）。
///
/// **scan 阶段只排除两类**：隐藏/系统属性文件、symlink/junction（枚举阶段就不该碰）。
/// `.lnk` 与文件夹**保留在扫描结果里**（用户看得见），是否整理由 preview 决定。
pub(crate) fn scan_items(dir: &Path) -> Result<Vec<OrganizerItem>, String> {
    let entries = platform::current().enumerate_desktop_items(dir)?;
    let mut items = Vec::new();
    for entry in entries {
        let path = PathBuf::from(&entry.path);
        // 安全过滤（枚举阶段即排除）：隐藏/系统属性文件、symlink/junction
        if is_hidden_or_system_path(&path) {
            continue;
        }
        let meta = std::fs::symlink_metadata(&path)
            .map_err(|err| format!("读取元数据失败（{}）：{err}", path.display()))?;
        if meta.file_type().is_symlink() {
            continue;
        }
        let mtime: i64 = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let category = if entry.is_dir {
            String::new()
        } else {
            category_for(&ext).to_string()
        };
        items.push(OrganizerItem {
            name: entry.name,
            path: entry.path,
            is_dir: entry.is_dir,
            is_lnk: !entry.is_dir && ext == "lnk",
            ext,
            size: if entry.is_dir { 0 } else { meta.len() },
            mtime,
            category,
        });
    }
    Ok(items)
}

/// 目标路径去重：dest 已存在 → `name (2).ext` 递增，**永不覆盖**（安全策略 ①）。
pub(crate) fn unique_dest(dest: &Path) -> PathBuf {
    if !dest.exists() {
        return dest.to_path_buf();
    }
    let parent = dest.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let stem = dest
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let ext = dest
        .extension()
        .map(|e| e.to_string_lossy().to_string());
    let mut n = 2u32;
    loop {
        let candidate = match &ext {
            Some(e) => parent.join(format!("{stem} ({n}).{e}")),
            None => parent.join(format!("{stem} ({n})")),
        };
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

/// 单条移动的安全过滤（安全策略 ②）。返回 Some(原因) = 应跳过。
///   - `.lnk`：快捷方式指向任意程序，整理容易破坏其语义，默认排除；
///   - 文件夹：by-type 恒不搬（只搬文件）；by-date 跟随 includeFolders 开关；
///   - 目标目录本身：`Handy整理/` 下的产物不再整理（防二次套娃）；
///   - symlink/junction 已在 scan 阶段排除，此处兜底。
fn skip_reason(item: &OrganizerItem, target_dir: &Path, rules: &OrganizerRules) -> Option<String> {
    let source = Path::new(&item.path);
    if item.is_lnk {
        return Some("快捷方式默认不整理".to_string());
    }
    if item.is_dir && (rules.mode == "by-type" || !rules.include_folders) {
        return Some("文件夹未纳入整理范围".to_string());
    }
    if source.starts_with(target_dir) {
        return Some("已是整理产物（位于目标目录内）".to_string());
    }
    if std::fs::symlink_metadata(source)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Some("链接/非常规文件，跳过".to_string());
    }
    None
}

/// 按规则生成分组名（by-type 类别名 / by-date "YYYY-MM"，取自修改时间）。
fn group_for(item: &OrganizerItem, rules: &OrganizerRules) -> String {
    if rules.mode == "by-date" {
        DateTime::from_timestamp(item.mtime, 0)
            .map(|dt| dt.format("%Y-%m").to_string())
            .unwrap_or_else(|| "未知时间".to_string())
    } else {
        category_for(&item.ext).to_string()
    }
}

/// 生成整理计划（**只算不搬**）并落库（applied=0）。
pub(crate) fn build_plan(
    rules: &OrganizerRules,
    dir: &Path,
    conn: &Connection,
) -> Result<Plan, String> {
    if rules.mode != "by-type" && rules.mode != "by-date" {
        return Err(format!("未知整理规则：{}（应为 by-type / by-date）", rules.mode));
    }
    let target_dir = dir.join(TARGET_DIR_NAME);
    let scanned = scan_items(dir)?;

    let mut items: Vec<PlanItem> = Vec::new();
    for item in &scanned {
        // 安全策略 ②：逐条过滤，被跳过的不进计划
        if skip_reason(item, &target_dir, rules).is_some() {
            continue;
        }
        let kind = group_for(item, rules);
        let group_dir = target_dir.join(&kind);
        // 预览阶段展示「理想 dest」（当时状态下的去重结果）；apply 时会按落地时刻
        // 再做一次 unique_dest，保证永不覆盖（预览与实际仅在极小概率下不同）。
        let dest = unique_dest(&group_dir.join(&item.name));
        items.push(PlanItem {
            name: item.name.clone(),
            source: item.path.clone(),
            dest: dest.display().to_string(),
            kind,
            size: item.size,
        });
    }
    // 稳定排序：分组名 → 名称（同一分组聚在一起，前端按组渲染）
    items.sort_by(|a, b| a.kind.cmp(&b.kind).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));

    let payload = PlanPayload {
        rules: rules.clone(),
        target_dir: target_dir.display().to_string(),
        items,
        failed: Vec::new(),
        undone: false,
        undo_skipped: Vec::new(),
    };
    let id = Uuid::new_v4().to_string();
    let created_at = now_secs();
    let json = serde_json::to_string(&payload).map_err(|err| format!("序列化计划失败：{err}"))?;
    conn.execute(
        "INSERT INTO organize_plans (id, payload, applied, created_at) VALUES (?1, ?2, 0, ?3)",
        params![id, json, created_at],
    )
    .map_err(|err| format!("保存计划失败：{err}"))?;
    Ok(Plan { id, payload, applied: false, created_at })
}

/// 读取计划行（payload 反序列化失败时返回可读错误，避免半截数据被误用）。
fn load_plan(conn: &Connection, plan_id: &str) -> Result<Plan, String> {
    let row: Option<(String, i64, i64)> = conn
        .query_row(
            "SELECT payload, applied, created_at FROM organize_plans WHERE id = ?1",
            params![plan_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map(|r| Some(r))
        .or_else(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(format!("读取计划失败：{other}")),
        })?;
    let (json, applied, created_at) =
        row.ok_or_else(|| "整理计划不存在或已被删除".to_string())?;
    let payload: PlanPayload =
        serde_json::from_str(&json).map_err(|err| format!("计划数据损坏：{err}"))?;
    Ok(Plan { id: plan_id.to_string(), payload, applied: applied != 0, created_at })
}

/// 保存计划（payload + applied）
fn save_plan(conn: &Connection, plan: &Plan) -> Result<(), String> {
    let json = serde_json::to_string(&plan.payload).map_err(|err| format!("序列化计划失败：{err}"))?;
    conn.execute(
        "UPDATE organize_plans SET payload = ?1, applied = ?2 WHERE id = ?3",
        params![json, plan.applied as i64, plan.id],
    )
    .map_err(|err| format!("保存计划失败：{err}"))?;
    Ok(())
}

/// 执行移动（安全策略 ③④）。
///
/// 前置：前端二次确认（UI 责任）+ 此处校验「计划存在且 applied=0」（防重复执行）。
/// 每条移动：源缺失 → failed；dest 按落地时刻再 `unique_dest`（永不覆盖）；
/// `fs::rename` 失败（权限 / 被占用 / 跨盘）→ failed，**不中断**其余条目。
pub(crate) fn apply_plan(conn: &Connection, plan_id: &str) -> Result<ApplyReport, String> {
    let mut plan = load_plan(conn, plan_id)?;
    if plan.applied {
        return Err("该计划已应用过，不能重复执行（如需撤销请使用撤销）".to_string());
    }
    let target_dir = PathBuf::from(&plan.payload.target_dir);
    // 目标根目录兜底创建（用户可能在应用前删掉了它）
    std::fs::create_dir_all(&target_dir)
        .map_err(|err| format!("创建目标目录失败（{}）：{err}", target_dir.display()))?;

    let mut failed: Vec<FailedMove> = Vec::new();
    let mut moved = 0usize;
    for item in &mut plan.payload.items {
        let source = PathBuf::from(&item.source);
        if !source.exists() {
            failed.push(FailedMove {
                name: item.name.clone(),
                source: item.source.clone(),
                dest: item.dest.clone(),
                reason: "源文件不存在（可能已被移动或删除）".to_string(),
            });
            continue;
        }
        let dest_path = unique_dest(Path::new(&item.dest));
        // 分组子目录（Handy整理/<类别 或 YYYY-MM>/）按需创建（预览只算不搬，目录在应用时落地）
        if let Some(parent) = dest_path.parent() {
            if let Err(err) = std::fs::create_dir_all(parent) {
                failed.push(FailedMove {
                    name: item.name.clone(),
                    source: item.source.clone(),
                    dest: item.dest.clone(),
                    reason: format!("创建目标目录失败：{err}"),
                });
                continue;
            }
        }
        match std::fs::rename(&source, &dest_path) {
            Ok(()) => {
                // 实际落地路径回写（可能因冲突改名与预览不同；undo 依赖此记录）
                item.dest = dest_path.display().to_string();
                moved += 1;
            }
            Err(err) => failed.push(FailedMove {
                name: item.name.clone(),
                source: item.source.clone(),
                dest: item.dest.clone(),
                reason: format!("移动失败：{err}"),
            }),
        }
    }

    plan.payload.failed = failed;
    plan.applied = true;
    save_plan(conn, &plan)?;
    Ok(ApplyReport { moved, failed: plan.payload.failed })
}

/// 逆序回滚已应用计划的所有移动（安全策略 ④）。
///
///   - dest 缺失（目标文件被用户删除/移走）→ 跳过并记录；
///   - 原位置已被同名占用 → **不覆盖**，记录冲突，文件保留在目标目录；
///   - 单条失败不中断；撤销状态与明细回写 payload（undone=true）。
pub(crate) fn undo_plan(conn: &Connection, plan_id: &str) -> Result<UndoReport, String> {
    let mut plan = load_plan(conn, plan_id)?;
    if !plan.applied {
        return Err("该计划尚未应用，无可撤销内容".to_string());
    }
    if plan.payload.undone {
        return Err("该计划已撤销过，不能重复撤销".to_string());
    }

    let mut skipped: Vec<FailedMove> = Vec::new();
    let mut restored = 0usize;
    // apply 阶段失败的条目**没有发生移动**，不在回滚范围（也不计入 undo 跳过明细）
    let failed_sources: std::collections::HashSet<&str> = plan
        .payload
        .failed
        .iter()
        .map(|f| f.source.as_str())
        .collect();
    for item in plan.payload.items.iter().rev() {
        if failed_sources.contains(item.source.as_str()) {
            continue;
        }
        let source = PathBuf::from(&item.source);
        let dest = PathBuf::from(&item.dest);
        if !dest.exists() {
            skipped.push(FailedMove {
                name: item.name.clone(),
                source: item.source.clone(),
                dest: item.dest.clone(),
                reason: "目标文件缺失（可能已被删除或移走），跳过".to_string(),
            });
            continue;
        }
        if source.exists() {
            skipped.push(FailedMove {
                name: item.name.clone(),
                source: item.source.clone(),
                dest: item.dest.clone(),
                reason: "原位置已被同名文件占用，不覆盖，文件保留在目标目录".to_string(),
            });
            continue;
        }
        match std::fs::rename(&dest, &source) {
            Ok(()) => restored += 1,
            Err(err) => skipped.push(FailedMove {
                name: item.name.clone(),
                source: item.source.clone(),
                dest: item.dest.clone(),
                reason: format!("回滚失败：{err}"),
            }),
        }
    }

    plan.payload.undone = true;
    plan.payload.undo_skipped = skipped;
    save_plan(conn, &plan)?;
    Ok(UndoReport { restored, skipped: plan.payload.undo_skipped })
}

/// 历史计划列表（新 → 旧）
pub(crate) fn list_plans(conn: &Connection) -> Result<Vec<Plan>, String> {
    let mut stmt = conn
        .prepare("SELECT id, payload, applied, created_at FROM organize_plans ORDER BY created_at DESC")
        .map_err(|err| format!("查询计划失败：{err}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?, row.get::<_, i64>(3)?))
        })
        .map_err(|err| format!("查询计划失败：{err}"))?;
    let mut plans = Vec::new();
    for row in rows {
        let (id, json, applied, created_at) = row.map_err(|err| format!("读取计划失败：{err}"))?;
        let payload: PlanPayload = serde_json::from_str(&json)
            .map_err(|err| format!("计划数据损坏（{id}）：{err}"))?;
        plans.push(Plan { id, payload, applied: applied != 0, created_at });
    }
    Ok(plans)
}

// —— Tauri 命令（薄包装；AppHandle 仅用于 db_path）——

/// 枚举桌面条目。`dir` 传 `None` = 用户真实桌面；显式目录仅供测试 / 自定义场景。
#[tauri::command]
pub async fn organizer_scan_desktop(dir: Option<String>) -> Result<ScanResult, String> {
    let root = resolve_root(dir)?;
    let items = scan_items(&root)?;
    Ok(ScanResult { dir: root.display().to_string(), items })
}

/// 按规则生成整理计划（只算不搬），落库后返回完整计划（applied=0）。
#[tauri::command]
pub async fn organizer_preview_plan(
    app: AppHandle,
    rules: OrganizerRules,
    dir: Option<String>,
) -> Result<Plan, String> {
    let conn = connect(&app)?;
    let root = resolve_root(dir)?;
    build_plan(&rules, &root, &conn)
}

/// 前端勾选排除后回写计划条目（仅 applied=0 的计划可改）。
#[tauri::command]
pub async fn organizer_update_plan_items(
    app: AppHandle,
    plan_id: String,
    items: Vec<PlanItem>,
) -> Result<Plan, String> {
    let conn = connect(&app)?;
    let mut plan = load_plan(&conn, &plan_id)?;
    if plan.applied {
        return Err("该计划已应用，不能修改条目".to_string());
    }
    plan.payload.items = items;
    save_plan(&conn, &plan)?;
    Ok(plan)
}

/// 执行移动。**应用前必须由前端二次确认**；Rust 侧再校验一次 applied=0。
#[tauri::command]
pub async fn organizer_apply(app: AppHandle, plan_id: String) -> Result<ApplyReport, String> {
    let conn = connect(&app)?;
    apply_plan(&conn, &plan_id)
}

/// 逆序撤销已应用计划的所有移动。
#[tauri::command]
pub async fn organizer_undo(app: AppHandle, plan_id: String) -> Result<UndoReport, String> {
    let conn = connect(&app)?;
    undo_plan(&conn, &plan_id)
}

/// 历史计划列表（含 applied / undone 状态）。
#[tauri::command]
pub async fn organizer_list_plans(app: AppHandle) -> Result<Vec<Plan>, String> {
    let conn = connect(&app)?;
    list_plans(&conn)
}

// —— TEMP 沙箱测试（红线：绝不触碰真实用户目录；沙箱目录在 %TEMP% 下自建自清理）——

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    const SCHEMA: &str = include_str!("../db/schema.sql");

    /// 内存库 + 全量 schema（organize_plans 可用）
    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn
    }

    /// TEMP 沙箱：`%TEMP%/handy-org-test-<pid>-<seq>/desktop`。
    /// 原子序号保证并行测试互不干扰（绝不触碰真实用户目录）。
    fn sandbox() -> PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let root =
            std::env::temp_dir().join(format!("handy-org-test-{}-{n}", std::process::id()));
        let desktop = root.join("desktop");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&desktop).unwrap();
        desktop
    }

    fn touch(dir: &Path, name: &str, content: &[u8]) {
        std::fs::write(dir.join(name), content).unwrap();
    }

    #[test]
    fn attrs_bits() {
        // Windows 属性位纯逻辑（无 FFI）：隐藏(0x2)/系统(0x4) 命中，只读(0x1) 不命中
        #[cfg(target_os = "windows")]
        {
            assert!(attrs_hidden_or_system(0x2));
            assert!(attrs_hidden_or_system(0x4));
            assert!(attrs_hidden_or_system(0x2 | 0x4 | 0x10));
            assert!(!attrs_hidden_or_system(0x0));
            assert!(!attrs_hidden_or_system(0x1));
        }
    }

    #[test]
    fn unique_dest_never_overwrites() {
        let root = sandbox();
        let dir = root.join("u");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), b"old").unwrap();
        let dest = unique_dest(&dir.join("a.txt"));
        assert_eq!(dest.file_name().unwrap().to_string_lossy(), "a (2).txt");
        std::fs::write(&dest, b"").unwrap();
        let dest2 = unique_dest(&dir.join("a.txt"));
        assert_eq!(dest2.file_name().unwrap().to_string_lossy(), "a (3).txt");
        // 无扩展名
        std::fs::write(dir.join("README"), b"").unwrap();
        let dest3 = unique_dest(&dir.join("README"));
        assert_eq!(dest3.file_name().unwrap().to_string_lossy(), "README (2)");
        // 不存在路径原样返回
        assert_eq!(unique_dest(&dir.join("none.txt")), dir.join("none.txt"));
    }

    #[test]
    fn scan_preview_apply_undo_full_cycle_by_type() {
        let desktop = sandbox();
        // 9 个普通文件（覆盖六类 + 其他）+ .lnk + 文件夹
        touch(&desktop, "a.jpg", b"1");
        touch(&desktop, "b.png", b"22");
        touch(&desktop, "doc.pdf", b"333");
        touch(&desktop, "archive.zip", b"4444");
        touch(&desktop, "song.mp3", b"55555");
        touch(&desktop, "video.mp4", b"666666");
        touch(&desktop, "setup.exe", b"7777777");
        touch(&desktop, "note.txt", b"88888888");
        touch(&desktop, "data.xyz", b"999999999");
        touch(&desktop, "shortcut.lnk", b"l");
        std::fs::create_dir(desktop.join("somefolder")).unwrap();

        // —— scan：.lnk / 文件夹可见；symlink/隐藏不进入 ——
        let items = scan_items(&desktop).unwrap();
        assert_eq!(items.len(), 11);
        assert!(items.iter().any(|i| i.name == "shortcut.lnk" && i.is_lnk));
        assert!(items.iter().any(|i| i.name == "somefolder" && i.is_dir));
        assert!(items.iter().all(|i| i.name != ".hidden"));

        // —— preview：只算不搬 ——
        let conn = test_conn();
        let rules = OrganizerRules { mode: "by-type".into(), include_folders: false };
        let plan = build_plan(&rules, &desktop, &conn).unwrap();
        assert!(!plan.applied);
        // 排除：.lnk、文件夹；包含：9 个文件
        assert_eq!(plan.payload.items.len(), 9);
        assert!(plan.payload.items.iter().all(|i| i.name != "shortcut.lnk"));
        assert!(plan.payload.items.iter().all(|i| i.name != "somefolder"));
        let by_kind = |kind: &str| plan.payload.items.iter().filter(|i| i.kind == kind).count();
        assert_eq!(by_kind("图片"), 2); // a.jpg / b.png
        assert_eq!(by_kind("文档"), 2); // doc.pdf / note.txt
        assert_eq!(by_kind("压缩包"), 1);
        assert_eq!(by_kind("音视频"), 2);
        assert_eq!(by_kind("安装包"), 1);
        assert_eq!(by_kind("其他"), 1); // data.xyz
        let a = plan.payload.items.iter().find(|i| i.name == "a.jpg").unwrap();
        assert!(a.dest.replace('\\', "/").contains("Handy整理/图片/a.jpg"));
        // 预览未搬动：桌面仍有 9 个文件
        assert!(desktop.join("a.jpg").exists());

        // —— 同名冲突预置：目标目录已有 a.jpg → 应改名为 a (2).jpg 且不覆盖 ——
        let img_dir = desktop.join("Handy整理").join("图片");
        std::fs::create_dir_all(&img_dir).unwrap();
        std::fs::write(img_dir.join("a.jpg"), b"old").unwrap();

        // —— apply ——
        let report = apply_plan(&conn, &plan.id).unwrap();
        assert_eq!(report.moved, 9);
        assert!(report.failed.is_empty());
        // 冲突文件未被覆盖，新文件改名落地
        assert_eq!(std::fs::read(img_dir.join("a.jpg")).unwrap(), b"old");
        assert!(img_dir.join("a (2).jpg").exists());
        // 实际 dest 回写进 plan（undo 依赖）
        let applied = load_plan(&conn, &plan.id).unwrap();
        assert!(applied.applied);
        let a2 = applied.payload.items.iter().find(|i| i.name == "a.jpg").unwrap();
        assert!(a2.dest.replace('\\', "/").contains("a (2).jpg"));
        // 桌面只剩 .lnk / 文件夹 / Handy整理
        assert!(!desktop.join("a.jpg").exists());
        assert!(desktop.join("shortcut.lnk").exists());
        assert!(desktop.join("somefolder").exists());
        // 重复 apply 被拒
        assert!(apply_plan(&conn, &plan.id).is_err());

        // —— undo：逆序回滚，全部回桌面 ——
        let undo = undo_plan(&conn, &plan.id).unwrap();
        assert_eq!(undo.restored, 9);
        assert!(undo.skipped.is_empty());
        assert!(desktop.join("a.jpg").exists()); // 回滚为原名（原名未被占用）
        assert!(desktop.join("data.xyz").exists());
        assert!(!img_dir.join("a (2).jpg").exists());
        let undone = load_plan(&conn, &plan.id).unwrap();
        assert!(undone.payload.undone);
        // 重复 undo 被拒
        assert!(undo_plan(&conn, &plan.id).is_err());
        // list
        let plans = list_plans(&conn).unwrap();
        assert_eq!(plans.len(), 1);
    }

    #[test]
    fn apply_partial_failure_and_undo_skip() {
        let desktop = sandbox();
        touch(&desktop, "x.jpg", b"a");
        touch(&desktop, "y.txt", b"b");
        touch(&desktop, "z.txt", b"c");
        let conn = test_conn();
        let rules = OrganizerRules { mode: "by-type".into(), include_folders: false };
        let plan = build_plan(&rules, &desktop, &conn).unwrap();
        assert_eq!(plan.payload.items.len(), 3);

        // 预览后删除一个源 → apply 单条失败不中断
        std::fs::remove_file(desktop.join("x.jpg")).unwrap();
        let report = apply_plan(&conn, &plan.id).unwrap();
        assert_eq!(report.moved, 2);
        assert_eq!(report.failed.len(), 1);
        assert_eq!(report.failed[0].name, "x.jpg");
        let applied = load_plan(&conn, &plan.id).unwrap();
        assert!(applied.applied && !applied.payload.failed.is_empty());

        // undo：人为删掉一个 dest → 跳过并记录，其余回滚
        std::fs::remove_file(desktop.join("Handy整理").join("文档").join("y.txt")).unwrap();
        let undo = undo_plan(&conn, &plan.id).unwrap();
        assert_eq!(undo.restored, 1); // z.txt
        assert_eq!(undo.skipped.len(), 1); // y.txt 缺失
        assert!(desktop.join("z.txt").exists());

        // undo 冲突：原位置被占用 → 不覆盖
        let desktop2 = sandbox();
        touch(&desktop2, "m.txt", b"orig");
        let plan2 = build_plan(&rules, &desktop2, &conn).unwrap();
        apply_plan(&conn, &plan2.id).unwrap();
        // 原位置放回同名文件
        std::fs::write(desktop2.join("m.txt"), b"newer").unwrap();
        let undo2 = undo_plan(&conn, &plan2.id).unwrap();
        assert_eq!(undo2.restored, 0);
        assert_eq!(undo2.skipped.len(), 1);
        assert_eq!(std::fs::read(desktop2.join("m.txt")).unwrap(), b"newer"); // 未被覆盖
    }

    #[test]
    fn by_date_groups_by_modified_month() {
        let desktop = sandbox();
        touch(&desktop, "old.txt", b"a");
        touch(&desktop, "new.txt", b"b");
        // 显式改 mtime：old → 2024-01，new → 2025-06
        let file = std::fs::File::options().append(true).open(desktop.join("old.txt")).unwrap();
        file.set_modified(
            std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_704_067_200), // 2024-01-01
        )
        .unwrap();
        let file = std::fs::File::options().append(true).open(desktop.join("new.txt")).unwrap();
        file.set_modified(
            std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_749_465_600), // 2025-06-08
        )
        .unwrap();
        let conn = test_conn();
        let rules = OrganizerRules { mode: "by-date".into(), include_folders: false };
        let plan = build_plan(&rules, &desktop, &conn).unwrap();
        assert_eq!(plan.payload.items.len(), 2);
        let kinds: Vec<&str> = plan.payload.items.iter().map(|i| i.kind.as_str()).collect();
        assert!(kinds.contains(&"2024-01"));
        assert!(kinds.contains(&"2025-06"));
        let old = plan.payload.items.iter().find(|i| i.name == "old.txt").unwrap();
        assert!(old.dest.replace('\\', "/").contains("Handy整理/2024-01/old.txt"));
    }

    #[test]
    fn target_dir_contents_never_reorganized() {
        let desktop = sandbox();
        // Handy整理 内已有的旧产物不应再次进入计划
        let target = desktop.join("Handy整理").join("图片");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("inside.jpg"), b"").unwrap();
        let conn = test_conn();
        let rules = OrganizerRules { mode: "by-type".into(), include_folders: false };
        let plan = build_plan(&rules, &desktop, &conn).unwrap();
        assert!(plan.payload.items.is_empty(), "目标目录内条目不得二次整理");
    }
}
