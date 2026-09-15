import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Eye, FilePlus2, MonitorUp, NotebookPen, PenLine, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RichMarkdown } from '@/components/RichMarkdown';
import { MarkdownWithCode } from '@/components/MarkdownWithCode';
import { toast } from '@/components/ui/toast';
import { useNotesStore } from '@/stores/useNotesStore';
import { openNoteWindow } from '@/core/data/notesService';
import { stripMarkdown } from '@/lib/markdown';
import { cn } from '@/lib/utils';

/**
 * 工作台「便签」面板。
 *
 * # V20 改版（用户反馈 #6）
 *
 * 「下面笔记改成便签，这个便签里面的 code 最好能支持语法高亮的 ```shell ```python 这样的，
 *   多个便签用户可以自己右键选择贴到桌面上，默认就在工作台上直接可以看。」
 *
 * 三件事：
 *   1. **改名便签**（语义更贴近「随手记」），仍在工作台里直接读写；
 *   2. **代码高亮**：新增「预览」页签，围栏代码块按语言着色（shell / python / js / json /
 *      yaml / java / go / sql / ini），零依赖实现，见 `@/components/CodeBlock`；
 *   3. **贴到桌面**：列表项**右键**即可把该便签丢成桌面悬浮窗（复用 V08 的 note 窗，
 *      `?window=note-<id>` 路由一直在，只是之前没有入口）。
 *
 * 编辑态仍是「所见即所得」的 `RichMarkdown`（敲 `**重点**` 当场变粗体），
 * 预览态才做代码高亮 —— 因为高亮要在编辑框里做会不断打断光标，
 * 分成两个页签既简单又不折腾用户。数据仍是 `notes` 表，零迁移。
 */

/** 自动落库防抖（毫秒） */
const AUTOSAVE_DEBOUNCE_MS = 700;

/** 待落库草稿 */
interface PendingDraft {
  id: string;
  title: string;
  body: string;
}

/** 右键菜单位置与目标 */
interface ContextMenuState {
  x: number;
  y: number;
  noteId: string;
}

/** 更新时间（`9/16 14:05`） */
function formatUpdated(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function NotesPanel(): React.JSX.Element {
  const notes = useNotesStore((state) => state.notes);
  const loaded = useNotesStore((state) => state.loaded);
  const hydrate = useNotesStore((state) => state.hydrate);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  /** 编辑（所见即所得）/ 预览（代码高亮） */
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  // 右键菜单：点任意处关闭
  useEffect(() => {
    if (menu === null) {
      return;
    }
    const close = (): void => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  // 选中项失效（删除 / 首次加载）时自动落到第一条
  useEffect(() => {
    if (selectedId !== null && notes.some((note) => note.id === selectedId)) {
      return;
    }
    setSelectedId(notes[0]?.id ?? null);
  }, [notes, selectedId]);

  const selected = useMemo(
    () => notes.find((note) => note.id === selectedId) ?? null,
    [notes, selectedId],
  );

  const pendingRef = useRef<PendingDraft | null>(null);
  const timerRef = useRef<number | undefined>(undefined);

  /** 立即落库（切换便签 / 卸载面板 / 手动触发时调用） */
  const flush = useCallback((): void => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
    if (!pending) {
      return;
    }
    void useNotesStore
      .getState()
      .updateNote(pending.id, { title: pending.title, body: pending.body })
      .catch((error: unknown) => {
        toast.error(`便签保存失败：${error instanceof Error ? error.message : String(error)}`);
      });
  }, []);

  // 仅当选中便签变化时载入草稿：避免 store 每次更新都把正在输入的内容覆盖掉
  const selectedKey = selected?.id ?? null;
  const selectedTitle = selected?.title ?? '';
  const selectedBody = selected?.body ?? '';
  useEffect(() => {
    flush();
    setTitle(selectedTitle);
    setBody(selectedBody);
    // 依赖刻意只取 id：切到另一条便签才重新载入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  /** 外部聚焦请求（待办的「打开来源便签」走这里） */
  const focusRequestId = useNotesStore((state) => state.focusRequestId);
  useEffect(() => {
    if (focusRequestId === null || !notes.some((note) => note.id === focusRequestId)) {
      return;
    }
    flush();
    setSelectedId(focusRequestId);
    useNotesStore.getState().clearFocusRequest();
  }, [focusRequestId, notes, flush]);

  // 面板卸载前强制落库
  useEffect(
    () => () => {
      flush();
    },
    [flush],
  );

  const activeId = selected?.id ?? '';

  const schedule = useCallback(
    (id: string, nextTitle: string, nextBody: string): void => {
      if (id.length === 0) {
        return;
      }
      pendingRef.current = { id, title: nextTitle, body: nextBody };
      if (timerRef.current !== undefined) {
        window.clearTimeout(timerRef.current);
      }
      timerRef.current = window.setTimeout(flush, AUTOSAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  const handleCreate = (): void => {
    flush();
    void useNotesStore
      .getState()
      .createNote({ title: '新便签', body: '' })
      .then((note) => setSelectedId(note.id))
      .catch((error: unknown) => {
        toast.error(`新建便签失败：${error instanceof Error ? error.message : String(error)}`);
      });
  };

  const handleDelete = (id: string): void => {
    pendingRef.current = null;
    void useNotesStore
      .getState()
      .deleteNote(id)
      .catch((error: unknown) => {
        toast.error(`删除便签失败：${error instanceof Error ? error.message : String(error)}`);
      });
  };

  /** 贴到桌面：复用 V08 的便签悬浮窗（无边框 / 可拖 / 可置顶） */
  const stickToDesktop = (id: string): void => {
    flush();
    void openNoteWindow(id)
      .then(() => toast.success('已贴到桌面', { description: '便签窗可拖动、可置顶；关闭即收回' }))
      .catch((error: unknown) => {
        toast.error(`贴到桌面失败：${error instanceof Error ? error.message : String(error)}`);
      });
  };

  return (
    <section className="flex h-full min-h-[420px] flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-panel">
      <header className="flex items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-sky-100 text-sky-700">
          <NotebookPen className="h-4 w-4" />
        </span>
        <h3 className="text-sm font-semibold text-foreground">便签</h3>
        <span className="text-xs text-muted-foreground">
          Markdown · 边写边渲染 · 右键可贴到桌面
        </span>
        <div className="ml-auto flex items-center gap-1">
          {/* 编辑 / 预览 切换：预览态做代码高亮 */}
          <div className="flex items-center rounded-lg border border-border p-0.5">
            {(
              [
                { value: 'edit', label: '编辑', icon: PenLine },
                { value: 'preview', label: '预览', icon: Eye },
              ] as const
            ).map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => setMode(item.value)}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] transition',
                    mode === item.value
                      ? 'bg-brand-muted font-medium text-brand'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Icon className="h-3 w-3" />
                  {item.label}
                </button>
              );
            })}
          </div>
          <Button size="sm" className="h-7 px-2.5 text-xs" onClick={handleCreate}>
            <FilePlus2 className="h-3.5 w-3.5" />
            新建
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground hover:text-brand"
            onClick={() => selected !== null && stickToDesktop(selected.id)}
            disabled={selected === null}
            title="把当前便签贴成桌面悬浮窗"
          >
            <MonitorUp className="h-3.5 w-3.5" />
            贴到桌面
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
            onClick={() => selected !== null && handleDelete(selected.id)}
            disabled={selected === null}
          >
            <Trash2 className="h-3.5 w-3.5" />
            删除
          </Button>
        </div>
      </header>

      {!loaded ? (
        <p className="py-8 text-center text-sm text-muted-foreground">加载中…</p>
      ) : notes.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border py-10 text-center">
          <NotebookPen className="h-6 w-6 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">还没有便签</p>
          <Button size="sm" onClick={handleCreate}>
            <FilePlus2 className="h-3.5 w-3.5" />
            写第一条
          </Button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-3">
          {/* 左：便签列表（右键 → 贴到桌面） */}
          <div className="scrollbar-thin flex w-44 shrink-0 flex-col gap-0.5 overflow-y-auto rounded-lg border border-border p-1">
            {notes.map((note) => {
              const excerpt = stripMarkdown(note.body).replace(/\s+/g, ' ').trim();
              const active = note.id === selectedId;
              return (
                <button
                  key={note.id}
                  type="button"
                  onClick={() => {
                    flush();
                    setSelectedId(note.id);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenu({ x: event.clientX, y: event.clientY, noteId: note.id });
                  }}
                  title="右键：贴到桌面 / 删除"
                  className={cn(
                    'flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition',
                    active ? 'bg-brand-muted' : 'hover:bg-accent',
                  )}
                >
                  <span
                    className={cn(
                      'truncate text-xs font-medium',
                      active ? 'text-brand' : 'text-foreground',
                    )}
                  >
                    {note.title.trim() || '未命名便签'}
                  </span>
                  <span className="truncate text-[10px] text-muted-foreground">
                    {excerpt.length > 0 ? excerpt : '（空）'}
                  </span>
                  <span className="text-[10px] tabular-nums text-muted-foreground/70">
                    {formatUpdated(note.updatedAt)}
                  </span>
                </button>
              );
            })}
          </div>

          {/* 右：标题 + 正文 */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
            <Input
              value={title}
              onChange={(event) => {
                const next = event.target.value;
                setTitle(next);
                schedule(activeId, next, body);
              }}
              onBlur={flush}
              placeholder="便签标题"
              className="h-8 text-sm font-medium"
              aria-label="便签标题"
            />
            <div className="min-h-[280px] flex-1 overflow-hidden rounded-lg border border-border bg-background">
              {mode === 'edit' ? (
                <RichMarkdown
                  value={body}
                  onChange={(next: string) => {
                    setBody(next);
                    schedule(activeId, title, next);
                  }}
                  onBlur={flush}
                  placeholder="直接写就行：**重点** 会变粗体、- 开头变列表、# 开头变标题；粘贴 ```shell 代码块后切到「预览」看高亮。"
                  className="min-h-[280px] px-3 py-2 text-sm"
                  ariaLabel="便签正文"
                />
              ) : (
                <div className="scrollbar-thin h-full max-h-[420px] overflow-auto px-3 py-2">
                  <MarkdownWithCode source={body} fallback="（这条便签还是空的）" />
                </div>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {mode === 'edit'
                ? '编辑态：语法敲完立刻渲染（不需要点预览）。'
                : '预览态：```shell / ```python / ```json 等围栏代码块会按语言高亮。'}
            </p>
          </div>
        </div>
      )}

      {/* 自定义右键菜单（Tauri 生产环境禁用系统右键菜单，需自绘） */}
      {menu !== null ? (
        <div
          className="fixed z-50 min-w-[140px] overflow-hidden rounded-lg border border-border bg-card py-1 shadow-xl"
          style={{ left: menu.x, top: menu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              setSelectedId(menu.noteId);
              stickToDesktop(menu.noteId);
              setMenu(null);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground transition hover:bg-accent"
          >
            <MonitorUp className="h-3.5 w-3.5" />
            贴到桌面
          </button>
          <button
            type="button"
            onClick={() => {
              handleDelete(menu.noteId);
              setMenu(null);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-destructive transition hover:bg-destructive/10"
          >
            <Trash2 className="h-3.5 w-3.5" />
            删除便签
          </button>
        </div>
      ) : null}
    </section>
  );
}

export default NotesPanel;
