"""把系统桌面图标视图恢复成可见 —— 装机前的安全兜底。

# 为什么需要它

Handy 的「接管桌面」会隐藏 `Progman` → `SHELLDLL_DefView` → `SysListView32`。
若在接管生效时**强制结束进程**（安装新版必须先停旧版，而 NSIS 无法覆盖被占用的
exe），`RunEvent::ExitRequested` / `Exit` 都不会触发，桌面就会留下一个
「应用没了、图标也没了」的空白桌面。

正常路径上不该发生（V44.2 已加双保险），但装机是**人为强杀**，绕过了优雅退出。
所以装机脚本停进程之后，用这个脚本把图标无条件恢复，保证交付瞬间桌面是正常的。

恢复后若用户重新启动 Handy，`restore_overlay_if_visible` 会按偏好重新接管 —— 行为一致。

# 用法

    python scripts/audit/desktop-icon-restore.py          # 恢复并打印结果
    python scripts/audit/desktop-icon-restore.py --dry    # 只看状态不改
"""

from __future__ import annotations

import ctypes
import sys
from ctypes import wintypes

u32 = ctypes.windll.user32

SW_SHOW = 5


def cls_of(hwnd: int) -> str:
    buf = ctypes.create_unicode_buffer(256)
    u32.GetClassNameW(wintypes.HWND(hwnd), buf, 256)
    return buf.value


def find_child(parent: int, cls: str) -> int:
    return u32.FindWindowExW(wintypes.HWND(parent), None, cls, None)


def find_top(cls: str) -> int:
    return u32.FindWindowW(cls, None)


def locate_icon_list() -> list[tuple[str, int, bool]]:
    """返回所有 (来源描述, SysListView32 句柄, 当前是否可见)。"""
    found: list[tuple[str, int, bool]] = []

    # 链 A：Progman → SHELLDLL_DefView → SysListView32（经典 / 部分 Win10）
    progman = find_top("Progman")
    if progman:
        dv = find_child(progman, "SHELLDLL_DefView")
        if dv:
            lv = find_child(dv, "SysListView32")
            if lv:
                found.append(("Progman/DefView", lv, bool(u32.IsWindowVisible(wintypes.HWND(lv)))))

    # 链 B：WorkerW → SHELLDLL_DefView → SysListView32（Win10/11 常见）
    worker = 0
    while True:
        worker = u32.FindWindowExW(wintypes.HWND(0), wintypes.HWND(worker), "WorkerW", None)
        if not worker:
            break
        dv = find_child(worker, "SHELLDLL_DefView")
        if dv:
            lv = find_child(dv, "SysListView32")
            if lv:
                found.append((f"WorkerW({worker:#x})/DefView", lv, bool(u32.IsWindowVisible(wintypes.HWND(lv)))))

    return found


def main() -> int:
    dry = "--dry" in sys.argv
    targets = locate_icon_list()
    if not targets:
        print("[restore] 未找到桌面图标视图（SysListView32）；无需处理")
        return 0

    for label, hwnd, visible in targets:
        if visible:
            print(f"[restore] {label} hwnd={hwnd:#x} 已可见，跳过")
            continue
        if dry:
            print(f"[restore] {label} hwnd={hwnd:#x} 隐藏中（--dry，不修改）")
            continue
        u32.ShowWindow(wintypes.HWND(hwnd), SW_SHOW)
        after = bool(u32.IsWindowVisible(wintypes.HWND(hwnd)))
        print(f"[restore] {label} hwnd={hwnd:#x} → ShowWindow(SW_SHOW) 可见={after}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
