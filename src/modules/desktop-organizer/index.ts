import type { ModuleMeta } from '@/core/types';
import { desktopOrganizerCommands } from './commands';

/**
 * 桌面挂件（原桌面整理 M2）模块元数据。
 *
 * **注册策略（原地改名重定向，同 notes → 工作台）**：V12 的「建目录 + 移动文件」
 * 整理方案被用户否决，新方案为**文件引用型**桌面网格挂件（文件绝不移动，见
 * `../desktop-grid/`）。本模块沿用 id `desktop-organizer`（命令、路由、启停状态、
 * 备份兼容均无需迁移），仅重命名为「桌面挂件」并把 `loadView` 重定向到
 * `../desktop-grid/GridManagerView`：
 *   - 侧栏 / 命令面板 / 设置中心中「桌面整理」位置展示为「桌面挂件」；
 *   - 旧 V12 命令（organizer_scan / preview / apply / undo…）保留可用，
 *     旧前端 `OrganizerView` 就地休眠不删除；
 *   - 挂件本体是独立透明窗（label `grid-overlay`），由 Rust
 *     `grid_overlay_show / grid_overlay_hide` 创建与压回桌面层，
 *     不再走模块 windowSpec 开窗，故 surface 收敛为 panel。
 */
const desktopOrganizerModule = {
  id: 'desktop-organizer',
  name: '桌面挂件',
  description: '桌面网格挂件：盒子内是文件引用，双击打开原文件，绝不移动',
  icon: 'LayoutGrid',
  order: 40,
  surface: ['panel'],
  tier: 'free',
  keywords: [
    '桌面挂件',
    '挂件',
    '网格',
    '桌面整理',
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
