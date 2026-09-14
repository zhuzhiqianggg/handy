import type { ModuleMeta } from '@/core/types';
import { notesCommands } from './commands';

/**
 * 工作台（原便签·待办 M3）模块元数据。
 *
 * **注册策略（保留 notes id）**：用户已决定用「桌面工作台」替换便签模块首屏。
 * 本模块元数据沿用 id `notes`（命令、路由、启停状态、备份兼容均无需迁移），
 * 仅重命名为「工作台」并把 `loadView` 重定向到 `../workstation/WorkstationView`：
 *   - 侧栏 / 命令面板 / 设置中心中「便签·待办」位置展示为「工作台」；
 *   - 便签 / 待办能力不删除：`notesCommands`（新建便签 / 便签列表 / 待办清单）
 *     仍可经命令面板与工作台卡片触达；
 *   - 独立便签窗口仍由 Rust `open_note_window` 创建，`windowSpec` 描述保持不变。
 */
const notesModule = {
  id: 'notes',
  name: '工作台',
  description: '今日待办 · 便签 · 快捷入口，一屏聚合',
  icon: 'StickyNote',
  order: 20,
  surface: ['panel', 'window'],
  tier: 'free',
  keywords: [
    '工作台',
    '待办',
    '便签',
    '提醒',
    '快捷入口',
    'workstation',
    'dashboard',
    'gzt',
    'note',
    'todo',
    'bq',
    'db',
  ],
  route: 'notes',
  windowSpec: { kind: 'note', multi: true, frameless: true, alwaysOnTop: true },
  contributes: {
    commands: notesCommands,
  },
  loadView: () => import('../workstation/WorkstationView'),
} satisfies ModuleMeta;

export default notesModule;
