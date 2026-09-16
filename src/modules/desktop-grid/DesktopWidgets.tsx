import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { ipc } from '@/lib/ipc';
import type { Todo } from '@/core/data/todosService';

/**
 * 桌面挂件（V33）—— 直接长在桌面层上的轻量组件。
 *
 * 两种挂件：
 *   - **便签**（`note`）：纯文本随手记，输入即自动落库（防抖 600ms + 失焦立即写）；
 *   - **日历 · 今日计划**（`calendar`）：月视图 + 今日到期清单，数据直接读工作台的
 *     `todos` 表（同一份数据，桌面勾完工作台也同步），可在桌面上直接勾选 / 快速新增。
 *
 * 两者的数据都存在 `grid_boxes.content` 里（便签正文 / 日历无需额外配置），
 * 因此不需要新的表；便签的正文走 content，日历的清单走共享的 todos 表。
 */

/** 便签正文自动落库防抖（毫秒） */
const NOTE_SAVE_DEBOUNCE_MS = 600;

// —— 便签 ——

/**
 * 便签挂件：暖色便签纸观感（深色文字，任何壁纸上都读得清），输入即存。
 */
export function NoteWidget({
  boxId,
  content,
  onSave,
}: {
  boxId: number;
  content: string;
  onSave: (boxId: number, content: string) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(content);
  const timerRef = useRef<number | null>(null);
  // 外部（对账 / 另一处编辑）改了内容才同步，避免覆盖正在输入的文字
  const lastSavedRef = useRef(content);
  /**
   * 最新草稿 / 最新回调的「镜像 ref」。
   *
   * 为什么必须有它：下面那个「卸载时落一次」的 effect **不能**把 `draft` 写进依赖 ——
   * 否则每敲一个字都会重挂 effect，上一次的 cleanup 就会在当前这一笔上跑一次 flush，
   * 结果是①每个字符都打一次 IPC + 写一次 SQLite（防抖等于没有），②顺手把刚设好的
   * 防抖定时器清掉，导致「打完字停手」那一笔反而要等失焦/卸载才落盘。
   * 用 ref 拿最新值，effect 依赖就能保持稳定，只在真正卸载时落一次。
   */
  const draftRef = useRef(content);
  const onSaveRef = useRef(onSave);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    if (content !== lastSavedRef.current) {
      lastSavedRef.current = content;
      draftRef.current = content;
      setDraft(content);
    }
  }, [content]);

  const flush = useCallback(
    (value: string): void => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (value === lastSavedRef.current) {
        return;
      }
      lastSavedRef.current = value;
      onSaveRef.current(boxId, value);
    },
    [boxId],
  );

  // 卸载前落一次，避免「打了字立刻收起格子」丢内容（依赖稳定 → 击键时不触发）
  useEffect(() => () => flush(draftRef.current), [flush]);

  const handleChange = useCallback(
    (value: string): void => {
      draftRef.current = value;
      setDraft(value);
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        flush(value);
      }, NOTE_SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  return (
    <textarea
      value={draft}
      spellCheck={false}
      placeholder="随手写点什么…（自动保存）"
      onChange={(event) => handleChange(event.target.value)}
      onBlur={() => flush(draftRef.current)}
      onMouseDown={(event) => event.stopPropagation()}
      className="h-full w-full resize-none bg-amber-100/95 p-2.5 text-xs leading-relaxed text-amber-950 outline-none placeholder:text-amber-800/50"
    />
  );
}

// —— 日历 · 今日计划 ——

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

/** 某毫秒时间戳的本地日期三元组 */
function localParts(ms: number): { y: number; m: number; d: number } {
  const date = new Date(ms);
  return { y: date.getFullYear(), m: date.getMonth(), d: date.getDate() };
}

/** 同一天判定（按本地时区） */
function isSameDay(a: number, b: number): boolean {
  const x = localParts(a);
  const y = localParts(b);
  return x.y === y.y && x.m === y.m && x.d === y.d;
}

/** 当天 23:59:59 的毫秒值（快速新增的缺省到期时间） */
function endOfToday(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).getTime();
}

/**
 * 日历挂件：月视图（有计划的日期打点）+ 今日计划清单（可直接勾选 / 快速新增）。
 *
 * 数据来源是工作台的 `todos` 表 —— 桌面与工作台看的是同一份计划。
 */
export function CalendarWidget(): React.JSX.Element {
  const today = Date.now();
  const [todos, setTodos] = useState<Todo[]>([]);
  const [cursor, setCursor] = useState(() => {
    const parts = localParts(Date.now());
    return { y: parts.y, m: parts.m };
  });
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setTodos(await ipc.todosList());
    } catch {
      // 读不到（例如数据库暂时不可用）保持上一次的数据，不打断桌面观感
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // 月视图排布：周一为每周第一天
  const firstDay = new Date(cursor.y, cursor.m, 1);
  const daysInMonth = new Date(cursor.y, cursor.m + 1, 0).getDate();
  const leading = (firstDay.getDay() + 6) % 7; // 周日=0 → 周一为首列
  const cells: (number | null)[] = [
    ...Array.from({ length: leading }, () => null),
    ...Array.from({ length: daysInMonth }, (_, index) => index + 1),
  ];

  const dueDays = new Set(
    todos
      .filter((todo) => todo.dueAt !== null && !todo.done)
      .map((todo) => {
        const parts = localParts(todo.dueAt as number);
        return parts.y === cursor.y && parts.m === cursor.m ? parts.d : -1;
      })
      .filter((day) => day > 0),
  );

  const todayPlan = todos.filter((todo) => !todo.done && todo.dueAt !== null && isSameDay(todo.dueAt, today));
  const laterPlan = todos.filter((todo) => !todo.done && todo.dueAt === null).slice(0, 4);
  const plan = [...todayPlan, ...laterPlan];

  const toggle = useCallback(
    (todo: Todo): void => {
      void ipc
        .todosToggleDone(todo.id, !todo.done)
        .then(() => refresh())
        .catch(() => undefined);
    },
    [refresh],
  );

  const add = useCallback((): void => {
    const title = draft.trim();
    if (title.length === 0 || busy) {
      return;
    }
    setBusy(true);
    void ipc
      .todosCreate(title, endOfToday())
      .then(() => {
        setDraft('');
        return refresh();
      })
      .catch(() => undefined)
      .finally(() => setBusy(false));
  }, [draft, busy, refresh]);

  const shiftMonth = useCallback((delta: number): void => {
    setCursor((prev) => {
      const next = new Date(prev.y, prev.m + delta, 1);
      return { y: next.getFullYear(), m: next.getMonth() };
    });
  }, []);

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-1.5 p-2 text-neutral-100"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="flex shrink-0 items-center gap-1">
        <CalendarDays className="h-3.5 w-3.5 opacity-60" />
        <span className="flex-1 text-[11px] font-medium opacity-80">
          {cursor.y} 年 {cursor.m + 1} 月
        </span>
        <button
          type="button"
          title="上个月"
          onClick={() => shiftMonth(-1)}
          className="rounded p-0.5 opacity-60 transition hover:bg-white/15 hover:opacity-100"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title="回到今天"
          onClick={() => {
            const parts = localParts(Date.now());
            setCursor({ y: parts.y, m: parts.m });
          }}
          className="rounded px-1 text-[10px] opacity-60 transition hover:bg-white/15 hover:opacity-100"
        >
          今天
        </button>
        <button
          type="button"
          title="下个月"
          onClick={() => shiftMonth(1)}
          className="rounded p-0.5 opacity-60 transition hover:bg-white/15 hover:opacity-100"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="shrink-0">
        <div className="grid grid-cols-7 gap-y-0.5 text-center text-[9px] opacity-40">
          {WEEKDAYS.map((day) => (
            <span key={day}>{day}</span>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-y-0.5 text-center text-[10px]">
          {cells.map((day, index) => {
            if (day === null) {
              return <span key={`pad-${index}`} />;
            }
            const isToday = isSameDay(new Date(cursor.y, cursor.m, day).getTime(), today);
            return (
              <span
                key={day}
                className={`relative mx-auto flex h-4 w-4 items-center justify-center rounded-full ${
                  isToday ? 'bg-sky-500/90 font-semibold text-white' : 'opacity-80'
                }`}
              >
                {day}
                {dueDays.has(day) && !isToday ? (
                  <span className="absolute -bottom-0.5 h-0.5 w-0.5 rounded-full bg-amber-300" />
                ) : null}
              </span>
            );
          })}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              add();
            }
          }}
          placeholder="添加今日计划后回车"
          className="min-w-0 flex-1 rounded bg-white/10 px-1.5 py-1 text-[11px] text-neutral-100 outline-none placeholder:text-neutral-400/70"
        />
        <button
          type="button"
          title="添加今日计划"
          onClick={add}
          className="shrink-0 rounded p-1 opacity-70 transition hover:bg-white/15 hover:opacity-100"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {plan.length === 0 ? (
          <p className="py-2 text-center text-[10px] opacity-40">今日没有待办，轻松一下</p>
        ) : (
          plan.map((todo) => (
            <div
              key={todo.id}
              onClick={() => toggle(todo)}
              className="group flex cursor-pointer items-start gap-1.5 rounded px-1 py-0.5 text-[11px] leading-tight transition hover:bg-white/10"
              title={todo.detail.trim().length > 0 ? todo.detail : `${todo.title}（点击完成）`}
            >
              <span className="mt-[1px] h-3.5 w-3.5 shrink-0 rounded border border-white/40 transition group-hover:border-sky-300" />
              <span className="min-w-0 flex-1 opacity-90">{todo.title}</span>
              {todo.priority >= 2 ? (
                <span
                  className={`shrink-0 rounded px-1 text-[9px] ${
                    todo.priority === 3 ? 'bg-red-500/70' : 'bg-amber-500/70'
                  }`}
                >
                  {todo.priority === 3 ? '紧急' : '重要'}
                </span>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
