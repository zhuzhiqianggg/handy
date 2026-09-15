import type { ModuleMeta } from '@/core/types';
import { desktopOrganizerCommands } from './commands';

/**
 * 桌面整理（原「桌面挂件」）模块元数据。
 *
 * **注册策略（原地改名重定向，同 notes → 工作台）**：沿用模块 id `desktop-organizer`，
 * 命令、路由、启停状态、备份兼容均无需迁移；`loadView` 指向
 * `../desktop-grid/GridManagerView`（内页已升级为**整理主控台**）。
 *
 * V19 重新对齐用户预期：要的不是「挂件」，而是**桌面整理工具**那套体验 ——
 * 一键把满屏图标按类型归置成格子、布局可备份可还原。格子条目仍是**文件引用**，
 * 文件本体绝不移动，所以「还原布局」只是换一套摆法，不涉及文件回迁。
 *
 * 格子层是独立透明窗（label `grid-overlay`），由 Rust `grid_overlay_show / hide`
 * 创建与压回桌面层，故 surface 收敛为 panel。
 */
const desktopOrganizerModule = {
  id: 'desktop-organizer',
  name: '桌面整理',
  description: '一键把桌面图标归置成格子，布局可备份还原；文件本体不动，双击打开原文件',
  icon: 'LayoutGrid',
  order: 40,
  surface: ['panel'],
  tier: 'free',
  keywords: [
    '桌面整理',
    '桌面挂件',
    '一键整理',
    '自动整理',
    '格子',
    '网格',
    '挂件',
    '备份布局',
    '还原布局',
    '图标',
    '快捷',
    '引用',
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
  loadView: () => import('../desktop-grid/GridManagerView'),
} satisfies ModuleMeta;

export default desktopOrganizerModule;
