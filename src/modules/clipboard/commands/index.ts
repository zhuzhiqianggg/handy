import type { CommandMeta } from '@/core/types';

/**
 * 剪贴板（M4）命令清单（V11）。
 *
 * - 「剪贴板历史」：视图式命令（`load`）——主面板内查看/搜索/置顶/回贴/删除/清空，
 *   以及内容识别（一键直达工具）与「转为便签」。
 *
 * 新增命令：在本数组追加一条 `CommandMeta` 即完成，**框架零改动**（ARCHITECTURE §4.3）。
 */
export const clipboardCommands: CommandMeta[] = [
  {
    id: 'clipboard-history',
    moduleId: 'clipboard',
    name: '剪贴板历史',
    description: '查看、搜索、置顶与回贴剪贴板历史',
    icon: 'ClipboardList',
    aliases: ['clipboard history', 'clip history', 'clip'],
    keywords: ['剪贴板', '历史', '复制', '回贴', '粘贴', 'clipboard', 'clip', 'jtb', 'jtlq', 'lishi'],
    layout: 'full',
    tier: 'free',
    load: () => import('../ClipboardHistory'),
  },
];
