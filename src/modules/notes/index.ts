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
  description: '日历计划 · 笔记 · 系统快捷入口，一屏聚合',
  icon: 'StickyNote',
  order: 20,
  surface: ['panel', 'window'],
  /**
   * V42：**不再占主面板侧栏的位置**。
   *
   * 用户原话：「桌面整理和工作台功能全部都做到桌面去了，那么工具主页面里面就只需要
   * 保留工具箱和密码存储器了」。工作台的日历 / 计划本来就是桌面挂件，快捷入口
   * （`quicklinks.ts`）现在也直接出现在桌面底部的快捷条上 —— 主面板再放一个入口就是
   * 重复。命令 / 视图都还在（命令搜索照旧能搜到、桌面工具栏也能打开），只是不列在侧栏。
   */
  sidebar: false,
  tier: 'free',
  keywords: [
    '工作台',
    '日历',
    '计划',
    '待办',
    '任务',
    '事件',
    '笔记',
    '快捷入口',
    '终端',
    'workstation',
    'dashboard',
    'calendar',
    'gzt',
    'rili',
    'note',
    'todo',
    'bj',
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
