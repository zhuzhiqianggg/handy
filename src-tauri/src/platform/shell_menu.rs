//! Windows 原生 Shell 右键菜单（V43）
//!
//! 用户 V43 原话：「你的格子把我图标原始的右键功能全部覆盖了，这个科学吗」。
//! 腾讯桌面整理的做法是：**格子里图标右键弹的就是系统原生菜单** —— 打开 / 打开方式 /
//! 发送到 / 剪切 / 复制 / 重命名 / 删除 / 属性，以及第三方 shell 扩展（Git、7-Zip、
//! 解压、杀毒扫描…）的项。自己仿一个仿不全，所以这里**直接调 Shell 的 `IContextMenu`**：
//!
//! 1. `SHCreateItemFromParsingName` → `IShellItem`（按路径拿 shell 对象）；
//! 2. `BindToHandler(BHID_SFUIObject)` → 该对象的 `IContextMenu`；
//! 3. `QueryContextMenu` 把菜单项填进一个新建的 popup menu；
//! 4. `TrackPopupMenuEx(TPM_RETURNCMD)` 弹出菜单并取回用户选中的命令 id；
//! 5. `InvokeCommand` 交回 Shell 执行（删除 / 复制 / 属性面板等由它自己完成）。
//!
//! **必须在有消息循环的线程上调用** —— `TrackPopupMenuEx` 自己跑模态消息循环，
//! 所以命令层用 `AppHandle::run_on_main_thread` 投递过来（见 `commands::grid::shell_context_menu`）。

use std::mem::size_of;

use windows::core::{HSTRING, PCSTR};
use windows::Win32::Foundation::{HWND, LPARAM, POINT, WPARAM};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::Shell::{
    IContextMenu, IShellItem, SHCreateItemFromParsingName, BHID_SFUIObject, CMINVOKECOMMANDINFO,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreatePopupMenu, DestroyMenu, GetCursorPos, PostMessageW, SetForegroundWindow,
    TrackPopupMenuEx, TPM_LEFTALIGN, TPM_RETURNCMD, TPM_RIGHTBUTTON, WM_NULL,
};

/// 在**当前光标位置**弹出 `path` 对应的系统原生右键菜单。
///
/// 坐标不从前端传：菜单该出现在鼠标那儿，`GetCursorPos` 是最不会算错的做法
/// （前端的 client 坐标要经过窗口偏移 / DPI 换算，反而容易错位）。
///
/// 返回 `Ok(())` 只代表「菜单已经弹过并收回了」；用户在菜单里做了什么由 Shell 自己完成，
/// 我们不需要也不该插手（删除 / 复制 / 属性面板都不是我们的职责）。
pub fn show_context_menu(hwnd: HWND, path: &str) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("没有可操作的路径".to_string());
    }

    unsafe {
        // Tauri 主线程已初始化过 COM（APARTMENTTHREADED）；重复调用返回 S_FALSE，
        // 无害。**不要**在这里 CoUninitialize —— 那会把 Tauri 自己的 COM 一起关掉。
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        let wide = HSTRING::from(path);
        let item: IShellItem = SHCreateItemFromParsingName(&wide, None)
            .map_err(|err| format!("拿不到 shell 对象：{err}"))?;
        let menu: IContextMenu = item
            .BindToHandler(None, &BHID_SFUIObject)
            .map_err(|err| format!("该对象没有右键菜单：{err}"))?;

        let hmenu = CreatePopupMenu().map_err(|err| format!("创建菜单失败：{err}"))?;

        // 1 起、0x7FFF 止：命令 id 由 Shell 填在这个区间里
        if let Err(err) = menu.QueryContextMenu(hmenu, 0, 1, 0x7FFF, 0) {
            let _ = DestroyMenu(hmenu);
            return Err(format!("填充菜单项失败：{err}"));
        }

        let mut point = POINT::default();
        if GetCursorPos(&mut point).is_err() {
            point = POINT { x: 0, y: 0 };
        }

        // 菜单要能「点外面就消失」，前台窗口必须是我们要挂的那个
        let _ = SetForegroundWindow(hwnd);
        let picked = TrackPopupMenuEx(
            hmenu,
            // windows-0.58 把这里声明成裸 u32，位标志要显式取内层值
            (TPM_RETURNCMD | TPM_LEFTALIGN | TPM_RIGHTBUTTON).0,
            point.x,
            point.y,
            hwnd,
            None,
        );
        // 菜单关掉后补一条空消息：否则菜单可能「粘」在屏幕上不消失（Shell 经典坑）
        let _ = PostMessageW(hwnd, WM_NULL, WPARAM(0), LPARAM(0));
        let _ = DestroyMenu(hmenu);

        let cmd = picked.0;
        if cmd == 0 {
            // 用户点了菜单外面 / 按了 Esc
            return Ok(());
        }

        // MAKEINTRESOURCEA：把命令 id 当成指针传（0 基）—— Shell 约定的做法
        let mut info = CMINVOKECOMMANDINFO::default();
        info.cbSize = size_of::<CMINVOKECOMMANDINFO>() as u32;
        info.hwnd = hwnd;
        info.lpVerb = PCSTR((cmd - 1) as usize as *const u8);
        info.nShow = 1; // SW_SHOWNORMAL
        menu.InvokeCommand(&info)
            .map_err(|err| format!("执行菜单命令失败：{err}"))?;
    }
    Ok(())
}
