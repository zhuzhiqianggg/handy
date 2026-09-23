//! Windows 原生 Shell 右键菜单（V43；V58 补保真度）。
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
//!
//! # V58 修的两个保真度缺陷（用户 09-21：「为什么我们的整理把桌面图标原始的右键行为改变了」）
//!
//! ## ① 菜单标志位
//!
//! V43 起一直传 `uFlags = 0`，而 Explorer 自己弹菜单传的是
//! `CMF_NORMAL | CMF_EXPLORE`（`CMF_CANRENAME` 视情况）。实测差异见 §测试；
//! 现在按 Explorer 的口径传。
//!
//! **刻意不传 `CMF_CANRENAME`**：Explorer 菜单里那条「重命名」**不是菜单命令**，而是
//! `DefView`（文件列表视图）自己实现的原位改名。我们这个宿主不是它的视图，传了
//! `CMF_CANRENAME` 只会让菜单长出一条**点了没反应**的项（甚至在看不见的列表上开一个
//! 隐藏编辑框）—— 那比"少一项"更坏。宁缺毋滥。
//!
//! ## ② 转发 `WM_INITMENUPOPUP` 等菜单消息（这条才是大头）
//!
//! Shell 与第三方扩展的**子菜单是懒加载**的：`QueryContextMenu` 时只放一个占位项，
//! 真正的内容在 `WM_INITMENUPOPUP` 里才补。原来的实现从不转发这个消息，于是
//! 实测（`cargo run --example menu_dump`）拿到的是：
//!
//! ```text
//! 发送到(&N)        └ 子菜单现有 1 项：蓝牙设备          ← 正常应有 压缩文件夹/邮件收件人/桌面快捷方式…
//! 包含到库中(&I)    └ 子菜单现有 1 项：正在检索库...      ← 占位文案直接露给用户看了
//! ```
//!
//! 修法是经典的 **窗口子类化**：菜单弹出期间把宿主窗口的 `WndProc` 换掉，
//! 拦住 `WM_INITMENUPOPUP` / `WM_DRAWITEM` / `WM_MEASUREITEM` / `WM_MENUCHAR`
//! 转给 `IContextMenu2::HandleMenuMsg` / `IContextMenu3::HandleMenuMsg2`，
//! 其余消息原样交回原 `WndProc`（我们只是旁听，不改宿主行为）。菜单收起即还原。
//!
//! # 测试
//!
//! `src-tauri/examples/menu_dump.rs`（诊断用，不参与发布）可以在**不弹菜单**的前提下
//! 枚举任意路径的菜单项与子菜单，用来对照 flags 差异：
//!
//! ```text
//! cargo run --release --example menu_dump -- "C:\某个\文件夹" 0x14
//! ```
//!
//! # 已知拿不到的项（不是本模块能修的）
//!
//! **360压缩**（`{9179176E-…}` / `360ZipExt64.dll`）只对**进程名是 `explorer.exe`** 的宿主
//! 生效：把同一个枚举工具复制成别的目录下的 `explorer.exe` 再跑，它的
//! 「用360压缩打开 / 解压到… / 解压到当前文件夹」四项立刻出现（40 项 → 45 项）。
//! 也就是说 `handy.exe` **不可能**通过 `IContextMenu` 拿到它 —— 换任何工具都一样。
//! 要真正拿到，只能让 explorer.exe 自己去弹菜单（本模块做不到，见 CONVENTIONS §31）。

use std::cell::RefCell;
use std::mem::size_of;

use windows::core::{HSTRING, Interface, PCSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::Shell::{
    IContextMenu, IContextMenu2, IContextMenu3, IShellItem, SHCreateItemFromParsingName,
    BHID_SFUIObject, CMINVOKECOMMANDINFO,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, CreatePopupMenu, DefWindowProcW, DestroyMenu, GetCursorPos, PostMessageW,
    SetForegroundWindow, SetWindowLongPtrW, TrackPopupMenuEx, GWLP_WNDPROC, TPM_LEFTALIGN,
    TPM_RETURNCMD, TPM_RIGHTBUTTON, WM_DRAWITEM, WM_INITMENUPOPUP, WM_MEASUREITEM, WM_MENUCHAR,
    WM_NULL, WNDPROC,
};

/// `CMF_NORMAL`：普通（非 Alt）调用，取值就是 0，写出来是为了语义清楚。
const CMF_NORMAL: u32 = 0x0000;
/// `CMF_EXPLORE`：告诉扩展「调用方是资源管理器」。Explorer 自己弹菜单一定带它。
const CMF_EXPLORE: u32 = 0x0004;
/// `CMF_EXTENDEDVERBS`：Shift + 右键的「扩展动词」（在此处打开 PowerShell 窗口 / 在新进程中打开…）。
const CMF_EXTENDEDVERBS: u32 = 0x0100;

/// 菜单弹出期间挂在宿主窗口上的上下文：原 `WndProc` + 可查询的 `IContextMenu2/3`。
///
/// 用 `thread_local` 而不是全局 `static`：`TrackPopupMenuEx` 是**同线程**模态循环，
/// 子类化窗口过程也一定在同一个线程里被调用，不需要 `Send`；而且 windows-rs 的
/// 接口对象不是 `Send`，放全局还得套锁。
struct MenuHook {
    old_proc: WNDPROC,
    menu2: Option<IContextMenu2>,
    menu3: Option<IContextMenu3>,
}

thread_local! {
    static MENU_HOOK: RefCell<Option<MenuHook>> = const { RefCell::new(None) };
}

/// 菜单期间替换宿主窗口过程：把菜单消息喂给 Shell 的 `IContextMenu2/3`，其余原样放行。
unsafe extern "system" fn menu_hook_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // 先把接口克隆出来、**立刻释放借用**：HandleMenuMsg 内部可能再抽消息（会重入到这里），
    // 持着 RefCell 借用去调外部代码 = 直接 panic。
    let (menu2, menu3, old_proc) = MENU_HOOK.with(|cell| {
        match cell.borrow().as_ref() {
            Some(hook) => (hook.menu2.clone(), hook.menu3.clone(), hook.old_proc),
            None => (None, None, None),
        }
    });

    match msg {
        WM_INITMENUPOPUP | WM_DRAWITEM | WM_MEASUREITEM => {
            // 这三条：转给 Shell（让它补项/量尺寸/画），**然后照常走宿主自己的处理**。
            if let Some(menu3) = menu3.as_ref() {
                let _ = menu3.HandleMenuMsg2(msg, wparam, lparam, None);
            } else if let Some(menu2) = menu2.as_ref() {
                let _ = menu2.HandleMenuMsg(msg, wparam, lparam);
            }
        }
        WM_MENUCHAR => {
            // 这条 Shell 要用**返回值**回话（选中项 / 动作），所以命中后必须自己 return，
            // 不能再落到宿主窗口过程去。
            if let Some(menu3) = menu3.as_ref() {
                let mut result = LRESULT(0);
                if menu3
                    .HandleMenuMsg2(msg, wparam, lparam, Some(&mut result))
                    .is_ok()
                {
                    return result;
                }
            }
        }
        _ => {}
    }

    if old_proc.is_some() {
        CallWindowProcW(old_proc, hwnd, msg, wparam, lparam)
    } else {
        // 理论上不会发生（没挂上钩时不会被调用）；真发生了也不能崩，退回默认处理。
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}

/// 在**当前光标位置**弹出 `path` 对应的系统原生右键菜单。
///
/// 坐标不从前端传：菜单该出现在鼠标那儿，`GetCursorPos` 是最不会算错的做法
/// （前端的 client 坐标要经过窗口偏移 / DPI 换算，反而容易错位）。
///
/// `extended` = true 时补 `CMF_EXTENDEDVERBS`，即 Explorer 里 **Shift + 右键** 那个
/// 「扩展菜单」（多出「在此处打开 PowerShell 窗口」等项）——用户按了 Shift，就该给他
/// 原生的扩展菜单，而不是我们自己的菜单。
///
/// 返回 `Ok(())` 只代表「菜单已经弹过并收回了」；用户在菜单里做了什么由 Shell 自己完成，
/// 我们不需要也不该插手（删除 / 复制 / 属性面板都不是我们的职责）。
pub fn show_context_menu(hwnd: HWND, path: &str, extended: bool) -> Result<(), String> {
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

        // 同一个对象上查 IContextMenu3 → IContextMenu2，目的是拿到 HandleMenuMsg(2)。
        // 拿不到也不致命：只是懒加载子菜单会缺项（V57 之前的行为）—— 但不许静默：
        // 用户报「发送到是空的」时，日志里得能看出是这一步没成。
        let menu3 = menu.cast::<IContextMenu3>().ok();
        let menu2 = menu.cast::<IContextMenu2>().ok();
        if menu3.is_none() && menu2.is_none() {
            crate::logging::write_line(
                "grid",
                "原生右键菜单：该对象不支持 IContextMenu2/3，懒加载子菜单会缺项",
            );
        }

        let hmenu = CreatePopupMenu().map_err(|err| format!("创建菜单失败：{err}"))?;

        let mut flags = CMF_NORMAL | CMF_EXPLORE;
        if extended {
            flags |= CMF_EXTENDEDVERBS;
        }

        // 1 起、0x7FFF 止：命令 id 由 Shell 填在这个区间里
        if let Err(err) = menu.QueryContextMenu(hmenu, 0, 1, 0x7FFF, flags) {
            let _ = DestroyMenu(hmenu);
            return Err(format!("填充菜单项失败：{err}"));
        }

        // 挂子类化（菜单收起后必须还原，见下方 teardown）
        // 函数指针 → 整数要分两步（直接 as usize 会触发 clippy::function_casts_as_integer）
        let hook_addr = menu_hook_proc as *const () as usize as isize;
        let old_raw = SetWindowLongPtrW(hwnd, GWLP_WNDPROC, hook_addr);
        if old_raw == 0 {
            // 换过程失败：不致命，退化成旧的「子菜单可能缺项」行为。
            // 但不许静默 —— 用户报「子菜单是空的」时，日志里得能看出是这一步没成。
            let _ = DestroyMenu(hmenu);
            crate::logging::write_line(
                "grid",
                "原生右键菜单：窗口子类化失败，子菜单可能缺项",
            );
        } else {
            MENU_HOOK.with(|cell| {
                *cell.borrow_mut() = Some(MenuHook {
                    old_proc: std::mem::transmute::<isize, WNDPROC>(old_raw),
                    menu2,
                    menu3,
                });
            });
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

        // —— teardown：先摘钩子再还原窗口过程，顺序不能反 ——
        MENU_HOOK.with(|cell| {
            *cell.borrow_mut() = None;
        });
        if old_raw != 0 {
            let _ = SetWindowLongPtrW(hwnd, GWLP_WNDPROC, old_raw);
        }
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
