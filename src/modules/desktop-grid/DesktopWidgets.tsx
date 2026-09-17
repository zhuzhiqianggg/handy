import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Cake, CalendarDays, ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { RichMarkdown } from '@/components/RichMarkdown';
import { ipc } from '@/lib/ipc';
import { readSettings } from '@/lib/store';
import {
  buildMonthGrid,
  dayLabel,
  defaultMomentOfDay,
  isSameDay,
  startOfDay,
} from '@/lib/dateUtils';
import { anniversariesOf } from '@/lib/anniversaries';
import { dayInfo, ganZhi, type DayInfo } from '@/lib/lunar';
import { holidayOf, upcomingHolidays } from '@/lib/holidays';
import type { Todo } from '@/core/data/todosService';
import type { Anniversary } from '@/core/types';
import type { GridAccent } from '@/types/grid';

/**
 * 桌面挂件（V33 引入，V34 升级，V35 增强）—— 直接长在桌面层上的轻量组件。
 *
 * 两种挂件：
 *   - **便签**（`note`）：Markdown 随手记，**所见即所得**（复用工作台的
 *     `RichMarkdown`：敲 `**粗体**` 当场就变粗体，不是「源码 + 预览」双栏），
 *     输入防抖 600ms 落库 + 失焦立即写。**V35 起可以放多个**（用户反馈），
 *     每个便签可选一种配色（`accent`），多个便签并存时一眼分得清谁是谁；
 *   - **日历 · 今日计划**（`calendar`）：与工作台 `CalendarPanel` 同一套观感 ——
 *     农历 / 二十四节气 / 法定节假日 / 休班角标 / 干支年 / **纪念日（生日）**，
 *     **点击某天即选中该天**，下方清单和新增输入都作用于该天；**鼠标悬停某天**
 *     列出当天全部计划；计划区**按条数自动撑高**（V35）。
 *     数据直接读工作台的 `todos` 表与设置里的 `anniversaries`，桌面改完工作台同步。
 *
 * 数据存放：便签正文在 `grid_boxes.content`、配色在 `grid_boxes.accent`；
 * 日历的计划共用 `todos` 表、纪念日共用设置里的 `anniversaries`，因此不需要新表。
 */

/** 便签正文自动落库防抖（毫秒） */
const NOTE_SAVE_DEBOUNCE_MS = 600;

// —— 配色 ——

/**
 * 便签配色表：**浅底 + 深字**。
 *
 * 桌面便签的第一诉求是「在任何壁纸上都读得清」，所以底色一律走浅色纸感、
 * 文字走同色系的 950 档深色（对比度远高于白底黑字的刺眼组合，也不像纯白那样
 * 在深色壁纸上糊成一团）。
 */
export const NOTE_ACCENTS: Record<GridAccent, { label: string; paper: string; swatch: string; hex: string }> = {
  '': {
    label: '暖黄（默认）',
    paper: 'from-amber-100/95 to-amber-200/90 text-amber-950',
    swatch: 'bg-amber-200',
    hex: '#fde68a',
  },
  amber: {
    label: '暖黄',
    paper: 'from-amber-100/95 to-amber-200/90 text-amber-950',
    swatch: 'bg-amber-200',
    hex: '#fde68a',
  },
  rose: {
    label: '樱粉',
    paper: 'from-rose-100/95 to-rose-200/90 text-rose-950',
    swatch: 'bg-rose-200',
    hex: '#fecdd3',
  },
  sky: {
    label: '天蓝',
    paper: 'from-sky-100/95 to-sky-200/90 text-sky-950',
    swatch: 'bg-sky-200',
    hex: '#bae6fd',
  },
  emerald: {
    label: '草绿',
    paper: 'from-emerald-100/95 to-emerald-200/90 text-emerald-950',
    swatch: 'bg-emerald-200',
    hex: '#a7f3d0',
  },
  violet: {
    label: '藕紫',
    paper: 'from-violet-100/95 to-violet-200/90 text-violet-950',
    swatch: 'bg-violet-200',
    hex: '#ddd6fe',
  },
  slate: {
    label: '素白',
    paper: 'from-slate-100/95 to-slate-200/90 text-slate-900',
    swatch: 'bg-slate-200',
    hex: '#e2e8f0',
  },
};

/** 可选配色顺序（配色选择器按这个顺序铺） */
export const ACCENT_ORDER: GridAccent[] = ['', 'amber', 'rose', 'sky', 'emerald', 'violet', 'slate'];

/** 取便签配色（未知键回落默认） */
function noteAccent(accent: GridAccent | undefined): { label: string; paper: string; swatch: string; hex: string } {
  return NOTE_ACCENTS[accent ?? ''] ?? NOTE_ACCENTS[''];
}

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
  accent,
  onSave,
}: {
  boxId: number;
  content: string;
  /** 配色键（V35：多便签并存时用来区分） */
  accent?: GridAccent;
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
      className={`h-full w-full select-text bg-gradient-to-b ${noteAccent(accent).paper}`}
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

/** 计划行高（逻辑像素）：父级据「内容自然高度」反推盒子该多高，所以这里要是准的 */
const PLAN_ROW_H = 20;

/**
 * 日历挂件：工作台 `CalendarPanel` 的桌面版。
 *
 * 与工作台**同源**（日期数学走 `@/lib/dateUtils`、纪念日走 `@/lib/anniversaries`、
 * 农历节气走 `@/lib/lunar|holidays`），所以农历 / 节气 / 节日 / 休班 / 干支 / 生日
 * 天然逐项一致，不存在两份实现漂移。
 *
 * V35 按用户反馈改了三处：
 *   ① **默认更大、字号更大**（原先把 42 格压在 300px 高里，看不清）；
 *   ② **日期格符号分层**：公历日 / 农历·节气·节日 / **标记行**（计划数 + 生日）三层，
 *      不再把「计划点 + 休 + 班」全塞在右上角那一小块；
 *   ③ **计划区按条数自动撑高**：把「内容自然高度」上报给父级（`onContentHeight`），
 *      由父级调整盒子高度 —— 计划多了不再被压成一个要滚的小窗口。
 *
 * 交互：点击某天 = 选中该天（下方清单与新增输入都作用于该天）；悬停某天用原生
 * tooltip 列出当天全部计划与纪念日。
 */
export function CalendarWidget({
  onContentHeight,
}: {
  /** 上报「内容自然高度」（逻辑像素）；父级据此把盒子调到刚好装下 */
  onContentHeight?: (naturalHeight: number) => void;
}): React.JSX.Element {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [anniversaries, setAnniversaries] = useState<readonly Anniversary[]>([]);
  const [selected, setSelected] = useState(() => startOfDay(Date.now()));
  const [view, setView] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  /** 内容根节点：用来量「自然高度」 */
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** 上次上报过的高度：避免同一高度反复 invoke */
  const lastReportRef = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setTodos(await ipc.todosList());
    } catch {
      // 读不到（例如数据库暂时不可用）保持上一次的数据，不打断桌面观感
    }
  }, []);

  /**
   * 纪念日读的是**工作台设置里那一份**（`settings.anniversaries`）。
   * 挂件窗是独立 JS 环境，没有 store，所以直接 `readSettings()` 读文件；
   * 工作台那边改了内容，这里最多 5 分钟（或下次打开应用）就跟着变。
   */
  const refreshAnniversaries = useCallback(async (): Promise<void> => {
    try {
      const settings = await readSettings();
      setAnniversaries(settings.anniversaries ?? []);
    } catch {
      /* 设置读不到不影响日历本体 */
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshAnniversaries();
    const todoTimer = window.setInterval(() => void refresh(), 60_000);
    const anniTimer = window.setInterval(() => void refreshAnniversaries(), 300_000);
    return () => {
      window.clearInterval(todoTimer);
      window.clearInterval(anniTimer);
    };
  }, [refresh, refreshAnniversaries]);

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
      .todosCreate(title, defaultMomentOfDay(selected))
      .then(() => {
        setDraft('');
        return refresh();
      })
      .catch(() => undefined)
      .finally(() => setBusy(false));
  }, [draft, busy, refresh, selected]);

  const rows = showUndated ? [...selectedTodos, ...undated] : selectedTodos;

  // —— 计划区按条数自动撑高 ——
  //
  // 做法：让**内容根节点自己去量**。根节点 `overflow-hidden` 且子元素全是 auto 高度，
  // 于是 `scrollHeight` 就等于「这份内容想占多高」，而不是「现在被压成多高」。
  // 把它交给父级，父级把盒子调到刚好装下 —— 计划增减都会自动跟随，不用用户手动拉。
  // 量完再比对上次：差值小于 8px 不上报，避免亚像素抖动引发来回 invoke。
  useEffect(() => {
    if (!onContentHeight) {
      return;
    }
    const el = rootRef.current;
    if (!el) {
      return;
    }
    const raf = window.requestAnimationFrame(() => {
      const natural = el.scrollHeight;
      if (Math.abs(natural - lastReportRef.current) >= 8) {
        lastReportRef.current = natural;
        onContentHeight(natural);
      }
    });
    return () => window.cancelAnimationFrame(raf);
  }, [onContentHeight, rows.length, view, selected, anniversaries.length, nextHolidays.length]);

  return (
    <div
      ref={rootRef}
      // overflow-hidden + 子元素全部 auto 高度 = scrollHeight 量得到「自然高度」
      className="flex h-full min-h-0 flex-col gap-1.5 overflow-hidden p-2 text-neutral-100"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="flex shrink-0 items-center gap-1">
        <CalendarDays className="h-3.5 w-3.5 opacity-70" />
        <span className="text-[12px] font-semibold [text-shadow:0_1px_2px_rgba(0,0,0,0.7)]">
          {view.year} 年 {view.month + 1} 月
        </span>
        <span className="rounded bg-white/15 px-1 py-px text-[9px] font-medium">
          {gz.ganZhi}年 · 属{gz.zodiac}
        </span>
        <button
          type="button"
          title="上个月"
          onClick={() => shiftMonth(-1)}
          className="ml-auto rounded p-0.5 opacity-75 transition hover:bg-white/20 hover:opacity-100"
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
          className="rounded px-1 py-px text-[10px] font-medium opacity-75 transition hover:bg-white/20 hover:opacity-100"
        >
          今天
        </button>
        <button
          type="button"
          title="下个月"
          onClick={() => shiftMonth(1)}
          className="rounded p-0.5 opacity-75 transition hover:bg-white/20 hover:opacity-100"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="shrink-0">
        <div className="grid grid-cols-7 text-center text-[10px] font-medium opacity-55">
          {WEEKDAYS.map((day) => (
            <span key={day}>{day}</span>
          ))}
        </div>
        <div className="mt-0.5 grid grid-cols-7 gap-px">
          {cells.map((dayMs) => {
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
            const marks = anniversariesOf(anniversaries, dayMs);

            const tooltip = [
              dayLabel(dayMs),
              meta?.info.lunar ? `农历${meta.info.lunar.monthName}${meta.info.lunar.dayName}` : null,
              meta?.name ?? null,
              term,
              marks.length > 0 ? `纪念日：${marks.map((item) => item.label).join('、')}` : null,
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
                className={`relative flex flex-col items-center rounded-md px-0.5 py-1 leading-none transition ${
                  isSelected
                    ? 'bg-sky-500 font-semibold text-white shadow-sm'
                    : isToday
                      ? 'bg-white/[0.07] ring-1 ring-inset ring-sky-400/80'
                      : 'hover:bg-white/15'
                } ${inMonth ? '' : 'opacity-30'}`}
              >
                {/* 第 1 行：公历日 + 休/班角标（贴在右上角，字号比 V34 大一档） */}
                <span
                  className={`text-[12px] font-medium tabular-nums ${
                    isSelected ? 'text-white' : isOff ? 'text-red-300' : ''
                  }`}
                >
                  {date.getDate()}
                </span>
                {/* 第 2 行：农历 / 节气 / 节日 */}
                <span
                  className={`mt-0.5 w-full truncate text-center text-[9px] leading-none ${
                    isSelected
                      ? 'text-white/85'
                      : festival !== null
                        ? 'font-medium text-red-300'
                        : term !== null
                          ? 'font-medium text-sky-300'
                          : 'opacity-60'
                  }`}
                >
                  {meta?.info.badge ?? ''}
                </span>
                {/* 第 3 行：**标记行** —— 计划（琥珀点，一个点代表有、两个代表 3 条以上）
                    与生日纪念日（蛋糕粉标）；放在专属一行才看得清，不再和休/班挤角落。 */}
                <span className="mt-0.5 flex h-[7px] items-center justify-center gap-0.5">
                  {pending > 0 ? (
                    <>
                      <span
                        className={`h-[4px] w-[4px] rounded-full ${
                          isSelected ? 'bg-white' : 'bg-amber-300'
                        }`}
                      />
                      {pending > 2 ? (
                        <span
                          className={`h-[4px] w-[4px] rounded-full ${
                            isSelected ? 'bg-white/70' : 'bg-amber-300/70'
                          }`}
                        />
                      ) : null}
                    </>
                  ) : null}
                  {marks.length > 0 ? (
                    <Cake
                      className={`h-[7px] w-[7px] ${isSelected ? 'text-white' : 'text-pink-400'}`}
                      strokeWidth={2.5}
                    />
                  ) : null}
                </span>
                {/* 休 / 班：右上角小方标 */}
                {isOff || isMakeup ? (
                  <span
                    className={`absolute right-0 top-0 rounded-sm px-[3px] text-[8px] font-medium leading-[10px] ${
                      isSelected
                        ? 'bg-white/25 text-white'
                        : isOff
                          ? 'bg-red-500/35 text-red-200'
                          : 'bg-white/25 text-neutral-200'
                    }`}
                  >
                    {isOff ? '休' : '班'}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {nextHolidays.length > 0 ? (
        <p className="shrink-0 text-[10px] opacity-60">
          {nextHolidays[0]!.inDays === 0
            ? `正在放「${nextHolidays[0]!.name}」`
            : `下个假期：${nextHolidays[0]!.name}（${nextHolidays[0]!.inDays} 天后 · ${nextHolidays[0]!.days} 天）`}
        </p>
      ) : null}

      <div className="shrink-0">
        <p className="mb-0.5 text-[10px] font-medium opacity-70">
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
            className="min-w-0 flex-1 rounded bg-white/15 px-1.5 py-1 text-[11px] text-neutral-100 outline-none ring-1 ring-white/10 placeholder:text-neutral-300/60 focus:ring-sky-400/70"
          />
          <button
            type="button"
            title="添加计划"
            onClick={add}
            className="shrink-0 rounded p-1 opacity-80 transition hover:bg-white/20 hover:opacity-100"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* 计划清单：**不做滚动容器**（不做 flex-1 / overflow-auto）—— 让父级按自然
          高度把盒子撑开；真的超出屏幕上限时才由父级兜底裁切。 */}
      <div className="shrink-0 space-y-0.5">
        {rows.length === 0 ? (
          <p className="py-2 text-center text-[10px] opacity-50">这一天没有计划，轻松一下</p>
        ) : (
          rows.map((todo) => (
            <div
              key={todo.id}
              onClick={() => toggle(todo)}
              style={{ minHeight: PLAN_ROW_H }}
              className="group flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-[11px] leading-tight transition hover:bg-white/15"
              title={todo.detail.trim().length > 0 ? todo.detail : `${todo.title}（点击完成）`}
            >
              <span
                className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[8px] transition ${
                  todo.done
                    ? 'border-sky-300/80 bg-sky-400/40 text-white'
                    : 'border-white/50 group-hover:border-sky-300'
                }`}
              >
                {todo.done ? '✓' : ''}
              </span>
              <span className={`min-w-0 flex-1 ${todo.done ? 'line-through opacity-50' : 'opacity-95'}`}>
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
