import React, { useEffect, useMemo, useState } from 'react';
import { CalendarDays, Pin, PinOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useTodosStore } from '@/stores/useTodosStore';
import { useNotesStore } from '@/stores/useNotesStore';
import { useAppStore } from '@/stores/useAppStore';
import { CalendarPanel } from './CalendarPanel';
import { PlanPanel } from './PlanPanel';
import { NotesPanel } from './NotesPanel';
import { QuickActionsRail } from './QuickActionsRail';
import {
  addDays,
  pendingCountByDay,
  relativeDayLabel,
  startOfDay,
  startOfWeek,
  startOfMonth,
  startOfNextMonth,
  type PlanScope,
} from './planUtils';

/**
 * 工作台（路由 id 仍为 `notes`，便于零迁移）。
 *
 * # 布局（V20 按用户反馈重排）
 *
 * ```
 * ┌──────────────────────────────────────────┬──────┐
 * │ 问候 / 日期 / 概览数字          时钟 贴到顶 │ 快捷 │
 * ├───────────────────────┬──────────────────┤ 入口 │
 * │  日历（左）            │  任务列表（右）   │ 竖排 │
 * │  ← 与右侧**等高**      │  ← 日期/范围/新增 │ 图标 │
 * ├───────────────────────┴──────────────────┤ 栏   │
 * │  便签（全宽 · 编辑/预览 · 右键贴到桌面）    │      │
 * └──────────────────────────────────────────┴──────┘
 * ```
 *
 * 用户原话：「工作台结构应该前面任务管理左边日历右边是任务列表等，高度相同；
 * 下面笔记改成便签；快捷入口应该要放在一个随手可以点击到的地方……竖排大图标」。
 *
 * 数据说明：待办与便签**完全复用**既有 `useTodosStore` / `useNotesStore`（同一份 SQLite），
 * 因此工作台与「待办清单」命令看到的是同一批数据，改动实时互通。
 */

/** 中文星期（getDay：0 = 周日） */
const WEEKDAYS: readonly string[] = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

export interface WorkstationViewProps {
  /** 兼容 CommandProps（命令视图注入，未使用） */
  initialInput?: string;
  /** 兼容 ModuleProps（模块内页注入，未使用） */
  windowKind?: string;
}

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

  // —— 待办（复用既有数据层）——
  const todos = useTodosStore((state) => state.todos);
  const todosError = useTodosStore((state) => state.error);
  const hydrateTodos = useTodosStore((state) => state.hydrate);
  useEffect(() => {
    void hydrateTodos();
  }, [hydrateTodos]);

  // —— 便签（复用既有数据层，仅做加载与统计）——
  const notes = useNotesStore((state) => state.notes);
  const hydrateNotes = useNotesStore((state) => state.hydrate);
  useEffect(() => {
    void hydrateNotes();
  }, [hydrateNotes]);

  // —— 日历 / 范围状态 ——
  const [anchorMs, setAnchorMs] = useState<number>(() => startOfDay(Date.now()));
  const [scope, setScope] = useState<PlanScope>('day');
  const [hideDone, setHideDone] = useState<boolean>(false);
  /** 递增信号：点日历后聚焦「新增事件」输入框 */
  const [focusToken, setFocusToken] = useState<number>(0);

  // —— 顶部贴条常驻开关（settings.barPinned 为唯一事实源，窗口显隐由 main.tsx 订阅驱动）——
  const barPinned = useAppStore((state) => state.settings.barPinned);
  const updateSettings = useAppStore((state) => state.updateSettings);

  const pendingByDay = useMemo(() => pendingCountByDay(todos), [todos]);

  /** 头部概览：今日 / 本周 / 本月 未完成数 */
  const overview = useMemo(() => {
    const today = startOfDay(Date.now());
    const weekEnd = addDays(startOfWeek(Date.now()), 7);
    const monthEnd = startOfNextMonth(Date.now());
    let todayCount = 0;
    let weekCount = 0;
    let monthCount = 0;
    let overdue = 0;
    for (const todo of todos) {
      if (todo.done) {
        continue;
      }
      if (todo.dueAt !== null) {
        if (todo.dueAt >= today && todo.dueAt < addDays(today, 1)) {
          todayCount += 1;
        }
        if (todo.dueAt >= startOfWeek(Date.now()) && todo.dueAt < weekEnd) {
          weekCount += 1;
        }
        if (todo.dueAt >= startOfMonth(Date.now()) && todo.dueAt < monthEnd) {
          monthCount += 1;
        }
        if (todo.dueAt < today) {
          overdue += 1;
        }
      }
    }
    return { todayCount, weekCount, monthCount, overdue, noteCount: notes.length };
  }, [todos, notes.length]);

  const handleSelectDay = (dayMs: number): void => {
    setAnchorMs(startOfDay(dayMs));
    setScope('day');
    setFocusToken((token) => token + 1);
  };

  /**
   * 切换「今日概览」贴条常驻：写 `settings.barPinned` 即可 ——
   * 窗口显隐由 `main.tsx` 订阅该字段驱动（`bar_show` / `bar_hide`）。
   */
  const handlePinBar = (): void => {
    const next = !barPinned;
    void updateSettings({ barPinned: next }).catch((error: unknown) => {
      toast.error('贴条设置失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    });
    if (!next) {
      return;
    }
    toast.success('已贴到桌面顶部', {
      description: '贴条上可直接勾掉完成项、下拉展开全部今日待办；点「×」或再按一次本按钮即可取消常驻',
    });
  };

  const statChip = (label: string, value: number, tone: 'normal' | 'warn' = 'normal'): React.JSX.Element => (
    <span
      className={
        tone === 'warn' && value > 0
          ? 'rounded-md bg-destructive/10 px-2 py-0.5 text-[11px] text-destructive'
          : 'rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground'
      }
    >
      {label} <span className="font-semibold tabular-nums text-foreground">{value}</span>
    </span>
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* —— 问候头部 —— */}
      <header className="flex flex-wrap items-end justify-between gap-4 px-6 pb-4 pt-5">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-foreground">{greeting}</h1>
          <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <CalendarDays className="h-3.5 w-3.5" />
            {dateLabel}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {statChip('今日', overview.todayCount)}
            {statChip('本周', overview.weekCount)}
            {statChip('本月', overview.monthCount)}
            {overview.overdue > 0 ? statChip('逾期', overview.overdue, 'warn') : null}
            {statChip('便签', overview.noteCount)}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <p className="text-2xl font-semibold tabular-nums text-brand" title="当前时间">
            {clockLabel}
          </p>
          <p className="text-[11px] text-muted-foreground">
            当前查看：{relativeDayLabel(anchorMs)}
          </p>
          <Button
            variant={barPinned ? 'default' : 'outline'}
            size="sm"
            className="h-7 px-2.5 text-xs"
            onClick={handlePinBar}
            title={barPinned ? '取消常驻：贴条将从桌面顶部收起' : '把今日概览贴到桌面顶部并常驻'}
          >
            {barPinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
            {barPinned ? '已常驻桌面顶部' : '贴到桌面顶部'}
          </Button>
        </div>
      </header>

      {todosError !== null ? (
        <div className="mx-6 mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          加载待办失败：{todosError}
        </div>
      ) : null}

      {/* —— 主区：内容列 + 右侧快捷入口图标栏 —— */}
      <div className="flex min-h-0 flex-1 gap-4 px-6 pb-6">
        <div className="scrollbar-thin min-w-0 flex-1 overflow-auto pr-1">
          {/* 上排：日历（左） | 任务列表（右）—— 两栏等高 */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,350px)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col [&>section]:h-full">
              <CalendarPanel anchorMs={anchorMs} onSelect={handleSelectDay} pendingByDay={pendingByDay} />
            </div>
            <div className="flex min-w-0 flex-col [&>section]:h-full">
              <PlanPanel
                todos={todos}
                anchorMs={anchorMs}
                scope={scope}
                onScopeChange={setScope}
                hideDone={hideDone}
                onHideDoneChange={setHideDone}
                focusToken={focusToken}
              />
            </div>
          </div>

          {/* 下排：便签（全宽） */}
          <div className="mt-4">
            <NotesPanel />
          </div>
        </div>

        {/* 右侧：竖排快捷入口（随手可点，悬停出说明） */}
        <QuickActionsRail />
      </div>
    </div>
  );
}
