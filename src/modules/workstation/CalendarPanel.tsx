import React, { useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { buildMonthGrid, dayLabel, isSameDay, startOfDay } from './planUtils';

/**
 * 工作台月历面板。
 *
 * 交互约定：
 *   - 单击某天 → 选中该天（父级据此切换计划列表范围，并把「添加事件」挂到这一天）；
 *   - 悬停日期格右侧出现「＋」→ 同样是选中该天（父级会聚焦输入框，形成「点日历即记事件」）；
 *   - 有未完成待办的日期显示圆点 + 条数；
 *   - 顶部「‹ 年月 ›」翻月，「回到今天」一键回到本月。
 *
 * 设计取向上刻意保持**无第三方日历库**：42 格固定网格 + 本地日期工具（planUtils），
 * 行为可预测、零额外依赖、渲染开销极小。
 */

export interface CalendarPanelProps {
  /** 当前选中的日期（本地零点毫秒） */
  anchorMs: number;
  /** 选中某天 */
  onSelect: (dayMs: number) => void;
  /** 每天的未完成待办数（键为当天零点毫秒） */
  pendingByDay: ReadonlyMap<number, number>;
}

/** 星期表头（周一开始，与 startOfWeek 一致） */
const WEEKDAY_HEADERS: readonly string[] = ['一', '二', '三', '四', '五', '六', '日'];

export function CalendarPanel({ anchorMs, onSelect, pendingByDay }: CalendarPanelProps): React.JSX.Element {
  const anchorDate = useMemo(() => new Date(anchorMs), [anchorMs]);
  /** 当前展示的月份（与选中日期解耦，允许翻月浏览后仍保留选中） */
  const [view, setView] = useState<{ year: number; month: number }>(() => ({
    year: anchorDate.getFullYear(),
    month: anchorDate.getMonth(),
  }));

  // 选中日期跨月（例如点「回到今天」或从别处跳转）时，视图月份跟随
  useEffect(() => {
    setView({ year: anchorDate.getFullYear(), month: anchorDate.getMonth() });
  }, [anchorDate]);

  const cells = useMemo(() => buildMonthGrid(view.year, view.month), [view]);
  const todayMs = startOfDay(Date.now());
  const monthPrefix = `${view.year}-${String(view.month + 1).padStart(2, '0')}-`;

  const shiftMonth = (delta: number): void => {
    setView((prev) => {
      const d = new Date(prev.year, prev.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  };

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-panel">
      <header className="flex items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-muted text-brand">
          <CalendarDays className="h-4 w-4" />
        </span>
        <h3 className="text-sm font-semibold tabular-nums text-foreground">
          {view.year} 年 {view.month + 1} 月
        </h3>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => shiftMonth(-1)} aria-label="上个月">
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={() => onSelect(todayMs)}
          >
            今天
          </Button>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => shiftMonth(1)} aria-label="下个月">
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-muted-foreground">
        {WEEKDAY_HEADERS.map((label) => (
          <span key={label} className="py-0.5">
            {label}
          </span>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {cells.map((dayMs) => {
          const date = new Date(dayMs);
          const inMonth = date.getMonth() === view.month && date.getFullYear() === view.year;
          const isToday = dayMs === todayMs;
          const isSelected = isSameDay(dayMs, anchorMs);
          const pending = pendingByDay.get(dayMs) ?? 0;
          return (
            <button
              key={dayMs}
              type="button"
              onClick={() => onSelect(dayMs)}
              title={`${dayLabel(dayMs)}${pending > 0 ? ` · ${pending} 项未完成` : ''}`}
              className={cn(
                'group relative flex h-9 flex-col items-center justify-center rounded-lg text-xs transition',
                inMonth ? 'text-foreground' : 'text-muted-foreground/45',
                !isSelected && 'hover:bg-accent',
                isSelected && 'bg-brand font-semibold text-brand-foreground',
                isToday && !isSelected && 'ring-1 ring-inset ring-brand/50',
              )}
            >
              <span className="tabular-nums leading-none">{date.getDate()}</span>
              {pending > 0 ? (
                <span
                  className={cn(
                    'mt-0.5 flex items-center gap-0.5 text-[9px] leading-none',
                    isSelected ? 'text-brand-foreground/90' : 'text-brand',
                  )}
                >
                  <span className="inline-block h-1 w-1 rounded-full bg-current" />
                  {pending}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        单击日期即把「新增事件」挂到这一天；圆点表示该日未完成的条目数。
      </p>
    </section>
  );
}

export default CalendarPanel;
