import type { ModuleMeta } from '@/core/types';
import { desktopOrganizerCommands } from './commands';

/**
 * 桌面整理模块元数据。
 *
 * **注册策略（原地改名重定向，同 notes → 工作台）**：沿用模块 id `desktop-organizer`，
 * 命令、路由、启停状态、备份兼容均无需迁移。
 *
 * # V25：首屏换成 `DesktopOrganizerConsole`（两页签）
 *
 * 用户反馈「桌面整理还是在自己的框里面玩，没有正式操作系统桌面」。
 * 查证结论是**能力有、入口错**：
 *
 *   - **归类文件**（`OrganizerView` + Rust `organizer.rs`）会**真移动**桌面文件到
 *     「桌面/Handy整理/类别/」，同名校验、跳过隐藏与系统文件、按计划可逆序撤销
 *     —— 这就是「操作系统桌面整理」本身；
 *   - **桌面格子**（`GridManagerView` + Rust `grid.rs`）零磁盘副作用，只登记引用，
 *     在桌面上叠一层半透明格子层。
 *
 * V19 起首屏一直指向后者，于是「桌面整理」这个名字下用户看到的是「在自己的框里玩」。
 * 现在控制台把「归类文件」设为默认页签，格子降为第二页签并注明不动文件。
 */
const desktopOrganizerModule = {
  id: 'desktop-organizer',
  name: '桌面整理',
  description: '把桌面文件按类型 / 日期归进「桌面/Handy整理/」，可预览、可撤销；另有零风险的桌面格子层',
  icon: 'LayoutGrid',
  order: 40,
  surface: ['panel'],
  tier: 'free',
  keywords: [
    '桌面整理',
    '桌面归类',
    '文件归类',
    '一键整理',
    '自动整理',
    '移动文件',
    '撤销整理',
    '桌面挂件',
    '格子',
    '网格',
    '挂件',
    '备份布局',
    '还原布局',
    '图标',
    '快捷',
    '引用',
    'organize',
    'widget',
    'grid',
    'desktop',
    'zmzl',
    'gj',
  ],
  platforms: ['windows', 'macos'],
  capabilities: ['desktopFileOrganize'],
  route: 'desktop-organizer',
  contributes: {
    commands: desktopOrganizerCommands,
  },
  loadView: () => import('./DesktopOrganizerConsole'),
} satisfies ModuleMeta;

export default desktopOrganizerModule;
