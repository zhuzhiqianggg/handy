import type { CommandMeta } from '@/core/types';

/**
 * 桌面整理（M2）命令清单（V12）。
 *
 * - 「桌面整理」：视图式命令（`load`）——规则选择 → 预览（可勾选排除）→
 *   二次确认应用 → 撤销 → 历史计划。
 */
export const desktopOrganizerCommands: CommandMeta[] = [
  {
    id: 'desktop-organizer',
    moduleId: 'desktop-organizer',
    name: '桌面整理',
    description: '一键归类桌面文件，支持预览与撤销',
    icon: 'FolderOpen',
    aliases: ['organize', 'clean desktop', 'tidy'],
    keywords: ['桌面', '整理', '归类', '文件', '清理', 'organize', 'zl', 'zhengli', 'zml'],
    layout: 'full',
    tier: 'free',
    load: () => import('../OrganizerView'),
  },
];
