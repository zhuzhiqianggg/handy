import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { RichMarkdown } from '@/components/RichMarkdown';
import { ipc } from '@/lib/ipc';
import { dayInfo, ganZhi, type DayInfo } from '@/lib/lunar';
import { holidayOf, upcomingHolidays } from '@/lib/holidays';
import type { Todo } from '@/core/data/todosService';

/**
 * 桌面挂件（V33 引入，V34 升级）—— 直接长在桌面层上的轻量组件。
 *
 * 两种挂件，**每种全桌面只允许一个**（见 `GridOverlay` 的 `addWidget`）：
 *   - **便签**（`note`）：Markdown 随手记，**所见即所得**（复用工作台的
 *     `RichMarkdown`：敲 `**粗体**` 当场就变粗体，不是「源码 + 预览」双栏），
 *     输入防抖 600ms 落库 + 失焦立即写；
 *   - **日历 · 今日计划**（`calendar`）：与工作台 `CalendarPanel` 同一套观感 ——
 *     农历 / 二十四节气 / 法定节假日 / 休班角标 / 干支年，**点击某天即选中该天**，
 *     下方清单和新增输入都作用于该天；**鼠标悬停某天**用原生 tooltip 列出当天
 *     全部计划（含已完成）。数据直接读工作台的 `todos` 表，桌面勾完工作台同步。
 *
 * 数据存放：便签正文在 `grid_boxes.content`；日历的计划共用 `todos` 表，
 * 因此不需要新的表。
 */

/** 便签正文自动落库防抖（毫秒） */
const NOTE_SAVE_DEBOUNCE_MS = 600;

// —— 便签 ——

/**
 * 便签挂件：暖色便签纸观感（深色文字，任何壁纸上都读得清），Markdown 实时渲染。
 *
 * 受控策略：`draft` 是本地唯一真相，交给 `RichMarkdown` 的 `value` 用 ——
 * 若直接把「父组件里那份 `content`」传下去，防抖窗口期内父值还是旧的，
 * `RichMarkdown` 会认为「外部改值」而重建 DOM，**把用户正在敲的字整段抹掉**。
 * 因此父值只在「不是自己刚发出去的那一份」时才回灌（`lastSavedRef` 比对）。
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
  /** 最后一次已落库的内容：用于区分「外部改动」与「自己的回声」 */
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
    <div
      // select-none 是浮层容器的默认样式，而 contentEditable 需要真实可选中
      // （否则光标落不进去、压根没法编辑）→ 这里显式恢复文本可选。
      className="h-full w-full select-text bg-gradient-to-b from-amber-100/95 to-amber-200/90 text-amber-950"
      // 便签内部的一切鼠标操作都不该触发盒子的「拖动标题」逻辑
      onMouseDown={(event) => event.stopPropagation()}
    >
      <RichMarkdown
        value={draft}
        onChange={handleChange}
        placeholder="随手写点什么…支持 Markdown，边写边渲染"
        ariaLabel="桌面便签"
        className="note-markdown h-full w-full px-2.5 py-2 text-xs leading-relaxed"
        onBlur={() => flush(draftRef.current)}
      />
    </div>
  );
}

// —— 日历 · 今日计划 ——

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

/** 某毫秒时间戳的本地零点 */
function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 按「日」加减（走 `setDate` 而非 ±86400000，规避夏令时漂移） */
function addDays(ms: number, days: number): number {
  const date = new Date(ms);
  date.setDate(date.getDate() + days);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 42 格月历（首格为包含 1 号那周的周一），固定 42 格保证翻月不跳行 */
function buildMonthGrid(year: number, monthIndex: number): number[] {
  const first = startOfDay(new Date(year, monthIndex, 1).getTime());
  const offset = (new Date(first).getDay() + 6) % 7; // 周一 = 0
  const gridStart = addDays(first, -offset);
  return Array.from({ length: 42 }, (_, index) => addDays(gridStart, index));
}

/** 同一天判定（按本地时区） */
function isSameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

/** 日期短标签（如 `9月16日 周三`） */
function dayLabel(ms: number): string {
  const date = new Date(ms);
  return `${date.getMonth() + 1}月${date.getDate()}日 周${'日一二三四五六'[date.getDay()] ?? ''}`;
}

/** 某天 09:00 —— 新建计划的默认时刻（比 00:00 更贴近真实使用） */
function atNine(ms: number): number {
  const date = new Date(ms);
  date.setHours(9, 0, 0, 0);
  return date.getTime();
}

/**
 * 日历挂件：工作台 `CalendarPanel` 的桌面紧凑版。
 *
 * 与工作台**同源同观感**：农历日 / 传统节日（红）/ 二十四节气（青）/ 休·班角标 /
 * 干支年，交互上补齐用户要的两件事 ——
 *   - **点击某天** = 选中该天，下方清单与新增输入都作用于该天（不再只能加「今天」）；
 *   - **悬停某天** = tooltip 列出当天全部计划（未完成 + 已完成），一眼看全。
 */
export function CalendarWidget(): React.JSX.Element {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [selected, setSelected] = useState(() => startOfDay(Date.now()));
  const [view, setView] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
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

  const cells = useMemo(() => buildMonthGrid(view.year, view.month), [view]);
  const todayMs = startOfDay(Date.now());

  /** 每格的农历 / 节气 / 节假日：一次算完，避免渲染里重复推导 */
  const dayMeta = useMemo(() => {
    const map = new Map<number, { info: DayInfo; kind: string; name: string | null }>();
    for (const dayMs of cells) {
      const d = new Date(dayMs);
      const info = dayInfo(d.getFullYear(), d.getMonth() + 1, d.getDate());
      const holiday = holidayOf(d.getFullYear(), d.getMonth() + 1, d.getDate());
      map.set(dayMs, { info, kind: holiday.kind, name: holiday.name });
    }
    return map;
  }, [cells]);

  /** 按天归拢计划（含已完成），供悬停 tooltip 与选中日清单使用 */
  const byDay = useMemo(() => {
    const map = new Map<number, Todo[]>();
    for (const todo of todos) {
      if (todo.dueAt === null) {
        continue;
      }
      const key = startOfDay(todo.dueAt);
      const list = map.get(key) ?? [];
      list.push(todo);
      map.set(key, list);
    }
    return map;
  }, [todos]);

  /** 无日期的未完成项：选中「今天」时一并列出来，避免它们被彻底遗忘 */
  const undated = useMemo(
    () => todos.filter((todo) => !todo.done && todo.dueAt === null),
    [todos],
  );

  const selectedTodos = byDay.get(selected) ?? [];
  const showUndated = isSameDay(selected, todayMs);

  const nextHolidays = useMemo(() => upcomingHolidays(Date.now(), 1), []);
  const gz = ganZhi(view.year);

  const shiftMonth = useCallback((delta: number): void => {
    setView((prev) => {
      const next = new Date(prev.year, prev.month + delta, 1);
      return { year: next.getFullYear(), month: next.getMonth() };
    });
  }, []);

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
      .todosCreate(title, atNine(selected))
      .then(() => {
        setDraft('');
        return refresh();
      })
      .catch(() => undefined)
      .finally(() => setBusy(false));
  }, [draft, busy, refresh, selected]);

  const rows = showUndated ? [...selectedTodos, ...undated] : selectedTodos;

  return (
    <div
      className="flex h-full min-h-0 select-text flex-col gap-1.5 p-2 text-neutral-100"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="flex shrink-0 items-center gap-1">
        <CalendarDays className="h-3.5 w-3.5 opacity-60" />
        <span className="text-[11px] font-medium opacity-85">
          {view.year} 年 {view.month + 1} 月
        </span>
        <span className="rounded bg-white/10 px-1 text-[9px] opacity-60">
          {gz.ganZhi}年 · 属{gz.zodiac}
        </span>
        <button
          type="button"
          title="上个月"
          onClick={() => shiftMonth(-1)}
          className="ml-auto rounded p-0.5 opacity-60 transition hover:bg-white/15 hover:opacity-100"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title="回到今天"
          onClick={() => {
            const parts = startOfDay(Date.now());
            const now = new Date(parts);
            setView({ year: now.getFullYear(), month: now.getMonth() });
            setSelected(parts);
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
        <div className="grid grid-cols-7 text-center text-[9px] opacity-40">
          {WEEKDAYS.map((day) => (
            <span key={day}>{day}</span>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-y-0.5">
          {cells.map((dayMs, index) => {
            const date = new Date(dayMs);
            const inMonth = date.getMonth() === view.month && date.getFullYear() === view.year;
            const meta = dayMeta.get(dayMs);
            const isToday = dayMs === todayMs;
            const isSelected = dayMs === selected;
            const kind = meta?.kind ?? 'workday';
            const isOff = kind === 'holiday';
            const isMakeup = kind === 'makeup';
            const festival = meta?.info.lunarFestival ?? null;
            const term = meta?.info.term ?? null;
            const dayTodos = byDay.get(dayMs) ?? [];
            const pending = dayTodos.filter((todo) => !todo.done).length;

            const tooltip = [
              dayLabel(dayMs),
              meta?.info.lunar ? `农历${meta.info.lunar.monthName}${meta.info.lunar.dayName}` : null,
              meta?.name ?? null,
              term,
              pending > 0 ? `${pending} 项未完成` : null,
              dayTodos.length > 0
                ? `计划：${dayTodos
                    .map((todo) => `${todo.done ? '✓' : '·'} ${todo.title}`)
                    .join('；')}`
                : '这一天还没有计划（点一下加上）',
            ]
              .filter((part): part is string => part !== null)
              .join(' · ');

            return (
              <button
                key={dayMs}
                type="button"
                title={tooltip}
                onClick={() => setSelected(dayMs)}
                className={`relative flex flex-col items-center rounded px-0.5 py-0.5 leading-none transition ${
                  isSelected
                    ? 'bg-sky-500/90 font-semibold text-white'
                    : isToday
                      ? 'ring-1 ring-inset ring-sky-400/70'
                      : 'hover:bg-white/15'
                } ${inMonth ? '' : 'opacity-35'}`}
              >
                <span
                  className={`text-[10px] tabular-nums ${
                    isOff && !isSelected ? 'text-red-400' : ''
                  }`}
                >
                  {date.getDate()}
                </span>
                <span
                  className={`w-full truncate text-center text-[8px] ${
                    isSelected
                      ? 'text-white/80'
                      : festival !== null
                        ? 'font-medium text-red-400'
                        : term !== null
                          ? 'font-medium text-sky-300'
                          : 'opacity-50'
                  }`}
                >
                  {meta?.info.badge ?? ''}
                </span>
                {(isOff || isMakeup || pending > 0) && !isSelected ? (
                  <span className="absolute right-0 top-0 flex items-center gap-px">
                    {pending > 0 ? (
                      <span className="h-1 w-1 rounded-full bg-amber-300" />
                    ) : null}
                    {isOff ? (
                      <span className="rounded bg-red-500/25 px-px text-[7px] leading-[9px] text-red-300">
                        休
                      </span>
                    ) : null}
                    {isMakeup ? (
                      <span className="rounded bg-white/20 px-px text-[7px] leading-[9px] opacity-70">
                        班
                      </span>
                    ) : null}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {nextHolidays.length > 0 ? (
        <p className="shrink-0 text-[9px] opacity-45">
          {nextHolidays[0]!.inDays === 0
            ? `正在放「${nextHolidays[0]!.name}」`
            : `下个假期：${nextHolidays[0]!.name}（${nextHolidays[0]!.inDays} 天后 · ${nextHolidays[0]!.days} 天）`}
        </p>
      ) : null}

      <div className="shrink-0">
        <p className="mb-0.5 text-[9px] opacity-50">
          {dayLabel(selected)}
          {isSameDay(selected, todayMs) ? '（今天）' : ''} 的计划
        </p>
        <div className="flex items-center gap-1">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                add();
              }
            }}
            placeholder={`给 ${dayLabel(selected)} 加一条计划`}
            className="min-w-0 flex-1 rounded bg-white/10 px-1.5 py-1 text-[11px] text-neutral-100 outline-none placeholder:text-neutral-400/70"
          />
          <button
            type="button"
            title="添加计划"
            onClick={add}
            className="shrink-0 rounded p-1 opacity-70 transition hover:bg-white/15 hover:opacity-100"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        {rows.length === 0 ? (
          <p className="py-2 text-center text-[10px] opacity-40">这一天没有计划，轻松一下</p>
        ) : (
          rows.map((todo) => (
            <div
              key={todo.id}
              onClick={() => toggle(todo)}
              className="group flex cursor-pointer items-start gap-1.5 rounded px-1 py-0.5 text-[11px] leading-tight transition hover:bg-white/10"
              title={todo.detail.trim().length > 0 ? todo.detail : `${todo.title}（点击完成）`}
            >
              <span
                className={`mt-[1px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[8px] transition ${
                  todo.done
                    ? 'border-sky-300/70 bg-sky-400/30 text-white'
                    : 'border-white/40 group-hover:border-sky-300'
                }`}
              >
                {todo.done ? '✓' : ''}
              </span>
              <span className={`min-w-0 flex-1 ${todo.done ? 'line-through opacity-45' : 'opacity-90'}`}>
                {todo.title}
              </span>
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
