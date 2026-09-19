//! 桌面背景右键菜单入口（V45，借鉴腾讯桌面整理）。
//!
//! # 为什么加这个
//!
//! 用户 09-19 发来一张腾讯桌面整理的截图：它在「桌面空白处右键」的菜单里加了一项
//! ——「开启桌面整理」—— 问我们是不是也该借鉴。答案是该借：**桌面右键是用户在桌面上
//! 最自然的第一反射**，比让用户去托盘里翻菜单顺手得多。
//!
//! # 怎么实现
//!
//! 走 **HKCU 注册表**（不需要管理员权限，卸载时整键删除，不留残留）：
//!
//! ```text
//! HKCU\Software\Classes\DesktopBackground\Shell\HandyDesktopGrid
//!     (默认)  = 打开 Handy 桌面整理
//!     Icon    = "<handy.exe 全路径>",0
//!     \command
//!         (默认) = "<handy.exe 全路径>" --show-grid
//! ```
//!
//! `DesktopBackground\Shell` 正是「桌面空白处右键」的注册位置（`Directory\Background`
//! 是文件夹内的空白处，两者不是一回事）。
//!
//! # 点击之后发生什么
//!
//! `handy.exe --show-grid`：
//!   - Handy **没在跑** → 正常启动，`lib.rs` 的 setup 读到该参数 → 直接把桌面整理层
//!     显示出来（内容 + 工具栏），不弹主窗口；
//!   - Handy **正在跑**（更常见）→ 被单实例插件拦下，回调里同样识别该参数 →
//!     调 `grid::show_overlay_now` 把整理层叫回来，而不是弹主窗口。
//!
//! 于是「隐藏了整理 → 从桌面右键再叫回来」这条闭环成立，且与托盘入口互为备份。
//!
//! # 为什么用 `reg.exe` 而不是 windows crate 的 Registry API
//!
//! 三个键的增删是一次性动作（不是热路径），`reg.exe` 语义直白、失败信息可读，
//! 而且不必为它打开新的 windows crate feature（构建体积与编译时间的实际成本）。
//! 调用时带 `CREATE_NO_WINDOW`，不会闪黑框。

/// 菜单项在注册表里的键路径（`HKCU` 下，无需管理员权限）。
const MENU_KEY: &str = r"Software\Classes\DesktopBackground\Shell\HandyDesktopGrid";
/// 右键菜单上显示的文字
const MENU_LABEL: &str = "打开 Handy 桌面整理";

/// 是否已经装好菜单项。
#[cfg(target_os = "windows")]
pub fn status() -> Result<bool, String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let out = Command::new("reg")
        .args(["query", &format!("HKCU\\{MENU_KEY}")])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|err| format!("调用 reg.exe 失败：{err}"))?;
    Ok(out.status.success())
}

/// 写入菜单项（幂等：重复调用只是覆盖同名键）。
#[cfg(target_os = "windows")]
pub fn install() -> Result<(), String> {
    let exe = current_exe_string()?;
    run_reg(&["add", &format!("HKCU\\{MENU_KEY}"), "/ve", "/d", MENU_LABEL, "/f"])?;
    run_reg(&[
        "add",
        &format!("HKCU\\{MENU_KEY}"),
        "/v",
        "Icon",
        "/d",
        &format!("\"{exe}\",0"),
        "/f",
    ])?;
    run_reg(&[
        "add",
        &format!("HKCU\\{MENU_KEY}\\command"),
        "/ve",
        "/d",
        &format!("\"{exe}\" --show-grid"),
        "/f",
    ])?;
    Ok(())
}

/// 删除菜单项（不存在时也当成功 —— 用户点「关闭」的意图已经达成）。
#[cfg(target_os = "windows")]
pub fn remove() -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let _ = Command::new("reg")
        .args(["delete", &format!("HKCU\\{MENU_KEY}"), "/f"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|err| format!("调用 reg.exe 失败：{err}"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn current_exe_string() -> Result<String, String> {
    std::env::current_exe()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|err| format!("取当前程序路径失败：{err}"))
}

#[cfg(target_os = "windows")]
fn run_reg(args: &[&str]) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let out = Command::new("reg")
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|err| format!("调用 reg.exe 失败：{err}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if detail.is_empty() {
            "reg.exe 执行失败".to_string()
        } else {
            detail
        })
    }
}

// —— macOS：暂不提供（Finder 的「服务」菜单是另一套机制，后续按需适配） ——

#[cfg(target_os = "macos")]
pub fn status() -> Result<bool, String> {
    Ok(false)
}

#[cfg(target_os = "macos")]
pub fn install() -> Result<(), String> {
    Err("当前平台的桌面右键菜单入口尚未实现".to_string())
}

#[cfg(target_os = "macos")]
pub fn remove() -> Result<(), String> {
    Ok(())
}
