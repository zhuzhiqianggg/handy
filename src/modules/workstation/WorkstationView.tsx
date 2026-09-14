import React, { useEffect, useMemo, useState } from 'react';
import {
  CalendarDays,
  ChevronRight,
  FolderOpen,
  Link2,
  ListTodo,
  Plus,
  StickyNote,
  Trash2,
} from 'lucide-react';
import { useTodosStore } from '@/stores/useTodosStore';
import { useNotesStore } from '@/stores/useNotesStore';
import { openNoteWindow } from '@/core/data/notesService';
import { openCommand } from '@/core/navigation';
import { ipc } from '@/lib/ipc';
import { stripMarkdown } from '@/lib/markdown';
import { toast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  detectQuickLinkType,
  loadQuickLinks,
  newQuickLinkId,
  saveQuickLinks,
  type QuickLink,
  type QuickLinkType,
} from './quicklinks';

/**
 * 桌面工作台视图（notes 模块面板内页，替代原便签列表首屏）。
 *
 * 聚合三张卡片：
 *   - 今日待办：复用 `useTodosStore`（待办前 8 条，未完成在前），支持快捷添加（仅标题）
 *     与完成切换；「全部待办」跳转既有「待办清单」命令视图；
 *   - 便签：复用 `useNotesStore`（最近 6 张），点击经既有 `openNoteWindow` 打开独立
 *     便签窗口（桌面便签行为不变）；「新建便签」沿用 createNote + openNoteWindow 链路；
 *   - 快捷入口：localStorage（`handy.workstation.quicklinks.v1`）持久化的网址 / 路径
 *     收藏，经 `ipc.shellOpen`（shell:allow-open）在默认应用中打开。
 *
 * 头部：按时间段问候（早上好 / 下午好 / 晚上好）+ 中文日期 + 星期 + 实时时钟。
 */

export interface WorkstationViewProps {
  /** 兼容 CommandProps（命令视图注入，未使用） */
  initialInput?: string;
  /** 兼容 ModuleProps（模块内页注入，未使用） */
  windowKind?: string;
}

/** 中文星期（getDay：0 = 周日） */
const WEEKDAYS: readonly string[] = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

/** 卡片可见条目上限（工作台是概览，全量管理走对应命令视图） */
const TODO_VISIBLE_LIMIT = 8;
const NOTE_VISIBLE_LIMIT = 6;

/** 按时间段问候：5–12 早上好，12–18 下午好，其余晚上好 */
function greetingOf(hour: number): string {
  if (hour >= 5 && hour < 12) {
    return '早上好';
  }
  if (hour >= 12 && hour < 18) {
    return '下午好';
  }
  return '晚上好';
}

/** 中文日期：yyyy年M月d日 · 星期X */
function dateLabelOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 · ${WEEKDAYS[d.getDay()]}`;
}

/** 时钟 HH:mm（两位补零） */
function clockLabelOf(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 便签更新时间：MM-DD HH:mm（与 OrganizerView 时间风格一致） */
function formatNoteTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 错误信息归一 */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// —— 卡片骨架 ——

interface WorkCardProps {
  /** 卡片标题 */
  title: string;
  /** 标题左侧图标（emerald 软色块内） */
  icon: React.ReactNode;
  /** 标题右侧动作区（按钮 / 计数徽标） */
  action?: React.ReactNode;
  children: React.ReactNode;
}

/** 通用卡片骨架：圆角、细边框、扁平浅阴影（对齐工具箱视觉基调） */
function WorkCard({ title, icon, action, children }: WorkCardProps): React.JSX.Element {
  return (
    <section className="flex min-h-0 flex-col rounded-xl border border-border bg-card p-4 shadow-panel">
      <header className="mb-3 flex items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700">
          {icon}
        </span>
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {action !== undefined && <div className="ml-auto flex items-center gap-1">{action}</div>}
      </header>
      {children}
    </section>
  );
}

/** 卡片内空态（友好文案 + 弱化图标，不出现在卡片外） */
function CardEmpty({ icon, text, hint }: { icon: React.ReactNode; text: string; hint?: string }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border py-8 text-center">
      <span className="text-muted-foreground/50">{icon}</span>
      <p className="text-sm text-muted-foreground">{text}</p>
      {hint !== undefined && <p className="text-xs text-muted-foreground/70">{hint}</p>}
    </div>
  );
}

/** 卡片错误横幅（数据层失败时显示，不影响其他卡片） */
function CardError({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="mb-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
      {text}
    </div>
  );
}

// —— 主视图 ——

export default function WorkstationView(_props: WorkstationViewProps = {}): React.JSX.Element {
  // —— 头部时钟（30s 刷新，足够精确且省电）——
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const greeting = useMemo(() => greetingOf(new Date(now).getHours()), [now]);
  const dateLabel = useMemo(() => dateLabelOf(now), [now]);
  const clockLabel = useMemo(() => clockLabelOf(now), [now]);

  // —— 今日待办（复用既有 todos 数据层）——
  const todos = useTodosStore((state) => state.todos);
  const todosLoaded = useTodosStore((state) => state.loaded);
  const todosError = useTodosStore((state) => state.error);
  const hydrateTodos = useTodosStore((state) => state.hydrate);
  const [newTodoTitle, setNewTodoTitle] = useState('');
  useEffect(() => {
    void hydrateTodos();
  }, [hydrateTodos]);

  /** store 已按 sortTodos 排序（未完成在前），直接取前 N 条即为「今日概览」 */
  const visibleTodos = useMemo(() => todos.slice(0, TODO_VISIBLE_LIMIT), [todos]);
  const pendingCount = useMemo(() => todos.filter((t) => !t.done).length, [todos]);

  const handleAddTodo = (): void => {
    const title = newTodoTitle.trim();
    if (title.length === 0) {
      return;
    }
    void useTodosStore
      .getState()
      .createTodo({ title })
      .then(() => setNewTodoTitle(''))
      .catch((err: unknown) => toast.error(`新建待办失败：${errMessage(err)}`));
  };

  const handleToggleTodo = (id: string): void => {
    void useTodosStore.getState().toggleDone(id).catch((err: unknown) =>
      toast.error(`切换待办状态失败：${errMessage(err)}`),
    );
  };

  // —— 便签（复用既有 notes 数据层 + 独立窗口链路）——
  const notes = useNotesStore((state) => state.notes);
  const notesLoaded = useNotesStore((state) => state.loaded);
  const notesError = useNotesStore((state) => state.error);
  const hydrateNotes = useNotesStore((state) => state.hydrate);
  useEffect(() => {
    void hydrateNotes();
  }, [hydrateNotes]);

  const visibleNotes = useMemo(() => notes.slice(0, NOTE_VISIBLE_LIMIT), [notes]);

  /** 新建便签：落库后立即开独立窗口（与 NoteListView 同一链路） */
  const handleCreateNote = (): void => {
    void useNotesStore
      .getState()
      .createNote()
      .then((note) => openNoteWindow(note.id))
      .catch((err: unknown) => toast.error(`新建便签失败：${errMessage(err)}`));
  };

  const handleOpenNote = (id: string): void => {
    void openNoteWindow(id).catch((err: unknown) =>
      toast.error(`打开便签失败：${errMessage(err)}`),
    );
  };

  // —— 快捷入口（localStorage 持久化）——
  const [links, setLinks] = useState<QuickLink[]>([]);
  const [linkName, setLinkName] = useState('');
  const [linkValue, setLinkValue] = useState('');
  useEffect(() => {
    setLinks(loadQuickLinks());
  }, []);

  /** 更新本地状态并落 localStorage（唯一写入口，保证两者一致） */
  const updateLinks = (next: QuickLink[]): void => {
    setLinks(next);
    saveQuickLinks(next);
  };

  const handleAddLink = (): void => {
    const name = linkName.trim();
    const value = linkValue.trim();
    if (name.length === 0 || value.length === 0) {
      return;
    }
    const type: QuickLinkType = detectQuickLinkType(value);
    const link: QuickLink = {
      id: newQuickLinkId(),
      name,
      type,
      value,
      createdAt: Date.now(),
    };
    updateLinks([...links, link]);
    setLinkName('');
    setLinkValue('');
  };

  const handleRemoveLink = (id: string): void => {
    updateLinks(links.filter((l) => l.id !== id));
  };

  const handleOpenLink = (link: QuickLink): void => {
    void ipc
      .shellOpen(link.value)
      .catch((err: unknown) =>
        toast.error(
          `打开「${link.name}」失败：${errMessage(err)}（需要在 capabilities 中开启打开权限）`,
        ),
      );
  };

  const linkIconOf = (type: QuickLinkType): React.JSX.Element =>
    type === 'url' ? <Link2 className="h-3.5 w-3.5" /> : <FolderOpen className="h-3.5 w-3.5" />;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* —— 问候头部 —— */}
      <header className="flex items-end justify-between gap-4 px-6 pb-4 pt-5">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-foreground">{greeting}</h1>
          <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <CalendarDays className="h-3.5 w-3.5" />
            {dateLabel}
          </p>
        </div>
        <p className="shrink-0 text-2xl font-semibold tabular-nums text-brand" title="当前时间">
          {clockLabel}
        </p>
      </header>

      {/* —— 三卡聚合区 —— */}
      <div className="min-h-0 flex-1 scrollbar-thin overflow-auto px-6 pb-6">
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
          {/* —— 今日待办 —— */}
          <WorkCard
            title="今日待办"
            icon={<ListTodo className="h-4 w-4" />}
            action={
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground"
                onClick={() => openCommand('todo-list')}
              >
                全部待办
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            }
          >
            {todosError !== null && <CardError text={`加载待办失败：${todosError}`} />}

            {/* 快捷添加（仅标题，默认普通优先级、不设提醒） */}
            <div className="mb-3 flex items-center gap-2">
              <Input
                value={newTodoTitle}
                onChange={(event) => setNewTodoTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    handleAddTodo();
                  }
                }}
                placeholder="添加待办，回车确认"
                className="h-8 text-sm"
                aria-label="新待办标题"
              />
              <Button size="sm" className="h-8 shrink-0 px-3" onClick={handleAddTodo}>
                <Plus className="h-3.5 w-3.5" />
                添加
              </Button>
            </div>

            {todosLoaded && todos.length === 0 && todosError === null ? (
              <CardEmpty
                icon={<ListTodo className="h-6 w-6" />}
                text="今天还没有待办"
                hint="在上方输入并回车，随手记一条"
              />
            ) : (
              <div className="flex flex-col gap-0.5">
                {visibleTodos.map((todo) => (
                  <div
                    key={todo.id}
                    className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-accent/50"
                  >
                    <button
                      type="button"
                      aria-label={todo.done ? '标记未完成' : '标记完成'}
                      onClick={() => handleToggleTodo(todo.id)}
                      className={cn(
                        'block h-4 w-4 shrink-0 rounded-full border-2 transition',
                        todo.done
                          ? 'border-emerald-500 bg-emerald-500'
                          : 'border-muted-foreground/60 hover:border-emerald-600',
                      )}
                    />
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate text-sm',
                        todo.done ? 'text-muted-foreground line-through' : 'text-foreground',
                      )}
                    >
                      {todo.title}
                    </span>
                    {todo.priority > 1 && (
                      <span
                        className={cn(
                          'shrink-0 rounded px-1.5 py-0.5 text-[10px]',
                          todo.priority >= 3
                            ? 'bg-red-100 text-red-700'
                            : 'bg-amber-100 text-amber-800',
                        )}
                      >
                        {todo.priority >= 3 ? '紧急' : '重要'}
                      </span>
                    )}
                  </div>
                ))}
                {todos.length > TODO_VISIBLE_LIMIT && (
                  <button
                    type="button"
                    onClick={() => openCommand('todo-list')}
                    className="mt-1 px-2 text-left text-xs text-muted-foreground transition hover:text-brand"
                  >
                    还有 {todos.length - TODO_VISIBLE_LIMIT} 条，查看全部待办
                  </button>
                )}
                {pendingCount === 0 && todos.length > 0 && (
                  <p className="px-2 py-1 text-xs text-emerald-700">全部完成，干得漂亮</p>
                )}
              </div>
            )}
          </WorkCard>

          {/* —— 便签 —— */}
          <WorkCard
            title="便签"
            icon={<StickyNote className="h-4 w-4" />}
            action={
              <>
                <Button size="sm" className="h-7 px-2.5 text-xs" onClick={handleCreateNote}>
                  <Plus className="h-3.5 w-3.5" />
                  新建便签
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground"
                  onClick={() => openCommand('note-list')}
                >
                  全部
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </>
            }
          >
            {notesError !== null && <CardError text={`加载便签失败：${notesError}`} />}

            {notesLoaded && notes.length === 0 && notesError === null ? (
              <CardEmpty
                icon={<StickyNote className="h-6 w-6" />}
                text="还没有便签"
                hint="点击「新建便签」，在桌面上随手记录"
              />
            ) : (
              <div className="flex flex-col gap-0.5">
                {visibleNotes.map((note) => {
                  const excerpt = stripMarkdown(note.body).trim();
                  return (
                    <button
                      key={note.id}
                      type="button"
                      onClick={() => handleOpenNote(note.id)}
                      title="打开便签窗口"
                      className="group flex flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left transition hover:bg-accent/50"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className={cn(
                            'h-2 w-2 shrink-0 rounded-full',
                            note.color === 'green'
                              ? 'bg-green-300'
                              : note.color === 'blue'
                                ? 'bg-sky-300'
                                : note.color === 'pink'
                                  ? 'bg-pink-300'
                                  : note.color === 'purple'
                                    ? 'bg-purple-300'
                                    : note.color === 'gray'
                                      ? 'bg-zinc-300'
                                      : 'bg-amber-300',
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                          {note.title || '未命名便签'}
                        </span>
                        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                          {formatNoteTime(note.updatedAt)}
                        </span>
                      </div>
                      <span className="truncate pl-4 text-xs text-muted-foreground">
                        {excerpt.length > 0 ? excerpt : '（空便签）'}
                      </span>
                    </button>
                  );
                })}
                {notes.length > NOTE_VISIBLE_LIMIT && (
                  <button
                    type="button"
                    onClick={() => openCommand('note-list')}
                    className="mt-1 px-2 text-left text-xs text-muted-foreground transition hover:text-brand"
                  >
                    还有 {notes.length - NOTE_VISIBLE_LIMIT} 张，查看全部便签
                  </button>
                )}
              </div>
            )}
          </WorkCard>

          {/* —— 快捷入口 —— */}
          <WorkCard
            title="快捷入口"
            icon={<Link2 className="h-4 w-4" />}
            action={
              <span className="text-[10px] text-muted-foreground">
                {links.length > 0 ? `${links.length} 项` : undefined}
              </span>
            }
          >
            {/* 添加表单：名称 + 地址（自动识别网址 / 路径） */}
            <div className="mb-3 flex items-center gap-2">
              <Input
                value={linkName}
                onChange={(event) => setLinkName(event.target.value)}
                placeholder="名称，如「项目目录」"
                className="h-8 w-32 shrink-0 text-sm"
                aria-label="快捷入口名称"
              />
              <Input
                value={linkValue}
                onChange={(event) => setLinkValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    handleAddLink();
                  }
                }}
                placeholder="网址（https://…）或本地路径"
                className="h-8 min-w-0 flex-1 text-sm"
                aria-label="快捷入口地址"
              />
              <Button size="sm" className="h-8 shrink-0 px-3" onClick={handleAddLink}>
                <Plus className="h-3.5 w-3.5" />
                添加
              </Button>
            </div>

            {links.length === 0 ? (
              <CardEmpty
                icon={<Link2 className="h-6 w-6" />}
                text="还没有快捷入口"
                hint="添加常用网址或文件夹路径，一键直达"
              />
            ) : (
              <div className="flex flex-col gap-0.5">
                {links.map((link) => (
                  <div
                    key={link.id}
                    className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-accent/50"
                  >
                    <span
                      className={cn(
                        'flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
                        link.type === 'url'
                          ? 'bg-sky-100 text-sky-700'
                          : 'bg-emerald-100 text-emerald-700',
                      )}
                      title={link.type === 'url' ? '网址' : '本地路径'}
                    >
                      {linkIconOf(link.type)}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleOpenLink(link)}
                      title={`在默认应用中打开：${link.value}`}
                      className="min-w-0 flex-1 truncate text-left text-sm text-foreground"
                    >
                      {link.name}
                    </button>
                    <span className="hidden min-w-0 max-w-[40%] shrink truncate text-xs text-muted-foreground lg:block">
                      {link.value}
                    </span>
                    <button
                      type="button"
                      aria-label={`删除快捷入口 ${link.name}`}
                      title="删除"
                      onClick={() => handleRemoveLink(link.id)}
                      className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition hover:bg-accent hover:text-destructive group-hover:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </WorkCard>
        </div>
      </div>
    </div>
  );
}
