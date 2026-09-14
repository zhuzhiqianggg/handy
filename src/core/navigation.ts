import { useAppStore } from '@/stores/useAppStore';
import type { CommandProps } from '@/core/types';

/**
 * 主面板内导航（统一的视图切换入口）。
 *
 * 「最近使用」在命令视图挂载时集中记录（见 `CommandView`），因此本模块只负责切换视图。
 */

/** 打开命令（可携带初始输入与来源，如来自剪贴板建议）。 */
export function openCommand(
  commandId: string,
  opts?: { input?: string; source?: CommandProps['source'] },
): void {
  useAppStore.getState().setView({
    kind: 'command',
    commandId,
    ...(opts?.input !== undefined ? { input: opts.input } : {}),
    ...(opts?.source !== undefined ? { source: opts.source } : {}),
  });
}

/** 打开模块面板内页。 */
export function openModule(moduleId: string): void {
  useAppStore.getState().setView({ kind: 'module', moduleId });
}

/** 打开设置中心。 */
export function openSettings(): void {
  useAppStore.getState().setView({ kind: 'settings' });
}

/** 返回命令面板（默认视图）。 */
export function backToPalette(): void {
  useAppStore.getState().showPalette();
}
