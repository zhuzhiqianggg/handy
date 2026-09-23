//! 一次性诊断工具（不参与发布）：枚举某个路径的原生右键菜单项。
//!
//! 用途：V58 排查「为什么格子里右键没有 360压缩 / 重命名」。
//! `QueryContextMenu` 只填充菜单、**不弹出**，所以可以在无人值守下跑。
//!
//! 用法：
//!   cargo run --release --example menu_dump -- <路径> [flags...]
//!   flags 用十进制或 0x 前缀；不传则跑一组对照（0 / CMF_EXPLORE / 全量）。

use std::mem::size_of;

use windows::core::HSTRING;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::Shell::{
    IContextMenu, IShellItem, SHCreateItemFromParsingName, BHID_SFUIObject,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreatePopupMenu, DestroyMenu, GetMenuItemCount, GetMenuItemID, GetMenuStringW, GetSubMenu,
    MF_BYPOSITION,
};

/// Explorer 弹菜单时实际用的主要标志位（见 CMF_* 定义）
const CMF_NORMAL: u32 = 0x0000_0000;
const CMF_EXPLORE: u32 = 0x0000_0004;
const CMF_CANRENAME: u32 = 0x0000_0010;
const CMF_NODEFAULT: u32 = 0x0000_0020;
const CMF_EXTENDEDVERBS: u32 = 0x0000_0100;

fn dump(path: &str, flags: u32) -> Result<(), String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let wide = HSTRING::from(path);
        let item: IShellItem =
            SHCreateItemFromParsingName(&wide, None).map_err(|e| format!("拿不到 shell 对象：{e}"))?;
        let menu: IContextMenu = item
            .BindToHandler(None, &BHID_SFUIObject)
            .map_err(|e| format!("没有右键菜单：{e}"))?;
        let hmenu = CreatePopupMenu().map_err(|e| format!("CreatePopupMenu：{e}"))?;
        if let Err(e) = menu.QueryContextMenu(hmenu, 0, 1, 0x7FFF, flags) {
            let _ = DestroyMenu(hmenu);
            return Err(format!("QueryContextMenu：{e}"));
        }
        let count = GetMenuItemCount(hmenu);
        println!("  flags=0x{flags:04X}  菜单项 {count} 个");
        for i in 0..count {
            let mut buf = [0u16; 512];
            let len = GetMenuStringW(hmenu, i as u32, Some(&mut buf[..]), MF_BYPOSITION);
            if len > 0 {
                let text = String::from_utf16_lossy(&buf[..len as usize]);
                // 空文本 = 分隔线；顺带把命令 id 也打出来，便于对照
                let id = GetMenuItemID(hmenu, i);
                if text.trim().is_empty() {
                    println!("      --- (分隔线)");
                } else {
                    println!("      [{id}] {text}");
                }
                // 子菜单：QueryContextMenu 之后它就已经被填好了吗？
                // 若为空，说明该扩展靠 WM_INITMENUPOPUP 补项 —— 那就必须把它转发给
                // IContextMenu2/3，否则用户点开是个空壳。
                if id == u32::MAX {
                    let sub = GetSubMenu(hmenu, i);
                    let sub_count = GetMenuItemCount(sub);
                    println!("          └ 子菜单现有 {sub_count} 项");
                    for j in 0..sub_count.min(8) {
                        let mut sbuf = [0u16; 256];
                        let slen = GetMenuStringW(sub, j as u32, Some(&mut sbuf[..]), MF_BYPOSITION);
                        if slen > 0 {
                            let stext = String::from_utf16_lossy(&sbuf[..slen as usize]);
                            if !stext.trim().is_empty() {
                                println!("              · {stext}");
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
    if args.is_empty() {
        eprintln!("用法: menu_dump <路径> [flags...]");
        std::process::exit(2);
    }
    let path = &args[0];
    println!("路径: {path}");
    let mut cases: Vec<(u32, &str)> = Vec::new();
    if args.len() > 1 {
        for raw in &args[1..] {
            let v = if let Some(hex) = raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X")) {
                u32::from_str_radix(hex, 16).unwrap_or(0)
            } else {
                raw.parse::<u32>().unwrap_or(0)
            };
            cases.push((v, "命令行指定"));
        }
    } else {
        cases = vec![
            (0, "现状：一个 flag 都不传"),
            (CMF_NORMAL, "CMF_NORMAL"),
            (CMF_EXPLORE, "CMF_EXPLORE"),
            (
                CMF_NORMAL | CMF_EXPLORE | CMF_CANRENAME,
                "CMF_NORMAL|EXPLORE|CANRENAME（≈Explorer）",
            ),
            (
                CMF_NORMAL | CMF_EXPLORE | CMF_CANRENAME | CMF_NODEFAULT,
                "≈Explorer 但显式 NODEFAULT",
            ),
            (CMF_EXTENDEDVERBS, "CMF_EXTENDEDVERBS（Shift 右键）"),
        ];
    }
    for (flags, label) in cases {
        println!("-- {label}");
        if let Err(e) = dump(path, flags) {
            println!("      !! {e}");
        }
    }
}
