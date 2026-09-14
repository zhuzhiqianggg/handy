import { useEffect, useRef } from 'react';
import { isTauri } from '@/platform/detect';
import { useAppStore } from '@/stores/useAppStore';
import { recordClipboardText } from '@/core/data/clipboardService';
import { ipc } from '@/lib/ipc';

/**
 * 剪贴板后台监听（M4 / V10）。
 *
 * **轮询实现**：tauri clipboard-manager 无变更事件，主窗口挂载后按 800ms 节流轮询；
 * 内容与上轮比对，**变化才落库**（+ DB 唯一索引 (kind, content) 双保险去重）。
 *
 * 读取路径（能力探测，失败粘性降级）：
 *   1. 优先 `navigator.clipboard.readText`（WebView 支持、有焦点时零成本）；
 *   2. 失败（后台无焦点常被拒）→ 粘性切换 Rust `clipboard_read_text` 命令
 *      （经平台抽象层 `platform::current().read_clipboard`）；
 *   3. 仍失败（如剪贴板为图片）→ 本轮跳过，不打断轮询。
 *
 * 开关：`settings.clipboardWatch = false` 时**完全停止**轮询（effect 清理）；
 * 重新开启后从当前剪贴板内容重新起始。仅 Tauri 宿主内生效；浏览器调试 no-op。
 *
 * 语义说明：挂载后**首轮即记录**当前剪贴板内容（用户可能在打开应用前刚复制过；
 * DB 唯一索引保证重复内容只刷新时序、不产生重复行）。
 */

/** 轮询间隔（毫秒） */
const POLL_INTERVAL_MS = 800;

/**
 * 读取剪贴板文本：JS 优先，失败粘性降级 Rust 命令。
 * @returns 文本；空 / 不可读返回 null
 */
let readerKind: 'js' | 'rust' | null = null;
async function readClipboardText(): Promise<string | null> {
  if (readerKind !== 'rust' && typeof navigator !== 'undefined') {
    const jsRead = navigator.clipboard?.readText?.bind(navigator.clipboard);
    if (typeof jsRead === 'function') {
      try {
        const text = await jsRead();
        readerKind = 'js';
        return text;
      } catch {
        // WebView 拒绝（无焦点 / 无权限）：本轮会话内粘性降级到 Rust 命令
        readerKind = 'rust';
      }
    }
  }
  try {
    const text = await ipc.clipboardReadText();
    readerKind = 'rust';
    return text;
  } catch {
    // 剪贴板为图片 / 系统级读取失败：本轮跳过
    return null;
  }
}

/**
 * 剪贴板监听 hook。
 * @param enabled 仅在主窗口传 true（便签等子窗口不轮询）；再叠加 settings.clipboardWatch 开关
 */
export function useClipboardWatch(enabled: boolean): void {
  // 订阅设置：关闭即完全停止轮询（effect 依赖变更触发清理）
  const clipboardWatch = useAppStore((state) => state.settings.clipboardWatch);

  useEffect(() => {
    if (!isTauri() || !enabled || !clipboardWatch) {
      return;
    }
    let disposed = false;
    let busy = false;
    let lastText: string | null = null;

    const tick = async (): Promise<void> => {
      if (disposed || busy) {
        return; // busy：上轮未结束（读取是异步 IO），跳过本轮防止堆叠
      }
      busy = true;
      try {
        const text = await readClipboardText();
        if (text === null || text.length === 0 || text === lastText) {
          return; // 空内容 / 与上轮相同：不写库
        }
        lastText = text;
        // 敏感内容在服务内判定并拒绝落库；去重（唯一索引）与裁剪在 Rust 侧
        await recordClipboardText(text);
      } catch (error: unknown) {
        console.error('[Handy] 剪贴板监听单轮失败（忽略，继续轮询）：', error);
      } finally {
        busy = false;
      }
    };

    void tick();
    const timer = window.setInterval(() => {
      void tick();
    }, POLL_INTERVAL_MS);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [enabled, clipboardWatch]);
}
