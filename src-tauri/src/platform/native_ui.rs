//! Windows 原生 UI 交互（用户 10-11 拍板：「名称重复提示应该是 Windows 的提示，
//! 删除行为应该使用 Windows 原生的」）。
//!
//! # 为什么单独开一个模块
//!
//! 这两条都是「跟 Windows 本尊对齐」的文件操作反馈，谁都不该再被 Handy 的自绘
//! toast / 自绘确认框替代。收敛到一个文件里，守卫（`test-shell-menu.mjs`）好锁、
//! 变异自检好破坏，也避免 `grid.rs` 再膨胀（11,540 行的重灾区，能不碰就不碰）。
//!
//! 两件事：
//! ① [`rename_conflict_dialog`] —— 改名撞名时弹 Windows 原生对话框（Explorer 同款文案）；
//! ② [`delete_to_recycle_bin`] —— `SHFileOperationW(FO_DELETE, FOF_ALLOWUNDO)`：
//!    与 Explorer 完全同源 —— 系统开了「删除确认」就弹系统确认框，删掉的进回收站（可还原）。
//!
//! 失败一律返回可读中文错误，不静默吞；用户在原生对话框里取消不算错误（返回 `false`）。

/// 哨兵错误：这条错误的提示**已经用 Windows 原生对话框展示过了**，前端不要再叠一条
/// Handy toast（叠了就是两个提示，用户 10-11 截图里的那颗「已经有一个『123123』了」）。
///
/// Rust → 前端经 IPC 只能传字符串错误，用约定哨兵区分「已原生提示」与「需前端提示」。
pub const ERR_NATIVE_SHOWN: &str = "__native_dialog_shown__";

/// 把字符串转成 NUL 结尾的 UTF-16（Windows API 入参）。
#[cfg(target_os = "windows")]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 改名撞名：弹 Windows 原生对话框（替代 Handy toast）。
///
/// 文案对齐资源管理器（zh-CN）：「已存在名为“X”的文件夹/文件。请指定其他名称。」
/// `is_dir` 决定量词；标题用 Windows 自己的「重命名文件夹或文件」。
/// `MB_TOPMOST | MB_SETFOREGROUND`：命令跑在后台线程，没有宿主窗可挂，
/// 这两个标志保证对话框一定浮在 Handy 挂件层之上、不落任务栏后面。
#[cfg(target_os = "windows")]
pub fn rename_conflict_dialog(name: &str, is_dir: bool) {
    use windows::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, MB_ICONWARNING, MB_OK, MB_SETFOREGROUND, MB_TOPMOST,
    };
    use windows::core::PCWSTR;

    let kind = if is_dir { "文件夹" } else { "文件" };
    let text = wide(&format!("已存在名为“{name}”的{kind}。请指定其他名称。"));
    let title = wide("重命名文件夹或文件");
    unsafe {
        MessageBoxW(
            None,
            PCWSTR(text.as_ptr()),
            PCWSTR(title.as_ptr()),
            MB_OK | MB_ICONWARNING | MB_SETFOREGROUND | MB_TOPMOST,
        );
    }
}

#[cfg(not(target_os = "windows"))]
pub fn rename_conflict_dialog(_name: &str, _is_dir: bool) {}

/// 删除文件 / 文件夹到**回收站**（Windows 原生链路）。
///
/// 返回 `Ok(true)` = 已删除（进了回收站）；`Ok(false)` = 用户在原生确认框里点了取消。
/// `FOF_ALLOWUNDO` 是「进回收站」的开关；**故意不带** `FOF_NOCONFIRMATION` ——
/// 系统开了「显示删除确认对话框」时由 Windows 自己弹（原生确认 = 用户要的东西）。
#[cfg(target_os = "windows")]
pub fn delete_to_recycle_bin(path: &std::path::Path) -> Result<bool, String> {
    use std::os::windows::ffi::OsStrExt;

    use windows::Win32::Foundation::{BOOL, HWND};
    use windows::Win32::UI::Shell::{FO_DELETE, FOF_ALLOWUNDO, SHFileOperationW, SHFILEOPSTRUCTW};
    use windows::core::PCWSTR;

    // `pFrom` 要求**双 NUL 结尾**的路径列表（单路径也必须双 NUL，否则读到垃圾）
    let mut from: Vec<u16> = path.as_os_str().encode_wide().collect();
    from.extend_from_slice(&[0, 0]);

    let mut op = SHFILEOPSTRUCTW {
        hwnd: HWND::default(),
        wFunc: FO_DELETE,
        pFrom: PCWSTR(from.as_ptr()),
        pTo: PCWSTR::null(),
        fFlags: FOF_ALLOWUNDO.0 as u16,
        fAnyOperationsAborted: BOOL::default(),
        hNameMappings: std::ptr::null_mut(),
        lpszProgressTitle: PCWSTR::null(),
    };
    // 返回 0 = 成功；非 0 是系统错误码（用户取消时为 0 但 aborted = TRUE）
    let code = unsafe { SHFileOperationW(&mut op) };
    if code != 0 {
        return Err(format!("删除失败（系统错误码 {code}）"));
    }
    Ok(!op.fAnyOperationsAborted.as_bool())
}

#[cfg(not(target_os = "windows"))]
pub fn delete_to_recycle_bin(_path: &std::path::Path) -> Result<bool, String> {
    Err("原生删除仅支持 Windows".to_string())
}
