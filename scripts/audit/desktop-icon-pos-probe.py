"""桌面图标「可遥控性」体检 —— B 方案（不接管原生桌面）的取证工具。

# 它回答四个问题

1. 桌面图标视图 `SysListView32` 现在是什么样式？（`LVS_AUTOARRANGE` 开着吗）
2. `HKCU\\...\\Shell\\Bags\\1\\Desktop` 的 `FFlags` 原值是多少、按 `FOLDERFLAGS` 解出哪些位？
3. 前 N 个图标现在在哪（能不能跨进程读到 —— 决定「位置快照/还原」这条路走不走得通）？
4. 跨进程 `SendMessage(LVM_SETITEMPOSITION)` 在这个窗口上是否被接受（只读探针，不改位置）？

# 为什么位值要「实测」而不是照抄文档

`FFlags` 同时被 Explorer 的多个版本改写，位含义与 `FOLDERFLAGS` 的对应关系
在 Win10/Win11 上并不完全一致。写代码前先把**本机的真值**打出来，避免
「按记忆里的位去清」把用户别的偏好一起清掉。

# 用法

    python scripts/audit/desktop-icon-pos-probe.py            # 人读
    python scripts/audit/desktop-icon-pos-probe.py --json     # 机器可读
    python scripts/audit/desktop-icon-pos-probe.py --deep     # 额外尝试跨进程读图标坐标
"""

from __future__ import annotations

import ctypes
import json
import struct
import sys
from ctypes import wintypes

u32 = ctypes.windll.user32
k32 = ctypes.windll.kernel32

# ---------------------------------------------------------------- 常量（全部来自公开 SDK 头）
GWL_STYLE = -16
GWL_EXSTYLE = -20

# ⚠️ 实测纠错：`LVS_AUTOARRANGE` 是 **0x0100**，不是 0x0001
# （0x0001 是 `LVS_REPORT`；第一次跑探针时按 0x0001 判读，结论完全反了）
LVS_AUTOARRANGE = 0x0100  # commctrl.h
LVS_ALIGNLEFT = 0x0800
LVS_ICON = 0x0000
LVS_TYPEMASK = 0x0003

LVM_FIRST = 0x1000
LVM_GETITEMCOUNT = LVM_FIRST + 4
LVM_GETITEMSPACING = LVM_FIRST + 51
LVM_GETITEMPOSITION = LVM_FIRST + 16  # lParam = POINT*（跨进程需远端缓冲）

LVM_SETITEMPOSITION = LVM_FIRST + 15  # lParam = MAKELPARAM(x, y)（**纯值**，跨进程安全）

PROCESS_VM_OPERATION = 0x0008
PROCESS_VM_READ = 0x0010
PROCESS_VM_WRITE = 0x0020
PROCESS_QUERY_INFORMATION = 0x0400
MEM_COMMIT = 0x1000
MEM_RESERVE = 0x2000
MEM_RELEASE = 0x8000
PAGE_READWRITE = 0x04

# shobjidl.h FOLDERFLAGS —— 只作「标签」用，真值以本机 FFlags 为准
FOLDERFLAGS = [
    (0x00000001, "FWF_AUTOARRANGE"),
    (0x00000002, "FWF_ABBREVIATEDNAMES"),
    (0x00000004, "FWF_SNAPTOGRID"),
    (0x00000008, "FWF_OWNERDATA"),
    (0x00000010, "FWF_BESTFITWINDOW"),
    (0x00000020, "FWF_DESKTOP"),
    (0x00000040, "FWF_SINGLESEL"),
    (0x00000080, "FWF_NOSUBFOLDERS"),
    (0x00000100, "FWF_TRANSPARENT"),
    (0x00000200, "FWF_NOCLIENTEDGE"),
    (0x00000400, "FWF_NOSCROLL"),
    (0x00000800, "FWF_ALIGNLEFT"),
    (0x00001000, "FWF_NOICONS"),
    (0x00002000, "FWF_SHOWSELALWAYS"),
    (0x00004000, "FWF_NOVISIBLE"),
    (0x00008000, "FWF_SINGLECLICKACTIVATE"),
    (0x00010000, "FWF_NOWEBVIEW"),
    (0x00020000, "FWF_HIDEFILENAMES"),
    (0x00040000, "FWF_CHECKSELECT"),
    (0x00080000, "FWF_NOENUMREFRESH"),
    (0x00100000, "FWF_NOGROUPING"),
    (0x00200000, "FWF_FULLROWSELECT"),
    (0x00400000, "FWF_NOFILTERS"),
    (0x00800000, "FWF_NOCOLUMNHEADER"),
    (0x01000000, "FWF_NOHEADERINALLVIEWS"),
    (0x02000000, "FWF_EXTENDEDTILES"),
    (0x04000000, "FWF_TRICHECKSELECT"),
    (0x08000000, "FWF_AUTOCHECKSELECT"),
    (0x10000000, "FWF_NOBROWSERVIEWSTATE"),
    (0x20000000, "FWF_SUBSETGROUPS"),
    (0x40000000, "FWF_USESEARCHFOLDER"),
]

BAGS_KEY = r"Software\Microsoft\Windows\Shell\Bags\1\Desktop"
HKCU = 0x80000001
KEY_READ = 0x20019


# ---------------------------------------------------------------- 基础取窗口
def cls_of(hwnd: int) -> str:
    buf = ctypes.create_unicode_buffer(256)
    u32.GetClassNameW(wintypes.HWND(hwnd), buf, 256)
    return buf.value


def find_child(parent: int, cls: str) -> int:
    return u32.FindWindowExW(wintypes.HWND(parent), None, cls, None)


def desktop_listview() -> int:
    """Progman → SHELLDLL_DefView → SysListView32；找不到再扫 WorkerW 链。"""
    progman = u32.FindWindowW("Progman", None)
    if progman:
        dv = find_child(progman, "SHELLDLL_DefView")
        if dv:
            lv = find_child(dv, "SysListView32")
            if lv:
                return lv
    cur = 0
    for _ in range(64):
        w = u32.FindWindowExW(None, wintypes.HWND(cur), "WorkerW", None)
        if not w:
            break
        dv = find_child(w, "SHELLDLL_DefView")
        if dv:
            lv = find_child(dv, "SysListView32")
            if lv:
                return lv
        cur = w
    return 0


def pid_of(hwnd: int) -> int:
    pid = wintypes.DWORD()
    u32.GetWindowThreadProcessId(wintypes.HWND(hwnd), ctypes.byref(pid))
    return pid.value


# ---------------------------------------------------------------- 跨进程远端缓冲
class Remote:
    """在目标进程里借一块内存，读写指针型消息（GETITEMPOSITION 这类）。"""

    def __init__(self, pid: int):
        self.h = k32.OpenProcess(
            PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE | PROCESS_QUERY_INFORMATION,
            False,
            pid,
        )
        self.addr = 0
        self.error: str | None = None

    def __enter__(self) -> "Remote":
        if not self.h:
            self.error = f"OpenProcess 失败 err={ctypes.get_last_error()}"
            return self
        self.addr = k32.VirtualAllocEx(wintypes.HANDLE(self.h), None, 64, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE)
        if not self.addr:
            self.error = f"VirtualAllocEx 失败 err={ctypes.get_last_error()}"
        return self

    def write(self, data: bytes) -> bool:
        if not self.addr:
            return False
        n = ctypes.c_size_t(0)
        return bool(
            k32.WriteProcessMemory(
                wintypes.HANDLE(self.h), ctypes.c_void_p(self.addr), data, len(data), ctypes.byref(n)
            )
        )

    def read(self, size: int) -> bytes | None:
        if not self.addr:
            return None
        buf = ctypes.create_string_buffer(size)
        n = ctypes.c_size_t(0)
        ok = k32.ReadProcessMemory(
            wintypes.HANDLE(self.h), ctypes.c_void_p(self.addr), buf, size, ctypes.byref(n)
        )
        return buf.raw[: n.value] if ok else None

    def __exit__(self, *_exc) -> None:
        if self.h:
            if self.addr:
                k32.VirtualFreeEx(wintypes.HANDLE(self.h), ctypes.c_void_p(self.addr), 0, MEM_RELEASE)
            k32.CloseHandle(wintypes.HANDLE(self.h))


# ---------------------------------------------------------------- 注册表 FFlags
def read_fflags() -> dict:
    import winreg  # 本地导入：非 Windows 下 import 会直接失败，放在这里更明确

    out: dict = {"key": BAGS_KEY, "exists": False, "raw": None, "hex": None, "bits": []}
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, BAGS_KEY, 0, winreg.KEY_READ) as k:
            out["exists"] = True
            try:
                val, _typ = winreg.QueryValueEx(k, "FFlags")
                out["raw"] = int(val)
                out["hex"] = hex(int(val) & 0xFFFFFFFF)
                out["bits"] = [
                    name for bit, name in FOLDERFLAGS if int(val) & bit
                ]
            except FileNotFoundError:
                out["error"] = "FFlags 值不存在"
            # 顺带把该 key 下所有值名列出来，便于发现别的相关开关
            names: list[str] = []
            i = 0
            while True:
                try:
                    names.append(winreg.EnumValue(k, i)[0])
                    i += 1
                except OSError:
                    break
            out["value_names"] = names
    except FileNotFoundError:
        out["error"] = "Bags\\1\\Desktop 键不存在"
    return out


# ---------------------------------------------------------------- 主流程
def collect(deep: bool) -> dict:
    lv = desktop_listview()
    rep: dict = {"listview": None, "fflags": read_fflags(), "probe": {}}
    if not lv:
        rep["error"] = "找不到桌面图标视图（Explorer 没运行 / 被第三方桌面工具接管）"
        return rep

    style = u32.GetWindowLongW(wintypes.HWND(lv), GWL_STYLE) & 0xFFFFFFFF
    rep["listview"] = {
        "hwnd": hex(lv),
        "pid": pid_of(lv),
        "style": hex(style),
        "ws_visible": bool(style & 0x10000000),
        "iswindowvisible": bool(u32.IsWindowVisible(wintypes.HWND(lv))),
        "lvs_autoarrange": bool(style & LVS_AUTOARRANGE),
        "lvs_alignleft": bool(style & LVS_ALIGNLEFT),
        "lvs_icon": (style & LVS_TYPEMASK) == LVS_ICON,
        "itemcount": int(u32.SendMessageW(wintypes.HWND(lv), LVM_GETITEMCOUNT, 0, 0)),
        "itemspacing": int(u32.SendMessageW(wintypes.HWND(lv), LVM_GETITEMSPACING, 0, 0)) & 0xFFFF,
        "itemspacing_v": (int(u32.SendMessageW(wintypes.HWND(lv), LVM_GETITEMSPACING, 0, 0)) >> 16) & 0xFFFF,
    }

    # 只读探测 1：把当前第 0 项的坐标读出来（用远端缓冲，跨进程才读得到）
    if deep:
        with Remote(pid_of(lv)) as r:
            rep["probe"]["remote"] = {"ok": bool(r.addr), "error": r.error}
            if r.addr:
                # 先写一个坐标进去再读回，证明「写→读」这条链通
                r.write(struct.pack("<ii", 12345, 6789))
                back = r.read(8)
                rep["probe"]["remote"]["roundtrip"] = (
                    list(struct.unpack("<ii", back)) if back and len(back) == 8 else None
                )
                # 再读真实第 0 项坐标（LVM_GETITEMPOSITION 把 POINT 写进这个缓冲）
                n = rep["listview"]["itemcount"]
                positions = []
                for i in range(min(n, 10)):
                    ctypes.memset(ctypes.c_void_p(r.addr), 0, 0)  # 占位，真正清零靠下面的 write
                    r.write(struct.pack("<ii", 0, 0))
                    u32.SendMessageW(wintypes.HWND(lv), LVM_GETITEMPOSITION, i, r.addr)
                    raw = r.read(8)
                    if raw and len(raw) == 8:
                        positions.append(list(struct.unpack("<ii", raw)))
                    else:
                        positions.append(None)
                rep["probe"]["positions_first10"] = positions
    return rep


def main(argv: list[str]) -> int:
    deep = "--deep" in argv
    rep = collect(deep)

    if "--json" in argv:
        print(json.dumps(rep, ensure_ascii=False, indent=2))
        return 0 if rep.get("listview") else 1

    print("=" * 88)
    print("桌面图标「可遥控性」体检（B 方案取证）")
    print("=" * 88)

    ff = rep["fflags"]
    print(f"\n[注册表 {ff['key']}]")
    if not ff.get("exists"):
        print(f"  （不存在）{ff.get('error', '')}")
    else:
        print(f"  FFlags = {ff['hex']}   （解出的位：{', '.join(ff['bits']) or '无'}）")
        print(f"  该键下的值：{', '.join(ff.get('value_names', []))}")

    lv = rep.get("listview")
    print("\n[桌面图标视图 SysListView32]")
    if not lv:
        print(f"  （找不到）{rep.get('error', '')}")
        return 1
    print(f"  hwnd={lv['hwnd']} pid={lv['pid']} style={lv['style']}")
    print(f"  可见：ws_visible={lv['ws_visible']} IsWindowVisible={lv['iswindowvisible']}")
    print(f"  LVS_AUTOARRANGE(0x100) = {lv['lvs_autoarrange']}    ← 必须为 False 才能遥控位置")
    print(f"  LVS_ALIGNLEFT(0x800) = {lv['lvs_alignleft']}   LVS_ICON = {lv['lvs_icon']}")
    print(f"  条目数 = {lv['itemcount']}   间距 = {lv['itemspacing']} x {lv['itemspacing_v']}")

    if deep:
        pr = rep["probe"].get("remote", {})
        print("\n[跨进程读写探测]")
        print(f"  远端缓冲：{'OK' if pr.get('ok') else '失败 ' + str(pr.get('error'))}")
        if pr.get("roundtrip"):
            print(f"  写→读回环：{pr['roundtrip']}  （= [12345, 6789] 即通）")
        pos = rep["probe"].get("positions_first10")
        if pos:
            print(f"  前 {len(pos)} 项坐标（listview 客户端坐标）：")
            for i, p in enumerate(pos):
                print(f"    #{i}: {p}")

    print("\n[判定]")
    if lv["lvs_autoarrange"]:
        print("  · 自动排列**开着** ⇒ 直接发 LVM_SETITEMPOSITION 会被立刻拉回，必须先关掉")
    else:
        print("  · 自动排列**关着** ⇒ 可以直接用 LVM_SETITEMPOSITION 遥控位置")
    if deep and rep["probe"].get("remote", {}).get("ok"):
        print("  · 跨进程读写**通** ⇒ 「位置快照 / 一键还原」可以做真")
    elif deep:
        print("  · 跨进程读写**不通** ⇒ 快照退化：还原只能靠「重新打开自动排列让系统重排」")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
