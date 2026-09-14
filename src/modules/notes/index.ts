import type { ModuleMeta } from '@/core/types';
import { notesCommands } from './commands';

/**
 * 便签·待办（M3）模块元数据（V08：便签数据层 + 便签窗口）。
 *
 * 经 `import.meta.glob`（匹配各模块目录下的 index.ts）自动发现，无需在任何注册表登记。
 * 命令在 `./commands` 声明（新建便签 / 便签列表）；待办清单、提醒调度在 V09 接入。
 * 承载形态含独立窗口，`windowSpec.kind = 'note'`（label = `note-{id}`，多实例、无边框）。
 */
const notesModule = {
  id: 'notes',
  name: '便签·待办',
  description: '桌面便签与待办清单',
  icon: 'StickyNote',
  order: 20,
  surface: ['panel', 'window'],
  tier: 'free',
  keywords: ['便签', '待办', '提醒', 'note', 'todo', 'bq', 'db'],
  route: 'notes',
  windowSpec: { kind: 'note', multi: true, frameless: true, alwaysOnTop: true },
  contributes: {
    commands: notesCommands,
  },
  loadView: () => import('./NoteListView'),
} satisfies ModuleMeta;

export default notesModule;
