import type { ModuleMeta } from '@/core/types';
import { clipboardCommands } from './commands';

/**
 * 剪贴板增强（M4）模块元数据（V11：历史 UI + 内容识别 + 转便签）。
 *
 * 经 `import.meta.glob`（匹配各模块目录下的 index.ts）自动发现，无需在任何注册表登记。
 * 命令在 `./commands` 声明；面板内页经 `loadView` 惰性加载 `ClipboardHistory`
 * （未启用模块不加载其代码）。历史读写 / 监听在 V10 已落地（`core/data/clipboardService`
 * 与 `hooks/useClipboardWatch`）。
 */
const clipboardModule = {
  id: 'clipboard',
  name: '剪贴板',
  description: '剪贴板历史、内容识别与快速回贴',
  icon: 'ClipboardList',
  order: 30,
  surface: ['panel', 'overlay'],
  tier: 'free',
  keywords: ['剪贴板', '复制', '历史', '回贴', 'clipboard', 'clip', 'jtb', 'jtlq'],
  route: 'clipboard',
  capabilities: ['clipboard'],
  contributes: {
    commands: clipboardCommands,
  },
  loadView: () => import('./ClipboardHistory'),
} satisfies ModuleMeta;

export default clipboardModule;
