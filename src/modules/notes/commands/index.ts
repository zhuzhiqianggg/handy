import type { CommandMeta } from '@/core/types';
import { createNote, openNoteWindow } from '@/core/data/notesService';

/**
 * 便签·待办（M3）命令清单（V08 便签 / V09 待办）。
 *
 * - 「新建便签」：动作式命令（`run`）——落库一张新便签后立即打开其独立窗口；
 * - 「便签列表」：视图式命令（`load`）——主面板内查看/置顶/删除/互转全部便签；
 * - 「待办清单」：视图式命令（`load`）——待办增删改、优先级/到期/提醒与互转。
 *
 * 新增命令：在本数组追加一条 `CommandMeta` 即完成，**框架零改动**（ARCHITECTURE §4.3）。
 */
export const notesCommands: CommandMeta[] = [
  {
    id: 'note-create',
    moduleId: 'notes',
    name: '新建便签',
    description: '创建一张桌面便签，并打开便签窗口',
    icon: 'StickyNote',
    aliases: ['new note', 'add note'],
    keywords: ['新建', '便签', '笔记', '便笺', '便条', 'xj', 'xinjian', 'bq', 'bianqian'],
    tier: 'free',
    run: async () => {
      const note = await createNote();
      await openNoteWindow(note.id);
    },
  },
  {
    id: 'note-list',
    moduleId: 'notes',
    name: '便签列表',
    description: '查看、置顶与管理全部桌面便签',
    icon: 'StickyNote',
    aliases: ['notes'],
    keywords: ['便签', '列表', '管理', '笔记', 'notes', 'bq', 'bianqian', 'lb'],
    layout: 'full',
    tier: 'free',
    load: () => import('../NoteListView'),
  },
  {
    id: 'todo-list',
    moduleId: 'notes',
    name: '待办清单',
    description: '查看与管理待办任务、到期提醒',
    icon: 'ClipboardList',
    aliases: ['todo', 'todos'],
    keywords: ['待办', '清单', '任务', '提醒', '到期', 'todo', 'db', 'qd'],
    layout: 'full',
    tier: 'free',
    load: () => import('@/modules/todos/TodoView'),
  },
];
