import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FilePlus2, NotebookPen, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RichMarkdown } from '@/components/RichMarkdown';
import { toast } from '@/components/ui/toast';
import { useNotesStore } from '@/stores/useNotesStore';
import { stripMarkdown } from '@/lib/markdown';
import { cn } from '@/lib/utils';

/**
 * 工作台「笔记」面板 —— 取代原「便签」卡片与桌面悬浮便签窗。
 *
 * 设计要点（对应反馈：「不要便签了 / 便签该放进工作台 / 编辑时要能自动渲染 / 笔记要更宽」）：
 *   - **不再开独立悬浮窗**：笔记就在工作台里读写，桌面保持干净；
 *   - **所见即所得**（V19 改版）：正文改用 `RichMarkdown`，敲 `**重点**` 当场变粗体、
 *     `# 标题` 当场变大标题，**不再有「左写右看」的分屏与工具栏** ——
 *     用户要的是「屏幕上的字就是最终效果」，不是「左边语法右边效果」；
 *   - 输入停止 700ms 后自动落库（复用 notes 表与 `useNotesStore`，数据零迁移）；
 *   - 切换笔记 / 卸载面板前强制 flush，绝不丢字。
 *
 * 沿用既有 notes 数据层的原因：数据已存在 SQLite（`notes` 表），
 * 换掉 UI 而不换数据，既满足「放进工作台」，也不丢弃历史便签内容。
 */

/** 自动落库防抖（毫秒） */
const AUTOSAVE_DEBOUNCE_MS = 700;

/** 待落库草稿 */
interface PendingDraft {
  id: string;
  title: string;
  body: string;
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

  /** 待落库草稿 + 防抖计时器 */
  const pendingRef = useRef<PendingDraft | null>(null);
  const timerRef = useRef<number | undefined>(undefined);

  /** 立即落库（切换笔记 / 卸载面板 / 手动触发时调用） */
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
        toast.error(`笔记保存失败：${error instanceof Error ? error.message : String(error)}`);
      });
  }, []);

  // 仅当选中笔记变化时载入草稿：避免 store 每次更新都把正在输入的内容覆盖掉
  const selectedKey = selected?.id ?? null;
  const selectedTitle = selected?.title ?? '';
  const selectedBody = selected?.body ?? '';
  useEffect(() => {
    flush();
    setTitle(selectedTitle);
    setBody(selectedBody);
    // 依赖刻意只取 id：切到另一条笔记才重新载入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  /**
   * 外部聚焦请求（待办的「打开来源笔记」走这里）。
   *
   * 必须等 `notes` 中真的出现该条再消费：工作台首次挂载时列表可能尚未加载完，
   * 若立刻 setSelectedId，会被上面的「选中项失效」逻辑顶回第一条。
   */
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

  /**
   * 当前选中笔记 id（空串 = 无选中）。
   * 闭包（onChange 回调）里只捕获这个字符串，避免 `selected` 的可空收窄在回调中失效。
   */
  const activeId = selected?.id ?? '';

  /** 统一的「改草稿 → 排防抖落库」入口（无选中时为 no-op） */
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
      .createNote({ title: '新笔记', body: '' })
      .then((note) => setSelectedId(note.id))
      .catch((error: unknown) => {
        toast.error(`新建笔记失败：${error instanceof Error ? error.message : String(error)}`);
      });
  };

  const handleDelete = (): void => {
    if (!selected) {
      return;
    }
    pendingRef.current = null;
    void useNotesStore
      .getState()
      .deleteNote(selected.id)
      .catch((error: unknown) => {
        toast.error(`删除笔记失败：${error instanceof Error ? error.message : String(error)}`);
      });
  };

  return (
    <section className="flex h-full min-h-[460px] flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-panel">
      <header className="flex items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-sky-100 text-sky-700">
          <NotebookPen className="h-4 w-4" />
        </span>
        <h3 className="text-sm font-semibold text-foreground">笔记</h3>
        <span className="text-xs text-muted-foreground">Markdown · 边写边渲染</span>
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" className="h-7 px-2.5 text-xs" onClick={handleCreate}>
            <FilePlus2 className="h-3.5 w-3.5" />
            新建
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
            onClick={handleDelete}
            disabled={!selected}
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
          <p className="text-sm text-muted-foreground">还没有笔记</p>
          <Button size="sm" onClick={handleCreate}>
            <FilePlus2 className="h-3.5 w-3.5" />
            写第一条
          </Button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-3">
          {/* 左：笔记列表 */}
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
                    {note.title.trim() || '未命名笔记'}
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

          {/* 右：标题 + 分屏编辑器 */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
            <Input
              value={title}
              onChange={(event) => {
                const next = event.target.value;
                setTitle(next);
                schedule(activeId, next, body);
              }}
              onBlur={flush}
              placeholder="笔记标题"
              className="h-8 text-sm font-medium"
              aria-label="笔记标题"
            />
            <div className="min-h-[300px] flex-1 overflow-hidden rounded-lg border border-border bg-background">
              <RichMarkdown
                value={body}
                onChange={(next: string) => {
                  setBody(next);
                  schedule(activeId, title, next);
                }}
                onBlur={flush}
                placeholder="直接写就行：**重点** 会变粗体、- 开头变列表、# 开头变标题、`代码` 高亮……语法敲完立刻渲染，不用切预览。"
                className="px-3 py-2 text-sm"
                ariaLabel="笔记正文"
              />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export default NotesPanel;
