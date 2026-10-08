//! 一次性诊断工具（不参与发布）：枚举「桌面**背景**」的原生右键菜单。
//!
//! # 为什么单独写这个（`menu_dump` 不够用）
//!
//! `menu_dump` 走的是 `IShellItem::BindToHandler(BHID_SFUIObject)` —— 那是**条目**的菜单
//! （打开 / 剪切 / 复制 / 删除 / 属性，见下方路线 B 的实测输出）。但用户右键**桌面空白**
//! 时看到的「新建 / 粘贴 / 查看 / 排序方式 / 刷新 / 个性化」是另一种东西：**背景菜单**，
//! 只能从 `IShellFolder::CreateViewObject(IID_IContextMenu)` 拿（Explorer 的 DefView
//! 就是这么做的）。
//!
//! 这是「自己弹原生桌面空白菜单」路线能否成立的命门 —— **必须先证实，不许赌**。
//!
//! 用法：
//!   cargo run --release --example bg_menu_dump [桌面目录]
//!
//! 判据：A1 或 A2 的输出里必须出现「新建(&W)」与「粘贴(&P)」。
//!
//! # 第一次跑的结论（改代码前的事实）
//!
//! - **路线 A0 已作废**：`SHGetKnownFolderIDList(FOLDERID_Desktop)` 拿到的 PIDL **就是命名
//!   空间根本身**，再拿它去 `root.BindToObject(...)` 报 `E_INVALIDARG (0x80070057)`。
//!   桌面根没有「父文件夹」可绑 —— 它就是根。
//! - 于是改成 **A1（直接对 `SHGetDesktopFolder()` 的结果 CreateViewObject）** 与
//!   **A2（解析真实桌面目录的绝对 PIDL → `root.BindToObject` → CreateViewObject）** 两条。

use std::mem::size_of;
use std::ptr;

use windows::core::{HSTRING, PCWSTR};
use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::Shell::{
    IContextMenu, IShellFolder, IShellItem, SHCreateItemFromParsingName, SHGetDesktopFolder,
    SHParseDisplayName, BHID_SFUIObject,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreatePopupMenu, DestroyMenu, GetMenuItemCount, GetMenuItemID, GetMenuStringW, GetSubMenu,
    MF_BYPOSITION,
};

const CMF_NORMAL: u32 = 0x0000;
const CMF_EXPLORE: u32 = 0x0004;
const CMF_EXTENDEDVERBS: u32 = 0x0100;

/// 枚举并打印一个 `IContextMenu`（`QueryContextMenu` 只填充、不弹出，所以无人值守可跑）。
fn dump_menu(menu: &IContextMenu, flags: u32, label: &str) -> Result<(), String> {
    unsafe {
        let hmenu = CreatePopupMenu().map_err(|e| format!("CreatePopupMenu: {e}"))?;
        if let Err(e) = menu.QueryContextMenu(hmenu, 0, 1, 0x7FFF, flags) {
            let _ = DestroyMenu(hmenu);
            return Err(format!("QueryContextMenu: {e}"));
        }
        let count = GetMenuItemCount(hmenu);
        println!("  {label}  flags=0x{flags:04X}  → {count} 项");
        for i in 0..count {
            let mut buf = [0u16; 512];
            let len = GetMenuStringW(hmenu, i as u32, Some(&mut buf[..]), MF_BYPOSITION);
            let text = if len > 0 {
                String::from_utf16_lossy(&buf[..len as usize])
            } else {
                String::new()
            };
            let id = GetMenuItemID(hmenu, i);
            if text.trim().is_empty() {
                println!("      --- (分隔线)");
            } else {
                println!("      [{id}] {text}");
            }
            // 有子菜单的项：`id == u32::MAX`。懒加载的扩展要等 WM_INITMENUPOPUP 才补项，
            // 这里不弹菜单就不补 —— 所以子菜单只作参考，不作判据。
            if id == u32::MAX {
                let sub = GetSubMenu(hmenu, i);
                let n = GetMenuItemCount(sub);
                if n > 0 {
                    for j in 0..n.min(6) {
                        let mut sb = [0u16; 256];
                        let sl = GetMenuStringW(sub, j as u32, Some(&mut sb[..]), MF_BYPOSITION);
                        if sl > 0 {
                            let st = String::from_utf16_lossy(&sb[..sl as usize]);
                            if !st.trim().is_empty() {
                                println!("          · {st}");
                            }
                        }
                    }
                }
            }
        }
        let _ = DestroyMenu(hmenu);
        let _ = size_of::<IContextMenu>();
        Ok(())
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let desktop_dir = args
        .first()
        .cloned()
        .unwrap_or_else(|| dirs_fallback_desktop());

    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        // ── 路线 A1：桌面**根** IShellFolder 自己就是桌面视图 ──────────────────────
        println!("=== 路线 A1：SHGetDesktopFolder → CreateViewObject（桌面背景菜单）===");
        match (|| -> Result<(), String> {
            let root: IShellFolder =
                SHGetDesktopFolder().map_err(|e| format!("SHGetDesktopFolder: {e}"))?;
            let menu: IContextMenu = root
                .CreateViewObject(None)
                .map_err(|e| format!("CreateViewObject(IContextMenu): {e}"))?;
            dump_menu(&menu, CMF_NORMAL | CMF_EXPLORE, "背景菜单")
        })() {
            Ok(()) => println!("  路线 A1：OK"),
            Err(e) => println!("  路线 A1 失败：{e}"),
        }

        // ── 路线 A2：解析真实桌面目录的绝对 PIDL → BindToObject → CreateViewObject ──
        // 这条是**通用目录背景菜单**的写法（格子将来挂别的目录也用它）。
        println!();
        println!("=== 路线 A2：SHParseDisplayName → BindToObject → CreateViewObject ===");
        println!("  路径: {desktop_dir}");
        match (|| -> Result<(), String> {
            let wide = HSTRING::from(desktop_dir.as_str());
            let mut pidl: *mut windows::Win32::UI::Shell::Common::ITEMIDLIST = ptr::null_mut();
            SHParseDisplayName(PCWSTR(wide.as_ptr()), None, &mut pidl, 0, None)
                .map_err(|e| format!("SHParseDisplayName: {e}"))?;
            let root: IShellFolder =
                SHGetDesktopFolder().map_err(|e| format!("SHGetDesktopFolder: {e}"))?;
            let folder: Result<IShellFolder, _> = root.BindToObject(pidl, None);
            CoTaskMemFree(Some(pidl.cast()));
            let folder = folder.map_err(|e| format!("BindToObject(桌面目录): {e}"))?;
            let menu: IContextMenu = folder
                .CreateViewObject(None)
                .map_err(|e| format!("CreateViewObject(IContextMenu): {e}"))?;
            dump_menu(&menu, CMF_NORMAL | CMF_EXPLORE, "目录背景菜单")
        })() {
            Ok(()) => println!("  路线 A2：OK"),
            Err(e) => println!("  路线 A2 失败：{e}"),
        }

        // ── 路线 B（对照）：桌面**目录本身**当条目看待（`menu_dump` 那条路）─────────
        println!();
        println!("=== 路线 B（对照）：SHCreateItemFromParsingName → BHID_SFUIObject（条目菜单）===");
        println!("  路径: {desktop_dir}");
        match (|| -> Result<(), String> {
            let wide = HSTRING::from(desktop_dir.as_str());
            let item: IShellItem = SHCreateItemFromParsingName(&wide, None)
                .map_err(|e| format!("拿不到 shell 对象：{e}"))?;
            let menu: IContextMenu = item
                .BindToHandler(None, &BHID_SFUIObject)
                .map_err(|e| format!("没有右键菜单：{e}"))?;
            dump_menu(&menu, CMF_NORMAL | CMF_EXPLORE, "条目菜单")
        })() {
            Ok(()) => println!("  路线 B：OK"),
            Err(e) => println!("  路线 B 失败：{e}"),
        }

        println!();
        println!("判据：A1/A2 里必须出现「新建」与「粘贴」。出现 = 自己弹原生桌面空白菜单这条路成立。");
    }
}

/// 没传参数时的桌面目录兜底（不引入 dirs 依赖，够诊断用）。
fn dirs_fallback_desktop() -> String {
    std::env::var("USERPROFILE")
        .map(|p| format!("{p}\\Desktop"))
        .unwrap_or_else(|_| "C:\\Users\\Public\\Desktop".to_string())
}
