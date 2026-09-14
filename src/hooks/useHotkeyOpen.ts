import { useEffect } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isTauri } from '@/platform/detect';

/** 快捷键呼出事件载荷（由 Rust `shortcut.rs` 广播） */
export interface HotkeyOpenPayload {
  /** 触发时间戳（毫秒） */
  at: number;
}

const HOTKEY_OPEN_EVENT = 'handy://hotkey-open';

/**
 * 订阅后端全局快捷键「呼出」事件。
 *
 * 触发时，Rust 已完成主窗显隐切换；前端在此聚焦并清空搜索框（命令面板 V05 接入）。
 * 非 Tauri 环境自动跳过，保证纯浏览器 dev 不报错。
 *
 * @param onOpen 呼出回调（调用方应使用 `useCallback` 保证引用稳定）
 */
export function useHotkeyOpen(onOpen: (payload: HotkeyOpenPayload) => void): void {
  useEffect(() => {
    if (!isTauri()) {
      return;
    }

    let disposed = false;
    let unlisten: UnlistenFn | undefined;

    void (async () => {
      try {
        const fn = await listen<HotkeyOpenPayload>(HOTKEY_OPEN_EVENT, (event) => {
          onOpen(event.payload);
        });
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      } catch {
        // 事件系统不可用时静默降级（例如宿主未就绪）
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [onOpen]);
}
