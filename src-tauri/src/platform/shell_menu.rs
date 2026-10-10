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
use std::path::Path;

use windows::core::{HSTRING, Interface, PCSTR, PWSTR, w};
use windows::Win32::Foundation::{
    ERROR_NO_MORE_ITEMS, ERROR_SUCCESS, HWND, LPARAM, LRESULT, POINT, WPARAM,
};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
use windows::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CLASSES_ROOT,
    KEY_READ, REG_BINARY, REG_EXPAND_SZ, REG_SZ, REG_VALUE_TYPE,
};
use windows::Win32::UI::Shell::{
    IContextMenu, IContextMenu2, IContextMenu3, IShellFolder, IShellItem,
    SHCreateItemFromParsingName, SHGetDesktopFolder, BHID_SFUIObject, CMINVOKECOMMANDINFO,
};
use windows::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CallWindowProcW, CreatePopupMenu, DefWindowProcW, DeleteMenu, DestroyMenu,
    GetCursorPos, GetMenuItemCount, GetMenuStringW, InsertMenuW, GWLP_WNDPROC, HMENU, MF_BYPOSITION,
    MF_POPUP, MF_STRING, PostMessageW, SetForegroundWindow, SetWindowLongPtrW, TPM_LEFTALIGN,
    TPM_RETURNCMD, TPM_RIGHTBUTTON, TrackPopupMenuEx, WM_DRAWITEM, WM_INITMENUPOPUP,
    WM_MEASUREITEM, WM_MENUCHAR, WM_NULL, WNDPROC,
};

/// 我们注入到「桌面背景」菜单里的「新建」子菜单命令 id。
///
/// Shell 的 `QueryContextMenu` 只占用 `1..=0x7FFF`，所以挑 `0x9000+` 这一档，**绝不会**
/// 和 Shell 自己的命令 id 撞车，也方便 `run_menu` 在 `TrackPopupMenuEx` 返回后一眼认出
/// 「这是我们的新建项，不用走 `InvokeCommand`」。
const CMD_NEW_FOLDER: u32 = 0x9001;
const CMD_NEW_TEXT: u32 = 0x9002;

/// 我们「新建」项被点中后产出的结果，回传前端让它增量认领 + 原地改名。
///
/// V89：不再用 `grid:item-created` 事件（那条路在菜单还没弹时就被 V88 的 30ms 竞速
/// 判定为「没新建」触发整层刷新）。改为**命令直接返回** `Option<CreatedItem>`：
/// 菜单收起后前端立刻拿到「建了什么」，建了就走增量路径、没建（普通菜单项）就走对账路径。
#[derive(Clone, serde::Serialize)]
pub struct CreatedItem {
    /// 新建项的完整路径（桌面用户目录 + 显示名）。
    pub path: String,
    /// 显示名（含扩展名，如 `新建文件夹`、`新建文本文档.txt`）。
    pub name: String,
}

/// RAII 守卫：构造时置「我们自己的菜单正在弹」为真，析构时复位。
///
/// 由 `run_menu` 在弹菜单前创建、随函数返回（含早退 / 出错）自动析构。它驱动
/// `crate::platform::desktop_handoff` 在菜单期间**禁止**把桌面借给系统 —— 否则就会出现
/// 「我们的菜单一弹，桌面瞬态翻白成原生样式」的观感（用户 10-08 报障）。这是「桌面永不翻白」
/// 的最后一道保险：即便事件 / 轮询误判出「桌面菜单」，也不会在我们自己菜单期间借出。
struct OwnMenuGuard;
impl OwnMenuGuard {
    fn new() -> Self {
        crate::platform::desktop_handoff::set_own_menu_active(true);
        OwnMenuGuard
    }
}
impl Drop for OwnMenuGuard {
    fn drop(&mut self) {
        crate::platform::desktop_handoff::set_own_menu_active(false);
    }
}

/// 桌面用户目录（新建项落地的目标）。复用 `dirs` crate（与 `grid.rs::desktop_root` 同口径）。
fn desktop_user_root() -> Option<std::path::PathBuf> {
    dirs::desktop_dir()
}

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
/// 返回 `Ok(None)` 只代表「菜单已经弹过并收回了」；用户在菜单里做了什么由 Shell 自己完成，
/// 我们不需要也不该插手（删除 / 复制 / 属性面板都不是我们的职责）。条目菜单不注入「新建」，
/// 所以这里永远返回 `Ok(None)`（后者供桌面背景菜单复用同一套 `run_menu` 后端）。
pub fn show_context_menu(hwnd: HWND, path: &str, extended: bool) -> Result<Option<CreatedItem>, String> {
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
        // 条目菜单不带「新建」（那是桌面背景菜单才有的能力）
        run_menu(hwnd, &menu, extended, false)
    }
}

/// 在**当前光标位置**弹出「桌面**背景**」的原生右键菜单（V87）。
///
/// # 为什么必须有这个（用户 10-08 的架构质疑）
///
/// 用户原话：「我们只是把桌面上的图标整理移动到整齐的位置上，你现在是直接把桌面完全
/// 改掉了呢？新建文件夹 / 新建文本文档等右键功能都不是原生的，问题很多」。
///
/// 之前（V81/V82/V84/V86）的做法是**借出**：右键时把被我们隐藏的 `SysListView32` 显示
/// 回来，让 Explorer 自己去弹菜单、自己去建文件，我们再收回。那是**补丁**——要赌
/// `#32768` 的语义（Win11 25H2 的新式菜单根本不是这个类名）、要等「安静 1.5s」、
/// 要 120s 超时兜底，而用户看到的仍然是「卡一下、要刷新、只有第一次成功」。
///
/// 正确的做法：**我们自己把那张菜单弹出来**。桌面空白右键的菜单不是「桌面的菜单」，
/// 是**桌面文件夹的背景菜单**，只有
/// `IShellFolder::CreateViewObject(IID_IContextMenu)` 给得出 —— `menu_dump` 那条
/// `BindToHandler(BHID_SFUIObject)` 的路拿到的是**条目**菜单（打开/复制/属性），
/// **压根没有「新建」**（实测见 `examples/bg_menu_dump.rs`：36 项里没有新建）。
///
/// 实测（A1 路线）这张菜单 16 项，含「新建(&W)」「下一个桌面背景」「显示设置」
/// 「个性化」，以及我们注入的「Handy 桌面整理」子菜单与全部第三方扩展。
///
/// # 一个必须说清的边界
///
/// 「查看 / 排序方式 / 刷新」**不在** `IContextMenu` 里 —— 那是 `DefView` 的
/// `IShellView` 视图菜单。所以这张菜单不给它们，需要时得由我们自己提供（见 V87-D）。
///
/// # V88：亲手把「新建」做成本地等价项（用户 10-08 报障）
///
/// 这张菜单的「新建」是 Shell 的 `CNewMenu`，它要靠 `IShellView` 才能定位目标目录并
/// 进入改名框 —— 而我们用 `CreateViewObject` 拿到的只是**没有真实 view 的** view-object
/// 菜单，所以用户点「新建 → 文件夹」时线上会报 `E_FAIL (0x80004005)`（见日志
/// `桌面背景菜单失败：执行菜单命令失败：未指定的错误`）。
///
/// 不跟 `IShellView` 死磕（那需要给一个真实宿主窗口、且在不同 Windows 版本上行为不稳定），
/// 而是**自己注入一个「新建」子菜单**：文件夹 / 文本文档。点下去时由我们在桌面用户目录
/// 里按 Windows 的命名规则（`新建文件夹` → `新建文件夹 (2)`…）建好**真实**目录 / 文件，
/// 并把 `CreatedItem` 作为命令返回值带回到前端（V89：不再是 `grid:item-created` 事件——那条路
/// 在菜单还没弹时就已被 30ms 竞速误判为「没新建」触发整层刷新）——前端据此增量认领并进入
/// 原地改名，结果和 Explorer 完全一致，且不依赖任何 Shell 视图黑盒。这同时消掉了
/// 「新建报错 / 卡 / 整体刷新」三个子投诉（V88），并把「桌面翻白」也一并根除（V89）。
pub fn show_background_context_menu(
    hwnd: HWND,
    extended: bool,
) -> Result<Option<CreatedItem>, String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        // 桌面**根** IShellFolder 自己就是桌面视图（`SHGetDesktopFolder()` 的返回值）。
        //
        // ⚠️ 别再走 `SHGetKnownFolderIDList(FOLDERID_Desktop)` + `BindToObject`：
        // FOLDERID_Desktop 的 PIDL **就是命名空间根本身**，拿它去 BindToObject 根
        // 必然报 `E_INVALIDARG (0x80070057)`（实测，见 bg_menu_dump 的第一次输出）。
        let root: IShellFolder =
            SHGetDesktopFolder().map_err(|err| format!("拿不到桌面 shell 文件夹：{err}"))?;
        let menu: IContextMenu = root
            .CreateViewObject(None)
            .map_err(|err| format!("桌面没有背景菜单：{err}"))?;
        run_menu(hwnd, &menu, extended, true)
    }
}

// ——— V92：V90/V91 的「转发右键给 Explorer 桌面视图」整块已删除 ———
//
// 那套做法（WM_CONTEXTMENU + 「观测屏幕」判据）实测每次都弹出两个菜单，且因为转发前
// 调了 SetForegroundWindow(我们的窗口)，Shell 的 CNewMenu 找不到目标 IShellView ⇒
// 「新建」彻底建不出东西（用户 10-10 00:12 的反馈）。现在桌面空白右键改为**直接穿透**
// 给 Explorer（见 GridOverlay 根画布 pointerEvents），那张菜单天然带「查看/排序/刷新」
// 和完整 ShellNew「新建」，我们一行代理代码都不需要写。

/// V89：把 Shell 原生那个「新建」从菜单里**摘掉**，只留我们自己注入的那个。
///
/// # 为什么必须摘（用户 10-08「新建文件夹 / 文本文档都失效」的真凶）
///
/// 原生「新建」是 Shell 的 `CNewMenu`：它要靠 `IShellView` 定位目标目录并拉起改名框，
/// 而我们这张 `CreateViewObject` 出来的 view-object 菜单**没有真实 view**，点下去必然
/// `E_FAIL (0x80004005)` —— 日志里那两条
/// `桌面背景菜单失败：执行菜单命令失败：未指定的错误 (0x80004005)` 就是它。
///
/// V88 只做「注入」，于是菜单顶上出现**两个同名**「新建(&W)」：一个是我们那个一定成的，
/// 一个是原生那个必报错的。用户随手一点就有一半概率踩到后者 —— 看到的就是「新建失效」。
///
/// 所以 V89 改成「**先摘后插**」：名字里带「新建 / New」的顶层项一律删除，再插入我们的。
/// 菜单里于是只剩一个「新建」，点它一定在桌面目录里真的建出文件 / 目录。
///
/// 只动**顶层**：子菜单里的项不在这层，误删的代价远大于收益。
unsafe fn strip_native_new_menu(hmenu: HMENU) {
    let count = GetMenuItemCount(hmenu);
    if count <= 0 {
        return;
    }
    // 倒序遍历：`DeleteMenu(MF_BYPOSITION)` 会让后面的项前移，正序会漏掉（每删一个就跳一个）。
    for pos in (0..count).rev() {
        let mut buf = [0u16; 128];
        let len = GetMenuStringW(hmenu, pos as u32, Some(&mut buf), MF_BYPOSITION);
        if len <= 0 {
            continue;
        }
        let text = String::from_utf16_lossy(&buf[..(len as usize).min(buf.len())]);
        // 中文「新建(&W)」；英文「&New」/「New」。只认开头，避免误伤
        // 「下一个桌面背景 / Next desktop background」这类含 new 的其它项。
        let is_new = text.contains("新建")
            || text.starts_with("&New")
            || text.starts_with("New")
            || text.starts_with("&new");
        if !is_new {
            continue;
        }
        let _ = DeleteMenu(hmenu, pos as u32, MF_BYPOSITION);
        crate::logging::write_line(
            "grid",
            &format!("桌面背景菜单：摘掉原生「新建」项（第 {pos} 项，文本「{text}」）— 它在无 view 的菜单里必然 E_FAIL"),
        );
    }
}

/// 弹出一张**已经拿到手**的 `IContextMenu`（`show_context_menu` /
/// [`show_background_context_menu`] 的公共后端）。
///
/// 抽取出来是因为两条路的差别**只在怎么拿到 `IContextMenu`**，后面
/// 「cast 2/3 → 建菜单 → 填充 → 子类化 → 弹出 → 收尾 → 执行命令」完全一致，
/// 而且这段里有 `SetWindowLongPtrW` / `TrackPopupMenuEx` 这种**错一步就整套失效**
/// 的时序，绝不该抄两遍。
///
/// - `inject_new`：只有桌面背景菜单才注入「新建」子菜单（见 V88），条目菜单不注入。
///
/// 返回 `Ok(Some(CreatedItem))` 表示用户点了我们注入的「新建」项（已建好真实文件 / 目录，
/// 调用方拿去增量认领 + 原地改名）；`Ok(None)` 表示菜单正常收起但没新建（普通菜单项 / 取消）。
/// 不再用事件广播：命令直接把结果带回前端，彻底消掉 V88「菜单没弹就 30ms 竞速判没新建、
/// 触发整层刷新」的残留 bug。
fn run_menu(
    hwnd: HWND,
    menu: &IContextMenu,
    extended: bool,
    inject_new: bool,
) -> Result<Option<CreatedItem>, String> {
    // 菜单期间标记「我们自己的菜单在弹」，禁止 desktop_handoff 把桌面借给系统（V89）。
    let _guard = OwnMenuGuard::new();
    unsafe {
        // 我们注入的「新建」子菜单句柄（没有则不注入），teardown 时一并销毁。
        let mut new_sub: Option<windows::Win32::UI::WindowsAndMessaging::HMENU> = None;

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

        // —— V88：注入我们自己的「新建」子菜单（仅在桌面背景菜单）——
        // 原生「新建」依赖 IShellView，在我们这套 view-object 菜单里会 E_FAIL，所以亲手做。
        // 放在最顶上，和原生项区分开；命令 id 用 0x9000+ 档，绝不与 Shell 的 1..=0x7FFF 撞车。
        if inject_new {
            // —— V89：先摘掉原生那个必然 E_FAIL 的「新建」，再插我们自己的 ——
            // 否则菜单顶上会有两个同名「新建」，用户点中原生那个就报「未指定的错误」，
            // 观感就是「新建失效」（详见 strip_native_new_menu 的文档）。
            strip_native_new_menu(hmenu);
            match CreatePopupMenu() {
                Ok(sub) => {
                    let _ = AppendMenuW(
                        sub,
                        MF_STRING,
                        CMD_NEW_FOLDER as usize,
                        PWSTR(w!("新建文件夹").as_ptr() as *mut u16),
                    );
                    let _ = AppendMenuW(
                        sub,
                        MF_STRING,
                        CMD_NEW_TEXT as usize,
                        PWSTR(w!("新建文本文档").as_ptr() as *mut u16),
                    );
                    // 插到菜单顶部（位置 0）。MF_POPUP 的 uIDNewItem 是子菜单句柄本身。
                    let inserted = InsertMenuW(
                        hmenu,
                        0,
                        MF_BYPOSITION | MF_POPUP | MF_STRING,
                        sub.0 as usize,
                        PWSTR(w!("新建(&W)").as_ptr() as *mut u16),
                    );
                    if inserted.is_err() {
                        crate::logging::write_line(
                            "grid",
                            "桌面背景菜单：插入「新建」子菜单失败，本次菜单不会有可用新建项",
                        );
                    }
                    new_sub = Some(sub);
                }
                Err(err) => crate::logging::write_line(
                    "grid",
                    &format!("桌面背景菜单：注入「新建」子菜单失败：{err}"),
                ),
            }
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
        // 我们注入的子菜单也要销毁，避免句柄泄漏
        if let Some(sub) = new_sub {
            let _ = DestroyMenu(sub);
        }

        let cmd = picked.0;
        // 诊断留痕：用户再报「新建失效」时，一眼能看出他点的到底是哪个命令
        // （0 = 取消 / 0x9001 = 我们的新建文件夹 / 0x9002 = 我们的新建文本文档 / 其它 = 原生项）。
        crate::logging::write_line(
            "grid",
            &format!("桌面背景菜单已收起：命令 id={cmd:#x}（0=取消，0x9001/0x9002=我们的新建）"),
        );
        // —— V88/V89：我们自己的「新建」项，不走 InvokeCommand（那条路径对 view-object 菜单会 E_FAIL）——
        // 直接建真实文件 / 目录，把结果带回前端（V89 改为返回值而非事件，避免 30ms 竞速误判）。
        if (cmd as u32) == CMD_NEW_FOLDER {
            return Ok(create_new_item("folder"));
        }
        if (cmd as u32) == CMD_NEW_TEXT {
            return Ok(create_new_item("text"));
        }
        if cmd == 0 {
            // 用户点了菜单外面 / 按了 Esc
            return Ok(None);
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
    Ok(None)
}

/// 给「新建」项算一个不重名的名字（对齐 Explorer：`新建文件夹` → `新建文件夹 (2)` → …）。
///
/// `prefix` 是主名（如 `新建文件夹` / `新建文本文档`），`ext` 是扩展名（文件夹为空串、
/// 文本文档为 `.txt`）。返回的是**完整显示名**（含扩展名），调用方直接 `root.join(name)`。
fn unique_new_name(root: &Path, prefix: &str, ext: &str) -> String {
    let first = format!("{prefix}{ext}");
    if !root.join(&first).exists() {
        return first;
    }
    // 从 2 开始递增：Windows 的命名习惯是「新建文件夹」「新建文件夹 (2)」「新建文件夹 (3)」…
    let mut n = 2u32;
    loop {
        let candidate = format!("{prefix} ({n}){ext}");
        if !root.join(&candidate).exists() {
            return candidate;
        }
        n = n.saturating_add(1);
        if n > 9999 {
            // 极端情况兜底：加时间戳后缀，保证一定不重名（理论不会走到）。
            return format!("{prefix}_{}.{ext}", now_ms_placeholder());
        }
    }
}

/// 占位时间戳（仅在 9999 个重名这种极端场景下用，正常路径用不到）。
fn now_ms_placeholder() -> u64 {
    // 不引时间库，直接用系统启动滴答近似即可（仅兜底命名，无精度要求）。
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// V88/V89：在我们的「新建」项被点中时，真的在桌面用户目录里建好对应文件 / 目录。
///
/// 这一步**完全等价于** Explorer 的「新建文件夹 / 新建文本文档」——落地的就是真实目录 /
/// 文件，原生桌面（未接管时）照常能看到；接管态下则进入未归类竖条（前端拿到返回值后认领）。
///
/// V89 起改为**返回值** `Option<CreatedItem>`（不再向前端广播 `grid:item-created` 事件）：
/// 命令层把 `Option<CreatedItem>` 直接带回前端，前端据此决定「增量认领 + 原地改名」还是
/// 「全量对账」，彻底消掉 V88 那套「事件 + 30ms 竞速」在菜单还没弹时就误判「没新建」、
/// 触发整层刷新的残留 bug。
///
/// V97：`pub` —— 自绘桌面菜单的「新建」子项不再绕菜单（`run_menu`），命令
/// `desktop_create_new` 直接调这里，落盘路径与命名规则**与菜单路径一字不差**。
pub fn create_new_item(kind: &str) -> Option<CreatedItem> {
    let root = match desktop_user_root() {
        Some(dir) => dir,
        None => {
            crate::logging::write_line("grid", "新建失败：定位不到桌面用户目录");
            return None;
        }
    };
    let (prefix, ext) = match kind {
        "folder" => ("新建文件夹", ""),
        "text" => ("新建文本文档", ".txt"),
        _ => {
            crate::logging::write_line("grid", &format!("新建失败：不支持的类型 {kind}"));
            return None;
        }
    };
    let name = unique_new_name(&root, prefix, ext);
    let path = root.join(&name);

    let ok = match kind {
        "folder" => std::fs::create_dir(&path).is_ok(),
        "text" => std::fs::write(&path, &[] as &[u8]).is_ok(),
        _ => false,
    };
    if !ok {
        crate::logging::write_line("grid", &format!("新建失败：无法创建 {path:?}"));
        return None;
    }

    crate::logging::write_line("grid", &format!("桌面新建成功：{path:?}"));
    Some(CreatedItem {
        path: path.to_string_lossy().to_string(),
        name,
    })
}

// ————————————————————————————————————————————————————————————————
// V98：ShellNew「新建」模板 —— 注册表枚举 + 按模板落地。
//
// 原生菜单「新建」子菜单那一长串（DOCX 文档 / XLSX 工作表 / 360压缩 ZIP 文件…）
// 就是 Explorer 读注册表 `HKCR\<ext>\ShellNew` 生成的。V97 的自绘菜单只硬编码了
// 文件夹 / 文本文档，用户 10-10 报障「我各种新文件 excel 等各种都没有了哇」——
// 这里补全：枚举所有带 `ShellNew` 子键的扩展名，菜单显示名用 `SHGFI_TYPENAME`
// （与 Explorer 同源），落地按 ShellNew 的取值：NullFile / Data / FileName / Command。
// ————————————————————————————————————————————————————————————————

/// V98：一条「新建」模板（前端菜单行 + 落地参数）。
#[derive(Clone, serde::Serialize)]
pub struct ShellNewTemplate {
    /// 扩展名（含点，如 `.xlsx`）；`desktop_create_new` 靠它重新定位模板。
    pub ext: String,
    /// 菜单显示名（`SHGFI_TYPENAME`，与 Explorer 同源，如「XLSX 工作表」）。
    pub name: String,
    /// 前端取图标用的路径 —— **只借扩展名**，文件本身不需要存在
    /// （`shell_icon_handle` 对不存在的路径走 `SHGFI_USEFILEATTRIBUTES` 分支）。
    pub icon_path: String,
}

/// `ShellNew` 子键下 Explorer 认的四种取值。
#[derive(Default)]
struct ShellNewValues {
    null_file: bool,
    data: Option<Vec<u8>>,
    file_name: Option<String>,
    command: Option<String>,
}

/// 打开一个只读注册表键；失败返回 `None`。
///
/// # SAFETY
/// 调用方负责用 `RegCloseKey` 关闭返回的句柄。
unsafe fn reg_open_read(parent: HKEY, sub: &str) -> Option<HKEY> {
    use windows::core::PCWSTR;
    let wide: Vec<u16> = sub.encode_utf16().chain(std::iter::once(0)).collect();
    let mut key = HKEY::default();
    let err = RegOpenKeyExW(parent, PCWSTR(wide.as_ptr()), 0, KEY_READ, &mut key);
    if err != ERROR_SUCCESS {
        return None;
    }
    Some(key)
}

/// 判断 `parent` 下是否存在名为 `sub` 的子键。
unsafe fn reg_subkey_exists(parent: HKEY, sub: &str) -> bool {
    match reg_open_read(parent, sub) {
        Some(key) => {
            let _ = RegCloseKey(key);
            true
        }
        None => false,
    }
}

/// 读一个 `REG_SZ` / `REG_EXPAND_SZ` 字符串值（不做环境变量展开 —— ShellNew 的
/// FileName 大多是字面路径；带 `%%` 的交给 `resolve_template_file` 逐个候选目录试）。
unsafe fn reg_string(key: HKEY, name: &str) -> Option<String> {
    use windows::core::PCWSTR;
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let mut ty = REG_VALUE_TYPE::default();
    let mut cb = 0u32;
    if RegQueryValueExW(key, PCWSTR(wide.as_ptr()), None, Some(&mut ty), None, Some(&mut cb))
        != ERROR_SUCCESS
    {
        return None;
    }
    if ty != REG_SZ && ty != REG_EXPAND_SZ {
        return None;
    }
    let mut buf = vec![0u8; cb.max(2) as usize];
    if RegQueryValueExW(key, PCWSTR(wide.as_ptr()), None, None, Some(buf.as_mut_ptr()), Some(&mut cb))
        != ERROR_SUCCESS
    {
        return None;
    }
    // UTF-16LE → String，遇到 NUL 截断
    let units: Vec<u16> = buf
        .chunks_exact(2)
        .take_while(|c| c[0] != 0 || c[1] != 0)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    let s = String::from_utf16_lossy(&units);
    if s.trim().is_empty() {
        None
    } else {
        Some(s)
    }
}

/// 读一个 `REG_BINARY` 值。
unsafe fn reg_binary(key: HKEY, name: &str) -> Option<Vec<u8>> {
    use windows::core::PCWSTR;
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let mut ty = REG_VALUE_TYPE::default();
    let mut cb = 0u32;
    if RegQueryValueExW(key, PCWSTR(wide.as_ptr()), None, Some(&mut ty), None, Some(&mut cb))
        != ERROR_SUCCESS
    {
        return None;
    }
    if ty != REG_BINARY || cb == 0 {
        return None;
    }
    let mut buf = vec![0u8; cb as usize];
    if RegQueryValueExW(key, PCWSTR(wide.as_ptr()), None, None, Some(buf.as_mut_ptr()), Some(&mut cb))
        != ERROR_SUCCESS
    {
        return None;
    }
    Some(buf)
}

/// 读一个 `ShellNew` 键的四种取值。
unsafe fn read_shell_new_values(key: HKEY) -> ShellNewValues {
    use windows::core::PCWSTR;
    let mut v = ShellNewValues::default();
    // NullFile 的存在性只看查询是否成功（值内容无所谓，类型也不限）
    let probe: Vec<u16> = "NullFile".encode_utf16().chain(std::iter::once(0)).collect();
    v.null_file =
        RegQueryValueExW(key, PCWSTR(probe.as_ptr()), None, None, None, None) == ERROR_SUCCESS;
    v.data = reg_binary(key, "Data");
    v.file_name = reg_string(key, "FileName");
    v.command = reg_string(key, "Command");
    v
}

/// `HKCR\<ext>`（或其默认 ProgID 下）的 `ShellNew` 键；两处都没有返回 `None`。
///
/// Explorer 两处都认：Office 一类写在 `.ext` 下，个别类型写在 ProgID 下。
unsafe fn open_shell_new_key(ext: &str) -> Option<HKEY> {
    let hkcr = reg_open_read(HKEY_CLASSES_ROOT, "")?;
    let result = (|| {
        let ext_key = reg_open_read(hkcr, ext)?;
        let direct = reg_open_read(ext_key, "ShellNew");
        let progid_default = reg_string(ext_key, "");
        let _ = RegCloseKey(ext_key);
        if let Some(key) = direct {
            return Some(key);
        }
        let progid = progid_default?;
        let progid_key = reg_open_read(hkcr, &progid)?;
        let sn = reg_open_read(progid_key, "ShellNew");
        if sn.is_none() {
            let _ = RegCloseKey(progid_key);
        }
        sn
    })();
    let _ = RegCloseKey(hkcr);
    result
}

/// 按扩展名取**本地化的类型名**（`SHGFI_TYPENAME | SHGFI_USEFILEATTRIBUTES`）——
/// 文件不需要存在，与 Explorer 菜单标签同源（「XLSX 工作表」「文本文档」…）。
fn shell_typename(ext: &str) -> Option<String> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
    use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_TYPENAME, SHGFI_USEFILEATTRIBUTES};
    let fake = format!("C:\\shellnew-probe{ext}");
    let wide: Vec<u16> = fake.encode_utf16().chain(std::iter::once(0)).collect();
    let mut sfi = SHFILEINFOW::default();
    let ok = unsafe {
        SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            FILE_ATTRIBUTE_NORMAL,
            Some(&mut sfi as *mut SHFILEINFOW as *mut _),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_TYPENAME | SHGFI_USEFILEATTRIBUTES,
        )
    };
    if ok == 0 {
        return None;
    }
    let len = sfi.szTypeName.iter().position(|&c| c == 0).unwrap_or(0);
    let s = String::from_utf16_lossy(&sfi.szTypeName[..len]).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// 枚举注册表里所有带 `ShellNew` 的扩展名（= 原生菜单「新建」子菜单的完整列表）。
///
/// `HKCR` 根键本身几万个键名，但 `RegEnumKeyExW` 逐个枚举 + 只对 `.` 开头的开键，
/// 实测量级毫秒级；命令层直接同步调用即可。
pub fn list_shell_new_templates() -> Vec<ShellNewTemplate> {
    let mut out = Vec::new();
    let mut seen_names = std::collections::HashSet::new();
    unsafe {
        let Some(hkcr) = reg_open_read(HKEY_CLASSES_ROOT, "") else {
            crate::logging::write_line("grid", "ShellNew 枚举失败：打不开 HKCR");
            return out;
        };
        let mut index = 0u32;
        loop {
            let mut buf = [0u16; 64];
            let mut len = buf.len() as u32;
            let err = RegEnumKeyExW(
                hkcr,
                index,
                PWSTR(buf.as_mut_ptr()),
                &mut len,
                None,
                PWSTR::null(),
                None,
                None,
            );
            index += 1;
            if err == ERROR_NO_MORE_ITEMS {
                break;
            }
            if err != ERROR_SUCCESS {
                continue;
            }
            let name = String::from_utf16_lossy(&buf[..len as usize]);
            // 只认形如 `.docx` 的扩展名键；`.lnk` 的「快捷方式」是向导不是模板，跳过
            if !name.starts_with('.') || name.len() < 2 || name == ".lnk" {
                continue;
            }
            let Some(values_key) = open_shell_new_key(&name) else {
                continue;
            };
            let values = read_shell_new_values(values_key);
            let _ = RegCloseKey(values_key);
            // 四种取值一个都没有 ⇒ ShellNew 是空壳，Explorer 也不显示
            if !values.null_file
                && values.data.is_none()
                && values.file_name.is_none()
                && values.command.is_none()
            {
                continue;
            }
            let Some(typename) = shell_typename(&name) else {
                continue;
            };
            // 同名类型去重（.htm/.html 都是「HTML 文档」时只留先到的）
            if !seen_names.insert(typename.clone()) {
                continue;
            }
            out.push(ShellNewTemplate {
                ext: name,
                name: typename,
                icon_path: String::new(), // 下面统一填
            });
        }
        let _ = RegCloseKey(hkcr);
    }
    for t in out.iter_mut() {
        t.icon_path = format!("C:\\shellnew-probe{}", t.ext);
    }
    out
}

/// 把 ShellNew 的 `FileName` 解析成一个真实存在的模板文件。
///
/// Explorer 的搜索顺序：绝对路径直接用；相对文件名依次找
/// `%SystemRoot%\ShellNew`、`%ALLUSERSPROFILE%\Microsoft\Windows\Templates`、
/// `%APPDATA%\Microsoft\Windows\Templates`。
fn resolve_template_file(file_name: &str) -> Option<std::path::PathBuf> {
    let p = std::path::Path::new(file_name);
    if p.is_absolute() {
        return if p.exists() { Some(p.to_path_buf()) } else { None };
    }
    let base = p.file_name()?.to_string_lossy().to_string();
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(win) = std::env::var("SystemRoot") {
        candidates.push(std::path::PathBuf::from(win).join("ShellNew").join(&base));
    }
    if let Ok(all) = std::env::var("ALLUSERSPROFILE") {
        candidates.push(
            std::path::PathBuf::from(all)
                .join("Microsoft")
                .join("Windows")
                .join("Templates")
                .join(&base),
        );
    }
    if let Ok(user) = std::env::var("APPDATA") {
        candidates.push(
            std::path::PathBuf::from(user)
                .join("Microsoft")
                .join("Windows")
                .join("Templates")
                .join(&base),
        );
    }
    candidates.into_iter().find(|c| c.exists())
}

/// 按 ShellNew 模板在桌面目录落地一个新文件（V98）。
///
/// 落地优先级与 Explorer 一致：`Data`（二进制模板）→ `FileName`（拷模板文件）→
/// 空文件（`NullFile` / `Command` / 其它）。`Command` 型在空文件落地后再执行一次
/// （`%1` 替换为新路径，如 360压缩 的 ZIP 模板），命令失败不影响已落地的空文件。
///
/// 命名规则与 [`create_new_item`] 同款：`新建{类型名}` → `新建{类型名} (2)` → …
/// （「文本文档」→ `新建文本文档.txt`，与原生一致）。
pub fn create_new_from_shell_new(ext: &str) -> Option<CreatedItem> {
    let Some(root) = desktop_user_root() else {
        crate::logging::write_line("grid", "ShellNew 新建失败：定位不到桌面用户目录");
        return None;
    };
    let values = unsafe {
        open_shell_new_key(ext).map(|key| {
            let v = read_shell_new_values(key);
            let _ = RegCloseKey(key);
            v
        })
    };
    let Some(values) = values else {
        crate::logging::write_line("grid", &format!("ShellNew 新建失败：{ext} 没有 ShellNew 键"));
        return None;
    };
    let typename = shell_typename(ext)
        .unwrap_or_else(|| ext.trim_start_matches('.').to_ascii_uppercase());
    let name = unique_new_name(&root, &format!("新建{typename}"), ext);
    let path = root.join(&name);

    let ok = if let Some(data) = &values.data {
        std::fs::write(&path, data).is_ok()
    } else if let Some(src) = values.file_name.as_deref().and_then(resolve_template_file) {
        std::fs::copy(&src, &path).is_ok()
    } else {
        if std::fs::write(&path, &[] as &[u8]).is_err() {
            return None;
        }
        if let Some(cmd) = &values.command {
            let replaced = cmd.replace("%1", &path.to_string_lossy());
            let _ = std::process::Command::new("cmd").args(["/C", &replaced]).spawn();
        }
        true
    };
    if !ok {
        crate::logging::write_line("grid", &format!("ShellNew 新建失败：无法创建 {path:?}"));
        return None;
    }
    crate::logging::write_line("grid", &format!("ShellNew 新建成功：{path:?}（{ext}）"));
    Some(CreatedItem {
        path: path.to_string_lossy().to_string(),
        name,
    })
}
