//! 桌面图标「遥控」—— B 方案（不接管原生桌面）的底层 Win32 封装。
//!
//! # 为什么有这个模块
//!
//! V30–V101 走的是「**隐藏** `SysListView32` + 自己画图标」这条路，于是要逐项复刻
//! Explorer 的 Z 序 / Win+D 存活 / 右键菜单 / 新建 / 改名 / 图标尺寸……每一项都没有
//! 公开接口，60 多个批次全耗在这上面（见 `docs/04-review/REVIEW-2026-10-10.md`）。
//!
//! B 方案反过来：**图标永远归 Explorer 画**，我们只做两件事 ——
//! **算坐标**、**把坐标发过去**。本模块就是「发过去」这一半。
//!
//! # 本机实测取证（不靠记忆猜，见 `scripts/audit/desktop-icon-pos-probe.py`）
//!
//! | 事实 | 值 | 意义 |
//! | --- | --- | --- |
//! | 桌面 `SysListView32` 样式 | `0x46003b40` | 含 `LVS_AUTOARRANGE(0x0100)` |
//! | 注册表 `FFlags` | `0x40200225` | 含 `FWF_AUTOARRANGE(0x1)` + `FWF_SNAPTOGRID(0x4)` |
//! | 图标间距 | `76 × 88`（`LVM_GETITEMSPACING`） | 摆位用它当格子尺寸 |
//! | 跨进程读写 | **通** | `OpenProcess`+`VirtualAllocEx`+`ReadProcessMemory` 全部成功 |
//!
//! ⚠️ 第一次跑探针时把 `LVS_AUTOARRANGE` 当成 `0x0001`（那是 `LVS_REPORT`），
//! 判定结论完全反了 —— 这就是「位值必须实测」的价值，别再用记忆里的值。
//!
//! # 两条写入路径，各有各的用
//!
//! | 路径 | 作用范围 | 何时用 |
//! | --- | --- | --- |
//! | `set_autoarrange`（改 `GWL_STYLE` 的 `LVS_AUTOARRANGE` 位） | **只影响当前运行的视图** | 每次都做 —— 立刻生效、零注册表副作用 |
//! | `write_folder_flags`（`Bags\1\Desktop\FFlags`） | **持久**（Explorer 重启后仍生效） | 首次启用时做一次，原值存进 `grid_meta` 供还原 |
//!
//! 只清 `GWL_STYLE` 的话，Explorer 一重启图标就被拉回自动排列；只写注册表的话，
//! 当前视图不会立刻重读。所以**两条都要**。
//!
//! # 坐标语义
//!
//! `LVM_SETITEMPOSITION` 的 `lParam` 装的是 **`MAKELPARAM(x, y)`**（两个 `i16`），
//! 是**纯值**、不是指针 —— 这正是它能跨进程用的原因（`LVM_GETITEMPOSITION` 要
//! 传 `POINT*`，就得借目标进程的内存，见 [`RemoteMem`]）。

use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};

/// `LVM_FIRST`（commctrl.h）
const LVM_FIRST: u32 = 0x1000;
const LVM_GETITEMCOUNT: u32 = LVM_FIRST + 4; // 0x1004
const LVM_SETITEMPOSITION: u32 = LVM_FIRST + 15; // 0x100F，lParam = MAKELPARAM(x, y)
const LVM_GETITEMPOSITION: u32 = LVM_FIRST + 16; // 0x1010，lParam = POINT*
const LVM_GETITEMSPACING: u32 = LVM_FIRST + 51; // 0x1033
const LVM_GETITEMTEXTW: u32 = LVM_FIRST + 115; // 0x1073，lParam = LVITEMW*

/// 视图层「对齐到网格」扩展样式位（commctrl.h 的 `LVS_EX_SNAPTOGRID`）。
///
/// ⚠️ 这个位**不是** `FFlags` 里的 `FWF_SNAPTOGRID`（那个是注册表偏好），它是当前运行
/// 视图的扩展样式 —— 两者互不相干，Explorer 会各自维护。真机实测（V102.9）把 `FFlags`
/// 清干净 + 关掉 `LVS_AUTOARRANGE` 之后，`LVM_SETITEMPOSITION` 发任意坐标**仍然**会在
/// 0.3s 内被吸到最近槽位，就是它在起作用。
pub const LVS_EX_SNAPTOGRID: u32 = 0x0000_8000;

/// `LVM_SETEXTENDEDLISTVIEWSTYLE`（= `LVM_FIRST + 54`）。
///
/// `wParam` = 要置的位，`lParam` = 要清的位（传 `0` 表示只置不清）。
const LVM_SETEXTENDEDLISTVIEWSTYLE: u32 = LVM_FIRST + 54; // 0x1036

/// `LVM_GETEXTENDEDLISTVIEWSTYLE`（= `LVM_FIRST + 55`）。
const LVM_GETEXTENDEDLISTVIEWSTYLE: u32 = LVM_FIRST + 55; // 0x1037

/// `LVIF_TEXT`：让 `LVM_GETITEMTEXTW` 回填 `pszText`。
const LVIF_TEXT: u32 = 0x0001;

/// `LVS_AUTOARRANGE`（commctrl.h）—— ⚠️ 是 **0x0100**，不是 0x0001（那是 `LVS_REPORT`）。
pub const LVS_AUTOARRANGE: u32 = 0x0100;

/// `FOLDERFLAGS` 里「自动排列」/「对齐到网格」两位（shobjidl.h），用于 `FFlags`。
pub const FLAG_AUTOARRANGE: u32 = 0x0000_0001;
pub const FLAG_SNAPTOGRID: u32 = 0x0000_0004;

/// 桌面图标视图的注册表 bag 路径（Explorer 把桌面图标偏好存在这里）。
const BAGS_SUBKEY: &str = r"Software\Microsoft\Windows\Shell\Bags\1\Desktop";
const FFLAGS_VALUE: &str = "FFlags";

/// 跨进程读 `POINT` / `LVITEMW` 用的远端缓冲尺寸（96B LVITEMW + 512B 文本，留余量）。
const REMOTE_BUF: usize = 1024;
const LVITEM_OFF: usize = 0;
const LVITEM_LEN: usize = 96;
const TEXT_OFF: usize = 128;
const TEXT_WCHARS: usize = 260;

// ─────────────────────────────────────────────────────────── 纯函数（可单测，无 Win32）

/// 把 `(x, y)` 打成 `MAKELPARAM` 的 32 位值（低 16 位 x、高 16 位 y）。
///
/// `i16` 截断是**消息本身就是这么定义的**：桌面坐标不可能超出 ±32767。
pub fn pack_point(x: i32, y: i32) -> u32 {
    ((y as u16 as u32) << 16) | (x as u16 as u32)
}

/// 拆回 `(x, y)`（探针/日志用）。
pub fn unpack_point(lparam: u32) -> (i32, i32) {
    let x = (lparam & 0xFFFF) as u16 as i16 as i32;
    let y = (lparam >> 16) as u16 as i16 as i32;
    (x, y)
}

/// 从 `FFlags` 里清掉「自动排列」与「对齐到网格」两位，其余位**原样保留**。
///
/// 实测 `0x40200225` 里还有 `FWF_DESKTOP` / `FWF_NOCLIENTEDGE` / `FWF_FULLROWSELECT` /
/// `FWF_USESEARCHFOLDER` —— 那些是用户别的偏好，**一个都不许动**。
pub fn flags_cleared(flags: u32) -> u32 {
    flags & !(FLAG_AUTOARRANGE | FLAG_SNAPTOGRID)
}

/// 判断 `FFlags` 里「自动排列」是否开着。
pub fn flags_autoarrange_on(flags: u32) -> bool {
    flags & FLAG_AUTOARRANGE != 0
}

// ─────────────────────────────────────────────────────────── 远端内存（跨进程读指针型消息）

#[cfg(target_os = "windows")]
struct RemoteMem {
    process: windows::Win32::Foundation::HANDLE,
    addr: *mut core::ffi::c_void,
}

#[cfg(target_os = "windows")]
impl RemoteMem {
    fn new(pid: u32) -> Result<Self, String> {
        use windows::Win32::System::Memory::{
            VirtualAllocEx, MEM_COMMIT, MEM_RESERVE, PAGE_READWRITE,
        };
        use windows::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_OPERATION, PROCESS_VM_READ,
            PROCESS_VM_WRITE,
        };
        // SAFETY: 只借一块读写内存，不做任何注入 / 代码执行。
        unsafe {
            let process = OpenProcess(
                PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE | PROCESS_QUERY_INFORMATION,
                false,
                pid,
            )
            .map_err(|err| format!("打开 Explorer 进程失败（跨进程读图标要用它）：{err}"))?;
            let addr = VirtualAllocEx(
                process,
                None,
                REMOTE_BUF,
                MEM_COMMIT | MEM_RESERVE,
                PAGE_READWRITE,
            );
            if addr.is_null() {
                let _ = windows::Win32::Foundation::CloseHandle(process);
                return Err("在 Explorer 进程里分配缓冲失败".to_string());
            }
            Ok(Self { process, addr })
        }
    }

    fn base(&self) -> u64 {
        self.addr as u64
    }

    fn write(&self, offset: usize, data: &[u8]) -> Result<(), String> {
        use windows::Win32::System::Diagnostics::Debug::WriteProcessMemory;
        let mut written = 0usize;
        // SAFETY: 目标地址来自本结构体自己 VirtualAllocEx 的块，长度不超过 REMOTE_BUF。
        let ok = unsafe {
            WriteProcessMemory(
                self.process,
                (self.base() + offset as u64) as *const core::ffi::c_void,
                data.as_ptr() as *const core::ffi::c_void,
                data.len(),
                Some(&mut written),
            )
        };
        if !ok.is_ok() || written != data.len() {
            return Err("写入 Explorer 进程缓冲失败".to_string());
        }
        Ok(())
    }

    fn read(&self, offset: usize, len: usize) -> Result<Vec<u8>, String> {
        use windows::Win32::System::Diagnostics::Debug::ReadProcessMemory;
        let mut buf = vec![0u8; len];
        let mut read = 0usize;
        // SAFETY: 同上，源地址与长度都在我们自己分配的块内。
        let ok = unsafe {
            ReadProcessMemory(
                self.process,
                (self.base() + offset as u64) as *const core::ffi::c_void,
                buf.as_mut_ptr() as *mut core::ffi::c_void,
                len,
                Some(&mut read),
            )
        };
        if !ok.is_ok() {
            return Err("从 Explorer 进程读取缓冲失败".to_string());
        }
        Ok(buf)
    }
}

#[cfg(target_os = "windows")]
impl Drop for RemoteMem {
    fn drop(&mut self) {
        use windows::Win32::System::Memory::{VirtualFreeEx, MEM_RELEASE};
        // SAFETY: addr 是本结构体 VirtualAllocEx 出来的，且只释放一次。
        unsafe {
            let _ = VirtualFreeEx(self.process, self.addr, 0, MEM_RELEASE);
            let _ = windows::Win32::Foundation::CloseHandle(self.process);
        }
    }
}

// ─────────────────────────────────────────────────────────── Win32 实现

#[cfg(target_os = "windows")]
mod imp {
    use super::*;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, GetWindowThreadProcessId, SendMessageTimeoutW, SetWindowLongPtrW,
        GWL_STYLE, SMTO_ABORTIFHUNG,
    };

    /// 发一条消息给桌面列表框，**带超时**（Explorer 忙时不能把我们自己挂死）。
    fn send(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> Option<usize> {
        let mut result = 0usize;
        let ok = unsafe {
            SendMessageTimeoutW(
                hwnd,
                msg,
                wparam,
                lparam,
                SMTO_ABORTIFHUNG,
                500,
                Some(&mut result),
            )
        };
        if ok.0 == 0 {
            None
        } else {
            Some(result)
        }
    }

    /// 桌面列表框所属进程（= explorer.exe）。
    fn window_pid(hwnd: HWND) -> Result<u32, String> {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        if pid == 0 {
            Err("拿不到桌面图标视图的进程号".to_string())
        } else {
            Ok(pid)
        }
    }

    /// 桌面列表框条目数。
    pub fn item_count(list: HWND) -> usize {
        send(list, LVM_GETITEMCOUNT, WPARAM(0), LPARAM(0)).unwrap_or(0)
    }

    /// 图标占位尺寸 `(宽, 高)`，来自 `LVM_GETITEMSPACING`（本机实测 76 × 88）。
    ///
    /// 摆位用它当「格子里的单元格尺寸」—— 这样图标之间才是 Explorer 自己的间距，
    /// 不会因为我们用了别的尺寸而互相挤。
    pub fn icon_spacing(list: HWND) -> (i32, i32) {
        let raw = send(list, LVM_GETITEMSPACING, WPARAM(0), LPARAM(0)).unwrap_or(0);
        let cx = (raw & 0xFFFF) as i32;
        let cy = ((raw >> 16) & 0xFFFF) as i32;
        if cx <= 0 || cy <= 0 {
            (76, 88)
        } else {
            (cx, cy)
        }
    }

    /// 桌面列表框当前所在的 DPI 缩放比（拿不到退 1.0）。
    ///
    /// 不经过 Tauri —— 这一层是纯 Win32 封装，调用方（`grid_icons`）自己算逻辑坐标，
    /// 这里只负责把「逻辑间距」换成「物理步长」。
    fn window_scale(hwnd: HWND) -> f64 {
        use windows::Win32::UI::HiDpi::{GetDpiForWindow, GetDpiForSystem};
        let dpi = unsafe {
            let d = GetDpiForWindow(hwnd);
            if d > 0 {
                d
            } else {
                GetDpiForSystem()
            }
        };
        if dpi > 0 {
            f64::from(dpi) / 96.0
        } else {
            1.0
        }
    }

    /// 当前运行的视图是否开着「自动排列」。
    pub fn autoarrange_on(list: HWND) -> bool {
        let style = unsafe { GetWindowLongPtrW(list, GWL_STYLE) } as u32;
        style & LVS_AUTOARRANGE != 0
    }

    /// 当前运行的视图是否开着「对齐到网格」（扩展样式 `LVS_EX_SNAPTOGRID`）。
    pub fn snap_to_grid_on(list: HWND) -> bool {
        let ext = send(
            list,
            LVM_GETEXTENDEDLISTVIEWSTYLE,
            WPARAM(0),
            LPARAM(0),
        )
        .unwrap_or(0) as u32;
        ext & LVS_EX_SNAPTOGRID != 0
    }

    /// 关掉「对齐到网格」（**只动当前运行的视图**，不写注册表）。
    ///
    /// 这是 [`snap_grid`] 能测出真实锚点的前提，也是「摆位能不能落到指定槽位」的前提。
    /// 返回关掉之后该位是否确实为 0。
    pub fn set_snap_to_grid(list: HWND, on: bool) -> bool {
        // wParam = 要置的位，lParam = 要清的位。
        let (set, clear) = if on {
            (LVS_EX_SNAPTOGRID, 0)
        } else {
            (0, LVS_EX_SNAPTOGRID)
        };
        let _ = send(
            list,
            LVM_SETEXTENDEDLISTVIEWSTYLE,
            WPARAM(set as usize),
            LPARAM(clear as isize),
        );
        snap_to_grid_on(list) == on
    }

    /// ★ **实测 Explorer 的吸附槽位网格**：返回 `((锚点 x, 锚点 y), (步长 x, 步长 y))`，
    /// 单位是**物理屏幕像素**（listview 客户区相对坐标）。
    ///
    /// # 为什么必须实测（V102.9 真机事故）
    ///
    /// 之前从「现有图标坐标 `mod` 步长」反推相位，得到 `(0, 5)`；而实测真值是 `(27, 2)`
    /// —— 每列偏 18 物理像素。**「所有槽位同相位」这个假设是错的**：图标坐标还含有一层
    /// 与槽位无关的偏移（图标自身对齐 / 文本布局），拿它 `mod` 只会得到一个看起来像相位、
    /// 其实毫无意义的数。
    ///
    /// 做法：挑**最后一个**图标，记下原位 → 把它写到 `(0, 0)` → 读回它被吸附到的坐标，
    /// 那就是锚点 → 再写到一个「偏一格」的坐标 → 读回来的差就是步长 → **复位**。
    ///
    /// 用「最后一个」是为了最不容易被用户看见（它通常在末尾），并且**无论成败都复位**。
    ///
    /// 任何一步失败都返回 `None`，调用方退回「按 `mod` 反推锚点」的老路（等价于关掉量化，
    /// 至少不比原来差）。
    pub fn snap_grid(list: HWND) -> Option<((i32, i32), (i32, i32))> {
        let count = item_count(list);
        if count == 0 {
            return None;
        }
        let index = count - 1;
        let before = positions(list).ok()?;
        let origin = *before.get(index)?;

        let read_pos = |idx: usize| -> Option<(i32, i32)> {
            let mem = RemoteMem::new(window_pid(list).ok()?).ok()?;
            mem.write(0, &[0u8; 8]).ok()?;
            send(
                list,
                LVM_GETITEMPOSITION,
                WPARAM(idx),
                LPARAM(mem.base() as isize),
            )?;
            let raw = mem.read(0, 8).ok()?;
            Some((
                i32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]),
                i32::from_le_bytes([raw[4], raw[5], raw[6], raw[7]]),
            ))
        };
        let place = |idx: usize, x: i32, y: i32| {
            let packed = pack_point(x, y);
            send(list, LVM_SETITEMPOSITION, WPARAM(idx), LPARAM(packed as isize))
        };

        // ① 写 (0,0) —— 读回来的就是锚点（Explorer 会把它吸到最近槽位，而 (0,0) 的最近槽位
        //    就是第一个槽位）。
        place(index, 0, 0);
        // 吸附要等一次刷新：Explorer 是在 `WM_TIMER` 里做这件事的（真机实测 0.3s 内完成）。
        std::thread::sleep(std::time::Duration::from_millis(400));
        let anchor = read_pos(index);

        // ② 写「锚点 + 一整个间距」—— 读回来的差才是真步长（间距是逻辑值，要乘 DPI）。
        let (step_x, step_y) = icon_spacing(list);
        let scale = window_scale(list);
        let probe = anchor.map(|(ax, ay)| {
            (
                ax + (f64::from(step_x) * scale).round().max(1.0) as i32,
                ay + (f64::from(step_y) * scale).round().max(1.0) as i32,
            )
        });
        if let Some((px, py)) = probe {
            place(index, px, py);
            std::thread::sleep(std::time::Duration::from_millis(400));
        }
        let second = read_pos(index);

        // ③ 复位（无论成败）—— 不能把一个实测用的探针留在用户桌面上。
        place(index, origin.0, origin.1);
        std::thread::sleep(std::time::Duration::from_millis(120));

        let (ax, ay) = anchor?;
        let (bx, by) = second?;
        // 第二次写入应落在「锚点 + 一个步长」上；差值就是实测步长。
        let dx = (bx - ax).abs();
        let dy = (by - ay).abs();
        let sx = if dx > 0 { dx } else { 0 };
        let sy = if dy > 0 { dy } else { 0 };
        if sx <= 0 && sy <= 0 {
            return None;
        }
        Some((
            (ax, ay),
            (
                if sx > 0 { sx } else { (f64::from(step_x) * scale).round() as i32 },
                if sy > 0 { sy } else { (f64::from(step_y) * scale).round() as i32 },
            ),
        ))
    }

    /// 关 / 开「自动排列」（**只动当前运行的视图**，不写注册表）。
    ///
    /// 开着的话，我们发过去的坐标会被立刻拉回 Explorer 自己的网格 —— 这是
    /// `LVM_SETITEMPOSITION` 能不能生效的**前提**。
    pub fn set_autoarrange(list: HWND, on: bool) -> bool {
        let style = unsafe { GetWindowLongPtrW(list, GWL_STYLE) } as u32;
        let next = if on {
            style | LVS_AUTOARRANGE
        } else {
            style & !LVS_AUTOARRANGE
        };
        if next == style {
            return style & LVS_AUTOARRANGE != 0;
        }
        unsafe { SetWindowLongPtrW(list, GWL_STYLE, next as isize) };
        let now = unsafe { GetWindowLongPtrW(list, GWL_STYLE) } as u32;
        now & LVS_AUTOARRANGE != 0
    }

    /// 读全部图标的当前坐标 `(x, y)`（**listview 客户区坐标**）。
    ///
    /// 走 `LVM_GETITEMPOSITION` + 目标进程内存 —— 这是「接管前快照」的实现基础。
    pub fn positions(list: HWND) -> Result<Vec<(i32, i32)>, String> {
        let count = item_count(list);
        if count == 0 {
            return Ok(Vec::new());
        }
        let mem = RemoteMem::new(window_pid(list)?)?;
        let mut out = Vec::with_capacity(count);
        for index in 0..count {
            mem.write(0, &[0u8; 8])?;
            send(
                list,
                LVM_GETITEMPOSITION,
                WPARAM(index),
                LPARAM(mem.base() as isize),
            );
            let raw = mem.read(0, 8)?;
            out.push((
                i32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]),
                i32::from_le_bytes([raw[4], raw[5], raw[6], raw[7]]),
            ));
        }
        Ok(out)
    }

    /// 读全部图标的显示名（与 [`positions`] 的下标一一对应）。
    ///
    /// 用 `LVM_GETITEMTEXTW` + 远端 `LVITEMW`。桌面上的显示名就是文件名
    /// （是否带扩展名取决于用户的「显示扩展名」偏好），所以调用方匹配路径时
    /// 应当**同时接受带扩展名与不带扩展名两种形式**。
    pub fn item_names(list: HWND) -> Result<Vec<String>, String> {
        let count = item_count(list);
        if count == 0 {
            return Ok(Vec::new());
        }
        let mem = RemoteMem::new(window_pid(list)?)?;
        let text_addr = mem.base() + TEXT_OFF as u64;
        let mut out = Vec::with_capacity(count);
        for index in 0..count {
            // LVITEMW（x64 布局）：mask@0 / iItem@4 / iSubItem@8 / pszText@24 / cchTextMax@32
            let mut item = [0u8; LVITEM_LEN];
            item[0..4].copy_from_slice(&LVIF_TEXT.to_le_bytes());
            item[4..8].copy_from_slice(&(index as i32).to_le_bytes());
            item[24..32].copy_from_slice(&text_addr.to_le_bytes());
            item[32..36].copy_from_slice(&(TEXT_WCHARS as i32).to_le_bytes());
            mem.write(LVITEM_OFF, &item)?;
            mem.write(TEXT_OFF, &vec![0u8; TEXT_WCHARS * 2])?;
            send(
                list,
                LVM_GETITEMTEXTW,
                WPARAM(index),
                LPARAM(mem.base() as isize),
            );
            let raw = mem.read(TEXT_OFF, TEXT_WCHARS * 2)?;
            let units: Vec<u16> = raw
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            let len = units.iter().position(|&c| c == 0).unwrap_or(units.len());
            out.push(String::from_utf16_lossy(&units[..len]));
        }
        Ok(out)
    }

    /// 批量摆位：`(下标, x, y)`。返回**成功条数**。
    pub fn set_positions(list: HWND, placements: &[(usize, i32, i32)]) -> usize {
        let mut ok = 0usize;
        for &(index, x, y) in placements {
            let packed = pack_point(x, y);
            if send(
                list,
                LVM_SETITEMPOSITION,
                WPARAM(index),
                LPARAM(packed as isize),
            )
            .is_some()
            {
                ok += 1;
            }
        }
        ok
    }

    // ── 注册表 FFlags ────────────────────────────────────────

    /// 读 `Bags\1\Desktop` 的 `FFlags`（不存在 / 读失败返回 `None`）。
    pub fn read_folder_flags() -> Option<u32> {
        use windows::Win32::System::Registry::{
            RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY_CURRENT_USER, KEY_READ, REG_DWORD,
        };
        let sub = wide(BAGS_SUBKEY);
        let mut key = Default::default();
        // SAFETY: 只读一个 DWORD，字符串活到调用结束。
        unsafe {
            if RegOpenKeyExW(
                HKEY_CURRENT_USER,
                windows::core::PCWSTR(sub.as_ptr()),
                0,
                KEY_READ,
                &mut key,
            )
            .is_err()
            {
                return None;
            }
            let name = wide(FFLAGS_VALUE);
            let mut kind = REG_DWORD;
            let mut buf = [0u8; 4];
            let mut len = 4u32;
            let rc = RegQueryValueExW(
                key,
                windows::core::PCWSTR(name.as_ptr()),
                None,
                Some(&mut kind),
                Some(buf.as_mut_ptr()),
                Some(&mut len),
            );
            let _ = RegCloseKey(key);
            if rc.is_err() || len < 4 {
                return None;
            }
            Some(u32::from_le_bytes(buf))
        }
    }

    /// 写回 `FFlags`（**先备份原值**，见 `grid_meta.fflags_backup`）。
    pub fn write_folder_flags(flags: u32) -> Result<(), String> {
        use windows::Win32::System::Registry::{
            RegCloseKey, RegOpenKeyExW, RegSetValueExW, HKEY_CURRENT_USER, KEY_SET_VALUE, REG_DWORD,
        };
        let sub = wide(BAGS_SUBKEY);
        let mut key = Default::default();
        // SAFETY: 只写一个 DWORD。
        unsafe {
            if RegOpenKeyExW(
                HKEY_CURRENT_USER,
                windows::core::PCWSTR(sub.as_ptr()),
                0,
                KEY_SET_VALUE,
                &mut key,
            )
            .is_err()
            {
                return Err("打开桌面 bag 注册表失败（可能被安全策略拦下）".to_string());
            }
            let name = wide(FFLAGS_VALUE);
            let bytes = flags.to_le_bytes();
            let rc = RegSetValueExW(
                key,
                windows::core::PCWSTR(name.as_ptr()),
                0,
                REG_DWORD,
                Some(&bytes),
            );
            let _ = RegCloseKey(key);
            if rc.is_err() {
                return Err("写入桌面 FFlags 失败".to_string());
            }
            Ok(())
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }
}

// ─────────────────────────────────────────────────────────── 非 Windows 桩

#[cfg(not(target_os = "windows"))]
mod imp {
    use windows::Win32::Foundation::HWND;
    pub fn item_count(_list: HWND) -> usize {
        0
    }
    pub fn icon_spacing(_list: HWND) -> (i32, i32) {
        (76, 88)
    }
    pub fn autoarrange_on(_list: HWND) -> bool {
        false
    }
    pub fn set_autoarrange(_list: HWND, _on: bool) -> bool {
        false
    }
    pub fn snap_to_grid_on(_list: HWND) -> bool {
        false
    }
    pub fn set_snap_to_grid(_list: HWND, _on: bool) -> bool {
        false
    }
    pub fn snap_grid(_list: HWND) -> Option<((i32, i32), (i32, i32))> {
        None
    }
    pub fn positions(_list: HWND) -> Result<Vec<(i32, i32)>, String> {
        Err("桌面图标遥控仅支持 Windows".to_string())
    }
    pub fn item_names(_list: HWND) -> Result<Vec<String>, String> {
        Err("桌面图标遥控仅支持 Windows".to_string())
    }
    pub fn set_positions(_list: HWND, _placements: &[(usize, i32, i32)]) -> usize {
        0
    }
    pub fn read_folder_flags() -> Option<u32> {
        None
    }
    pub fn write_folder_flags(_flags: u32) -> Result<(), String> {
        Err("桌面图标遥控仅支持 Windows".to_string())
    }
}

pub use imp::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_point_roundtrips_within_i16_range() {
        for (x, y) in [(0, 0), (1, 2), (95, 110), (32767, 32767), (-1, -1)] {
            assert_eq!(unpack_point(pack_point(x, y)), (x, y), "({x},{y}) 往返不一致");
        }
    }

    #[test]
    fn pack_point_matches_makelparam_bit_layout() {
        // MAKELPARAM(x, y) = (y << 16) | (x & 0xFFFF)
        assert_eq!(pack_point(0x1234, 0x5678), 0x5678_1234);
        assert_eq!(pack_point(95, 110), (110 << 16) | 95);
    }

    #[test]
    fn flags_cleared_only_touches_the_two_bits_we_own() {
        // 本机实测真值：0x40200225 = AUTOARRANGE + SNAPTOGRID + DESKTOP
        //                          + NOCLIENTEDGE + FULLROWSELECT + USESEARCHFOLDER
        let real = 0x4020_0225u32;
        let cleared = flags_cleared(real);
        assert!(!flags_autoarrange_on(cleared), "自动排列位必须被清掉");
        assert_eq!(cleared & FLAG_SNAPTOGRID, 0, "对齐到网格位必须被清掉");
        // 其余位一个都不能少
        assert_eq!(
            cleared,
            real & !0x5,
            "只许动 0x1|0x4 两位，别的偏好必须原样保留"
        );
        let others = real & !0x5;
        assert!(cleared == others && others != 0, "别的位不应被清空");
    }

    #[test]
    fn flags_autoarrange_detects_the_real_machine_value() {
        assert!(flags_autoarrange_on(0x4020_0225), "本机 FFlags 确实开着自动排列");
        assert!(!flags_autoarrange_on(0x4020_0220), "清掉 0x1 后应判为关");
    }
}
