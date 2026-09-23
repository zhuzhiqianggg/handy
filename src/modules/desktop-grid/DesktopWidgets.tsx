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
export function noteAccent(accent: GridAccent | undefined): { label: string; paper: string; swatch: string; hex: string } {
  return NOTE_ACCENTS[accent ?? ''] ?? NOTE_ACCENTS[''];
}

// —— 日历主题（V48） ——

/**
 * 日历挂件的**可切换主题**。
 *
 * # 为什么要有这张表
 *
 * 用户 09-19 原话：「这个日历样式是不是缺少点什么东西，我们不用非要跟桌面透明样式，
 * 我们可以设计自己的非常漂亮的样式，可以多设置风格让用户自己选择风格」。
 *
 * V47 及以前，日历与便签共用 `accent` 那一套**卡片磨砂底**（`cardBackground`），
 * 差别只是一层几乎看不出的色相偏移 —— 用户的实际感受就是「这个格子里面的配置变化
 * 没什么用，没有什么明显变化」。根因是**同一套配色用在了两种完全不同的画布上**：
 * 便签要的是「浅色纸 + 深字」，日历要的是「一整块自洽的日历版面」（深底浅字或
 * 浅底深字成套配齐），只改一层半透明底色当然看不出区别。
 *
 * 所以这里的主题是**整套**的：外壳底色、主字色、次级字色、今天 / 选中的高亮、
 * 节日与节气的强调色、计划清单的分隔与输入框 —— 一次换掉，一眼就能看出区别。
 * 键沿用 `GridAccent`（`grid_boxes.accent` 这一列已经在库里、已有选择器 UI），
 * 所以**不需要数据库迁移**：对日历格来说，`accent` 的语义就是「主题」。
 *
 * ⚠️ 主题必须是**自洽的**（底色与字色成套），不要在这里混用便签的 `NOTE_ACCENTS`
 * —— 那张表的字色是给浅底准备的，配到深底主题上会直接看不见。
 */
export interface CalendarTheme {
  /** 选择器里的名字 */
  label: string;
  /** 外壳：底色 + 主字色（整块挂件的画布） */
  shell: string;
  /** 星期行 */
  week: string;
  /** 日期格非选中态悬停 */
  hover: string;
  /** 今天（未选中） */
  today: string;
  /** 选中日 */
  selected: string;
  /** 农历 / 节气那一行 */
  sub: string;
  /** 节日 / 休息日强调 */
  festival: string;
  /** 休 / 班角标 */
  badgeOff: string;
  badgeMakeup: string;
  /** 计划清单行悬停 */
  rowHover: string;
  /** 新增计划的输入框 */
  input: string;
  /** 分隔线（顶部标题下 / 底部） */
  divider: string;
  /** 主题预览用的色点 */
  swatch: string;
}

/**
 * 七套主题。默认那套（`''`）走**深色玻璃**：任何壁纸上都读得清，也是用户最熟悉的观感；
 * 另外六套是明确的浅色纸感，各配一种色相 —— 想要「漂亮一点」的用户可以直接换。
 */
export const CALENDAR_THEMES: Record<GridAccent, CalendarTheme> = {
  '': {
    label: '深色玻璃（默认）',
    // V61：外壳不再自带「深色底 + 描边」。它现在住在**工作台的卡片里**，再叠一层
    // `neutral-950/72` 加一圈 ring，读起来就是「一张卡片里贴了另一张卡片」——
    // 用户 09-21 说的「样式不够自然……要融为几个整体」有一半来自这里。
    // V62 再压一档（0.18 → 0.12）：工作台加宽后日历成了主角，底越淡它越像**长在卡片上
    // 的一段**而不是卡片里的一块。⚠️ 六套浅色主题的 shell **不动** —— 它们的底本身
    // 就是主题的一部分（浅底 + 深字），去掉就看不见字了。
    shell: 'bg-black/[0.12] text-neutral-100',
    week: 'text-neutral-300/70',
    hover: 'hover:bg-white/15',
    today: 'bg-white/[0.07] ring-1 ring-inset ring-sky-400/80',
    selected: 'bg-sky-500 font-semibold text-white shadow-sm',
    sub: 'text-neutral-300/70',
    festival: 'text-red-300',
    badgeOff: 'bg-red-500/35 text-red-200',
    badgeMakeup: 'bg-white/25 text-neutral-200',
    rowHover: 'hover:bg-white/15',
    input: 'bg-white/15 text-neutral-100 ring-1 ring-white/10 placeholder:text-neutral-300/60 focus:ring-sky-400/70',
    divider: 'border-white/10',
    swatch: 'bg-neutral-800',
  },
  amber: {
    label: '暖纸',
    shell: 'bg-gradient-to-b from-amber-50 to-amber-100 text-amber-950 ring-1 ring-amber-900/15',
    week: 'text-amber-900/70',
    hover: 'hover:bg-amber-900/10',
    today: 'bg-amber-900/10 ring-1 ring-inset ring-amber-600/50',
    selected: 'bg-amber-600 font-semibold text-white shadow-sm',
    sub: 'text-amber-900/65',
    festival: 'text-red-600',
    badgeOff: 'bg-red-500/20 text-red-700',
    badgeMakeup: 'bg-amber-900/15 text-amber-900',
    rowHover: 'hover:bg-amber-900/10',
    input: 'bg-white/70 text-amber-950 ring-1 ring-amber-900/20 placeholder:text-amber-900/45 focus:ring-amber-600/70',
    divider: 'border-amber-900/15',
    swatch: 'bg-amber-300',
  },
  rose: {
    label: '樱粉',
    shell: 'bg-gradient-to-b from-rose-50 to-rose-100 text-rose-950 ring-1 ring-rose-900/15',
    week: 'text-rose-900/70',
    hover: 'hover:bg-rose-900/10',
    today: 'bg-rose-900/10 ring-1 ring-inset ring-rose-500/50',
    selected: 'bg-rose-600 font-semibold text-white shadow-sm',
    sub: 'text-rose-900/65',
    festival: 'text-red-600',
    badgeOff: 'bg-red-500/20 text-red-700',
    badgeMakeup: 'bg-rose-900/15 text-rose-900',
    rowHover: 'hover:bg-rose-900/10',
    input: 'bg-white/70 text-rose-950 ring-1 ring-rose-900/20 placeholder:text-rose-900/45 focus:ring-rose-500/70',
    divider: 'border-rose-900/15',
    swatch: 'bg-rose-300',
  },
  sky: {
    label: '天蓝',
    shell: 'bg-gradient-to-b from-sky-50 to-sky-100 text-sky-950 ring-1 ring-sky-900/15',
    week: 'text-sky-900/70',
    hover: 'hover:bg-sky-900/10',
    today: 'bg-sky-900/10 ring-1 ring-inset ring-sky-500/50',
    selected: 'bg-sky-600 font-semibold text-white shadow-sm',
    sub: 'text-sky-900/65',
    festival: 'text-red-600',
    badgeOff: 'bg-red-500/20 text-red-700',
    badgeMakeup: 'bg-sky-900/15 text-sky-900',
    rowHover: 'hover:bg-sky-900/10',
    input: 'bg-white/70 text-sky-950 ring-1 ring-sky-900/20 placeholder:text-sky-900/45 focus:ring-sky-500/70',
    divider: 'border-sky-900/15',
    swatch: 'bg-sky-300',
  },
  emerald: {
    label: '薄荷',
    shell: 'bg-gradient-to-b from-emerald-50 to-emerald-100 text-emerald-950 ring-1 ring-emerald-900/15',
    week: 'text-emerald-900/70',
    hover: 'hover:bg-emerald-900/10',
    today: 'bg-emerald-900/10 ring-1 ring-inset ring-emerald-600/50',
    selected: 'bg-emerald-600 font-semibold text-white shadow-sm',
    sub: 'text-emerald-900/65',
    festival: 'text-red-600',
    badgeOff: 'bg-red-500/20 text-red-700',
    badgeMakeup: 'bg-emerald-900/15 text-emerald-900',
    rowHover: 'hover:bg-emerald-900/10',
    input: 'bg-white/70 text-emerald-950 ring-1 ring-emerald-900/20 placeholder:text-emerald-900/45 focus:ring-emerald-600/70',
    divider: 'border-emerald-900/15',
    swatch: 'bg-emerald-300',
  },
  violet: {
    label: '藕紫',
    shell: 'bg-gradient-to-b from-violet-50 to-violet-100 text-violet-950 ring-1 ring-violet-900/15',
    week: 'text-violet-900/70',
    hover: 'hover:bg-violet-900/10',
    today: 'bg-violet-900/10 ring-1 ring-inset ring-violet-500/50',
    selected: 'bg-violet-600 font-semibold text-white shadow-sm',
    sub: 'text-violet-900/65',
    festival: 'text-red-600',
    badgeOff: 'bg-red-500/20 text-red-700',
    badgeMakeup: 'bg-violet-900/15 text-violet-900',
    rowHover: 'hover:bg-violet-900/10',
    input: 'bg-white/70 text-violet-950 ring-1 ring-violet-900/20 placeholder:text-violet-900/45 focus:ring-violet-500/70',
    divider: 'border-violet-900/15',
    swatch: 'bg-violet-300',
  },
  slate: {
    label: '素白',
    shell: 'bg-gradient-to-b from-slate-50 to-slate-200 text-slate-900 ring-1 ring-slate-900/15',
    week: 'text-slate-600',
    hover: 'hover:bg-slate-900/10',
    today: 'bg-slate-900/10 ring-1 ring-inset ring-slate-600/50',
    selected: 'bg-slate-800 font-semibold text-white shadow-sm',
    sub: 'text-slate-600',
    festival: 'text-red-600',
    badgeOff: 'bg-red-500/20 text-red-700',
    badgeMakeup: 'bg-slate-900/15 text-slate-900',
    rowHover: 'hover:bg-slate-900/10',
    input: 'bg-white/80 text-slate-900 ring-1 ring-slate-900/20 placeholder:text-slate-500 focus:ring-slate-700/70',
    divider: 'border-slate-900/15',
    swatch: 'bg-slate-300',
  },
};

/** 取日历主题（未知键回落默认） */
export function calendarTheme(accent: GridAccent | undefined): CalendarTheme {
  return CALENDAR_THEMES[accent ?? ''] ?? CALENDAR_THEMES[''];
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
      // V63：`min-h-[90px]` → **`min-h-full`**。用户 09-21 附截图：「新建的便签格子为什么
      // 是这样的，一半有白色背景 一半是黑色」—— 便签纸是一张只铺到 90px 的纸条，而格子
      // 比它高（新建格子默认 244 高），下面那截就露出卡片的深色磨砂底，看起来像「卡坏了」。
      //
      // 现在纸**铺满整个内容区**：格子比内容高时纸跟着拉满（`min-h-full`），内容更长时纸
      // 继续往下长（外层 `overflow-y-auto` 接管滚动）。90px 保底挪到内层 `RichMarkdown`
      // 上 —— 盒子被用户拉到极扁时，纸至少还有一行的高度可以点。
      // V64：纸还要是**一根 flex 列** —— 光 `min-h-full` 只保证「纸」铺满卡片，里面那层
      // 编辑器（`RichMarkdown`）的高度仍是 auto（内容撑开），于是空便签只有**第一行**
      // 落在编辑器里：鼠标划过下面是默认箭头、点下去也不落光标（用户 09-21：「便签整个
      // 内容区域鼠标应该都变成光标形状，而不是只有顶部一行才能变成光标输入形状」）。
      // 现在纸自己是一列、编辑器拿 `flex-1`，编辑区就**铺满整张纸**。
      className={`flex w-full min-h-full select-text flex-col bg-gradient-to-b ${noteAccent(accent).paper} shadow-[0_8px_30px_rgba(0,0,0,0.25),0_0_0_1px_rgba(0,0,0,0.05),inset_0_1px_0_rgba(255,255,255,0.7)]`}
      // 便签内部的一切鼠标操作都不该触发盒子的「拖动标题」逻辑
      onMouseDown={(event) => event.stopPropagation()}
    >
      <RichMarkdown
        value={draft}
        onChange={handleChange}
        placeholder="随手写点什么…支持 Markdown，边写边渲染"
        ariaLabel="桌面便签"
        // `flex-1 min-h-[90px]`：跟着纸的高度铺满整张便签（见上面那段 V64 说明）。
        className="note-markdown w-full min-h-[90px] flex-1 px-3 py-2.5 text-[13px] leading-relaxed"
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
  accent,
  onContentHeight,
}: {
  /** 主题键（V48）：见 [`CALENDAR_THEMES`] —— 对日历格来说 `accent` 就是「主题」 */
  accent?: GridAccent;
  /** 上报「内容自然高度」（逻辑像素）；父级据此把盒子调到刚好装下 */
  onContentHeight?: (naturalHeight: number) => void;
}): React.JSX.Element {
  /** 主题（V48）：整套换色，而不是只换一层底 */
  const theme = calendarTheme(accent);
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
      className={`flex h-full min-h-0 flex-col gap-1.5 overflow-hidden rounded-lg p-1 ${theme.shell}`}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="flex shrink-0 items-center gap-1">
        <CalendarDays className="h-4 w-4 opacity-70" />
        <span className="text-[13px] font-semibold">
          {view.year} 年 {view.month + 1} 月
        </span>
        <span className="rounded bg-black/10 px-1 py-px text-[10px] font-medium">
          {gz.ganZhi}年 · 属{gz.zodiac}
        </span>
        <button
          type="button"
          title="上个月"
          onClick={() => shiftMonth(-1)}
          className={`ml-auto rounded p-0.5 opacity-75 transition hover:opacity-100 ${theme.hover}`}
        >
          <ChevronLeft className="h-4 w-4" />
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
          className={`rounded px-1 py-px text-[11px] font-medium opacity-75 transition hover:opacity-100 ${theme.hover}`}
        >
          今天
        </button>
        <button
          type="button"
          title="下个月"
          onClick={() => shiftMonth(1)}
          className={`rounded p-0.5 opacity-75 transition hover:opacity-100 ${theme.hover}`}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {/* —— 月历（V48：**正方形日期格**） ——
          用户原话：「貌似日期格子宽度太宽都在浪费快速空间，反而让日历格子左右不均衡，
          正常不应该每个字是正方形更好看吗」。
          V47 及以前是 `grid-cols-7` 撑满整条盒子宽度，盒子一宽（360px）单格就变成
          约 48×30 的扁矩形 —— 横向浪费、纵向挤，左右还因为标题行而显得不齐。
          现在给每格 `aspect-square`：日期格永远是正方形。

          **V62：去掉 `max-w-[288px]`。** 那个上限是当年「日历格子」时代留下的 ——
          盒子被用户拉到 460 宽，日历本体却只占 288，多出来的全是两侧留白（09-19
          「日历这里总宽度没有收回来」）。但工作台是**固定 400 宽**的常驻列，不存在
          「被拉宽」这回事；限宽反而把日期格锁死在 41px、字号压到 12px，正是用户
          09-21 说的「日历等都不清晰」。现在网格随卡片宽度自适应（400 → 每格约 54px）。 */}
      <div className="shrink-0">
        <div className="mx-auto w-full">
          <div className={`grid grid-cols-7 text-center text-[11px] font-medium ${theme.week}`}>
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
                // `aspect-square`（V48）：不管盒子多宽，日期格永远是正方形（用户要求）
                className={`relative flex aspect-square flex-col items-center justify-start rounded-md px-0.5 py-0.5 leading-none transition ${
                  isSelected ? theme.selected : isToday ? theme.today : theme.hover
                } ${inMonth ? '' : 'opacity-35'}`}
              >
                {/* 第 1 行：公历日（V48：改成与格子同宽的方阵里居中，字号随方块走；
                    V62 随工作台加宽 12 → 13px） */}
                <span
                  className={`text-[13px] font-medium tabular-nums ${
                    isSelected ? '' : isOff ? theme.festival : ''
                  }`}
                >
                  {date.getDate()}
                </span>
                {/* 第 2 行：农历 / 节气 / 节日（V62：9 → 10px，在 54px 的方格里才站稳） */}
                <span
                  className={`mt-0.5 w-full truncate text-center text-[10px] leading-none ${
                    isSelected
                      ? 'opacity-85'
                      : festival !== null
                        ? `font-medium ${theme.festival}`
                        : term !== null
                          ? 'font-medium opacity-90'
                          : theme.sub
                  }`}
                >
                  {meta?.info.badge ?? ''}
                </span>
                {/* 第 3 行：**标记行** —— 计划（琥珀点，一个点代表有、两个代表 3 条以上）
                    与生日纪念日（蛋糕粉标）；放在专属一行才看得清，不再和休/班挤角落。
                    V62：点 4→5px、蛋糕 7→9px —— 日期格变大后原来那点显得太小、看不清
                    「这天到底有没有事」。 */}
                <span className="mt-auto flex h-[9px] items-center justify-center gap-0.5">
                  {pending > 0 ? (
                    <>
                      <span
                        className={`h-[5px] w-[5px] rounded-full ${
                          isSelected ? 'bg-white' : 'bg-amber-500'
                        }`}
                      />
                      {pending > 2 ? (
                        <span
                          className={`h-[5px] w-[5px] rounded-full ${
                            isSelected ? 'bg-white/70' : 'bg-amber-500/60'
                          }`}
                        />
                      ) : null}
                    </>
                  ) : null}
                  {marks.length > 0 ? (
                    <Cake
                      className={`h-[9px] w-[9px] ${isSelected ? 'text-white' : 'text-pink-500'}`}
                      strokeWidth={2.5}
                    />
                  ) : null}
                </span>
                {/* 休 / 班：右上角小方标（V62：8 → 9px，随日期格一起放大） */}
                {isOff || isMakeup ? (
                  <span
                    className={`absolute right-0 top-0 rounded-sm px-[3px] text-[9px] font-medium leading-[11px] ${
                      isSelected ? 'bg-black/25 text-white' : isOff ? theme.badgeOff : theme.badgeMakeup
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
      </div>

      {nextHolidays.length > 0 ? (
        <p className={`shrink-0 text-[11px] ${theme.sub}`}>
          {nextHolidays[0]!.inDays === 0
            ? `正在放「${nextHolidays[0]!.name}」`
            : `下个假期：${nextHolidays[0]!.name}（${nextHolidays[0]!.inDays} 天后 · ${nextHolidays[0]!.days} 天）`}
        </p>
      ) : null}

      <div className="shrink-0">
        <p className={`mb-0.5 text-[11px] font-medium ${theme.sub}`}>
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
            className={`min-w-0 flex-1 rounded px-1.5 py-1.5 text-[12px] outline-none ${theme.input}`}
          />
          <button
            type="button"
            title="添加计划"
            onClick={add}
            className={`shrink-0 rounded p-1 opacity-80 transition hover:opacity-100 ${theme.hover}`}
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* 计划清单：**不做滚动容器**（不做 flex-1 / overflow-auto）—— 让父级按自然
          高度把盒子撑开；真的超出屏幕上限时才由父级兜底裁切。 */}
      <div className={`shrink-0 space-y-0.5 border-t pt-1 ${theme.divider}`}>
        {rows.length === 0 ? (
          <p className={`py-2 text-center text-[11px] ${theme.sub}`}>这一天没有计划，轻松一下</p>
        ) : (
          rows.map((todo) => (
            <div
              key={todo.id}
              onClick={() => toggle(todo)}
              style={{ minHeight: PLAN_ROW_H }}
              className={`group flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-[12px] leading-tight transition ${theme.rowHover}`}
              title={todo.detail.trim().length > 0 ? todo.detail : `${todo.title}（点击完成）`}
            >
              <span
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[9px] transition ${
                  todo.done ? 'border-sky-500/70 bg-sky-500/40 text-white' : 'border-current opacity-60'
                }`}
              >
                {todo.done ? '✓' : ''}
              </span>
              <span className={`min-w-0 flex-1 ${todo.done ? 'line-through opacity-50' : 'opacity-95'}`}>
                {todo.title}
              </span>
              {todo.priority >= 2 ? (
                <span
                  className={`shrink-0 rounded px-1 text-[10px] text-white ${
                    todo.priority === 3 ? 'bg-red-500/80' : 'bg-amber-500/80'
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
