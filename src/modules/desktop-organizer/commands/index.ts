import type { CommandMeta } from '@/core/types';

/**
 * 桌面整理模块的命令清单（V12；V25 改名避开与模块同名的歧义）。
 *
 * 「桌面文件归类」：视图式命令（`load`）—— 默认是**归拢到桌面格子**（只登记引用，
 * 文件原地不动）；切到「移动到整理目录」才走 规则选择 → 预览（可勾选排除）→
 * 二次确认应用（**真移动文件**到「桌面/Handy整理/类别/」）→ 一键撤销 → 历史计划。
 *
 * 为什么改名：模块叫「桌面整理」，而这条命令直接打开的是那个**会动文件**的视图
 * （`OrganizerView`，V37 起默认不动）。两者同名会让用户在命令面板里搜到「桌面整理」
 * 却不知道该点哪个 —— 名字上直接把「文件归类」这个动作点出来。
 */
export const desktopOrganizerCommands: CommandMeta[] = [
  {
    id: 'desktop-organizer',
    moduleId: 'desktop-organizer',
    name: '桌面文件归类',
    description: '把桌面文件按类型归拢进格子显示（不动文件）；也可显式选择移动到整理目录，可预览可撤销',
    icon: 'FolderOpen',
    aliases: ['organize', 'clean desktop', 'tidy', 'desktop files'],
    keywords: [
      '桌面',
      '整理',
      '归类',
      '文件归类',
      '移动文件',
      '清理',
      '撤销整理',
      'organize',
      'zl',
      'zhengli',
      'zml',
    ],
    layout: 'full',
    tier: 'free',
    load: () => import('../OrganizerView'),
  },
];
