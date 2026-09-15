import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, ListTodo, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { useTodosStore } from '@/stores/useTodosStore';
import { priorityStyle, type Todo } from '@/core/data/todosService';
import { cn } from '@/lib/utils';
import {
  SCOPE_LABELS,
  defaultMomentOfDay,
  dueLabel,
  filterTodos,
  isOverdue,
  relativeDayLabel,
  type PlanScope,
} from './planUtils';

/**
 * 工作台「计划」面板：按范围（当日 / 本周 / 本月 / 无日期 / 全部）展示待办，
 * 支持**就地新增（挂到日历选中的那一天）**、勾选完成（划掉）、删除。
 *
 * 数据仍复用 `useTodosStore`（即「待办清单」命令的同一份 SQLite 数据）——
 * 工作台只是同一份数据的**日历视角**，不引入第二套任务模型，
 * 因此在「待办清单」里改的内容会实时反映到工作台，反之亦然。
 */

export interface PlanPanelProps {
  todos: Todo[];
  /** 日历选中的日期（本地零点毫秒） */
  anchorMs: number;
  scope: PlanScope;
  onScopeChange: (scope: PlanScope) => void;
  hideDone: boolean;
  onHideDoneChange: (value: boolean) => void;
  /** 递增信号：变化时聚焦新增输入框（由日历点击触发） */
  focusToken: number;
}

/** 范围 chip 顺序（`day` 的文案在渲染时按选中日期动态显示） */
const SCOPE_ORDER: readonly PlanScope[] = ['day', 'week', 'month', 'undated', 'all'];

export function PlanPanel({
  todos,
  anchorMs,
  scope,
  onScopeChange,
  hideDone,
  onHideDoneChange,
  focusToken,
}: PlanPanelProps): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 日历点击「＋」后聚焦输入框：形成「点日历 → 直接打字记事件」的连贯动作
  useEffect(() => {
    if (focusToken > 0) {
      inputRef.current?.focus();
    }
  }, [focusToken]);

  const visible = useMemo(
    () => filterTodos(todos, scope, anchorMs, hideDone),
    [todos, scope, anchorMs, hideDone],
  );
  const pendingInScope = useMemo(() => visible.filter((todo) => !todo.done).length, [visible]);

  const handleAdd = (): void => {
    const title = draft.trim();
    if (title.length === 0) {
      inputRef.current?.focus();
      return;
    }
    const dueAt = scope === 'undated' ? null : defaultMomentOfDay(anchorMs);
    void useTodosStore
      .getState()
      .createTodo({ title, dueAt })
      .then(() => {
        setDraft('');
        toast.success(
          dueAt === null ? '已添加到「无日期」' : `已添加到 ${relativeDayLabel(anchorMs)} 09:00`,
        );
      })
      .catch((error: unknown) => {
        toast.error(`新增事件失败：${error instanceof Error ? error.message : String(error)}`);
      });
  };

  const handleToggle = (id: string): void => {
    void useTodosStore
      .getState()
      .toggleDone(id)
      .catch((error: unknown) => {
        toast.error(`更新失败：${error instanceof Error ? error.message : String(error)}`);
      });
  };

  const handleDelete = (id: string): void => {
    void useTodosStore
      .getState()
      .deleteTodo(id)
      .catch((error: unknown) => {
        toast.error(`删除失败：${error instanceof Error ? error.message : String(error)}`);
      });
  };

  const addHint =
    scope === 'undated'
      ? '回车新增（不设日期）'
      : `回车新增到 ${relativeDayLabel(anchorMs)}（默认 09:00）`;

  return (
    <section className="flex max-h-[460px] min-h-[320px] flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-panel">
      <header className="flex flex-wrap items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700">
          <ListTodo className="h-4 w-4" />
        </span>
        <h3 className="text-sm font-semibold text-foreground">计划 · {relativeDayLabel(anchorMs)}</h3>
        <span className="text-xs text-muted-foreground">
          未完成 {pendingInScope} / 共 {visible.length}
        </span>
        <button
          type="button"
          onClick={() => onHideDoneChange(!hideDone)}
          className={cn(
            'ml-auto rounded-md px-2 py-1 text-[11px] transition',
            hideDone
              ? 'bg-brand-muted text-brand'
              : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
          )}
        >
          {hideDone ? '已隐藏完成项' : '隐藏完成项'}
        </button>
      </header>

      {/* 范围切换 */}
      <div className="flex flex-wrap items-center gap-1">
        {SCOPE_ORDER.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => onScopeChange(item)}
            className={cn(
              'rounded-md px-2 py-1 text-xs transition',
              scope === item
                ? 'bg-brand-muted font-medium text-brand'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            {item === 'day' ? relativeDayLabel(anchorMs) : SCOPE_LABELS[item]}
          </button>
        ))}
      </div>

      {/* 新增 */}
      <div className="flex items-center gap-2">
        <Input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              handleAdd();
            }
          }}
          placeholder={addHint}
          className="h-8 text-sm"
          aria-label="新增事件"
        />
        <Button size="sm" className="h-8 shrink-0 px-3" onClick={handleAdd}>
          <Plus className="h-3.5 w-3.5" />
          添加
        </Button>
      </div>

      {/* 列表 */}
      <div className="scrollbar-thin flex min-h-[120px] flex-1 flex-col gap-0.5 overflow-y-auto">
        {visible.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border py-8 text-center">
            <ListTodo className="h-6 w-6 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">这个范围还没有条目</p>
            <p className="text-xs text-muted-foreground/70">在上方输入框写一条，回车即入</p>
          </div>
        ) : (
          visible.map((todo) => {
            const priority = priorityStyle(todo.priority);
            return (
              <div
                key={todo.id}
                className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-accent/50"
              >
                <button
                  type="button"
                  aria-label={todo.done ? '标记未完成' : '标记完成'}
                  onClick={() => handleToggle(todo.id)}
                  className={cn(
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition',
                    todo.done
                      ? 'border-emerald-500 bg-emerald-500'
                      : 'border-muted-foreground/50 hover:border-emerald-600',
                  )}
                >
                  {todo.done ? (
                    <svg viewBox="0 0 12 12" className="h-2.5 w-2.5 text-white">
                      <path
                        d="M2 6.2L4.6 8.8L10 3.4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : null}
                </button>

                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-sm',
                    todo.done ? 'text-muted-foreground line-through' : 'text-foreground',
                  )}
                >
                  {todo.title || '未命名'}
                </span>

                {todo.dueAt !== null ? (
                  <span
                    className={cn(
                      'flex shrink-0 items-center gap-1 text-[11px] tabular-nums',
                      isOverdue(todo) ? 'text-destructive' : 'text-muted-foreground',
                    )}
                  >
                    <CalendarClock className="h-3 w-3" />
                    {dueLabel(todo.dueAt)}
                  </span>
                ) : null}

                {todo.priority > 1 ? (
                  <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px]', priority.className)}>
                    {priority.name}
                  </span>
                ) : null}

                <button
                  type="button"
                  aria-label={`删除 ${todo.title}`}
                  onClick={() => handleDelete(todo.id)}
                  className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition hover:bg-accent hover:text-destructive group-hover:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

export default PlanPanel;
