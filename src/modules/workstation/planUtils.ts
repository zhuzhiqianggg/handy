import type { Todo } from '@/core/data/todosService';

/**
 * 工作台「日历 + 计划」纯函数工具集。
 *
 * 全部以**本地时间**计算（工作台是本地效率工具，不引入时区切换概念），
 * 日期加减一律走 `Date.setDate` 而非 `±86400000`，避免夏令时导致「零点漂移」。
 */

/** 一天毫秒数（仅用于差值估算，不用于日期加减） */
export const DAY_MS = 86_400_000;

/** 计划范围 */
export type PlanScope = 'day' | 'week' | 'month' | 'undated' | 'all';

/** 范围中文名（界面 chip 与空态文案共用） */
export const SCOPE_LABELS: Record<PlanScope, string> = {
  day: '当日',
  week: '本周',
  month: '本月',
  undated: '无日期',
  all: '全部',
};

/** 本地当天零点 */
export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 按「日」加减（自动跨月跨年，规避夏令时） */
export function addDays(ms: number, days: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 所在周的周一零点（周一开始，符合国内习惯） */
export function startOfWeek(ms: number): number {
  const day = startOfDay(ms);
  const offset = (new Date(day).getDay() + 6) % 7; // 周一 = 0
  return addDays(day, -offset);
}

/** 所在月的一号零点 */
export function startOfMonth(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

/** 下月一号零点 */
export function startOfNextMonth(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
}

/** 该月天数 */
export function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/**
 * 月历网格（6 行 × 7 列 = 42 天），首格为包含该月 1 号的**那周的周一**。
 * 固定 42 格可保证月份切换时行高不跳动。
 */
export function buildMonthGrid(year: number, monthIndex: number): number[] {
  const gridStart = startOfWeek(new Date(year, monthIndex, 1).getTime());
  return Array.from({ length: 42 }, (_, index) => addDays(gridStart, index));
}

/** 范围 → [from, to) 毫秒区间；`undated` / `all` 返回 null（不做时间过滤） */
export function scopeRange(scope: PlanScope, anchorMs: number): { from: number; to: number } | null {
  switch (scope) {
    case 'day':
      return { from: startOfDay(anchorMs), to: addDays(anchorMs, 1) };
    case 'week': {
      const from = startOfWeek(anchorMs);
      return { from, to: addDays(from, 7) };
    }
    case 'month':
      return { from: startOfMonth(anchorMs), to: startOfNextMonth(anchorMs) };
    default:
      return null;
  }
}

/** 按范围 + 「隐藏已完成」筛选待办（保持 store 传入的顺序） */
export function filterTodos(
  todos: readonly Todo[],
  scope: PlanScope,
  anchorMs: number,
  hideDone: boolean,
): Todo[] {
  const range = scopeRange(scope, anchorMs);
  return todos.filter((todo) => {
    if (hideDone && todo.done) {
      return false;
    }
    if (scope === 'all') {
      return true;
    }
    if (scope === 'undated') {
      return todo.dueAt === null;
    }
    if (todo.dueAt === null) {
      return false;
    }
    return range !== null && todo.dueAt >= range.from && todo.dueAt < range.to;
  });
}

/** 每天的未完成待办数（日历圆点用）；键为当天零点毫秒 */
export function pendingCountByDay(todos: readonly Todo[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const todo of todos) {
    if (todo.done || todo.dueAt === null) {
      continue;
    }
    const key = startOfDay(todo.dueAt);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

/** 同一天？ */
export function isSameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

/** 日期短标签（如 `9月16日 周三`） */
export function dayLabel(ms: number): string {
  const d = new Date(ms);
  const weekday = '日一二三四五六'[d.getDay()] ?? '';
  return `${d.getMonth() + 1}月${d.getDate()}日 周${weekday}`;
}

/** 相对今天的口语化标签（今天 / 明天 / 昨天 / 9月16日 周三） */
export function relativeDayLabel(ms: number): string {
  const today = startOfDay(Date.now());
  const diff = Math.round((startOfDay(ms) - today) / DAY_MS);
  if (diff === 0) {
    return '今天';
  }
  if (diff === 1) {
    return '明天';
  }
  if (diff === -1) {
    return '昨天';
  }
  return dayLabel(ms);
}

/** 时间标签：今天/明天只显示时刻，其余显示「月-日」 */
export function dueLabel(dueAt: number): string {
  const d = new Date(dueAt);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const today = startOfDay(Date.now());
  const day = startOfDay(dueAt);
  if (day === today) {
    return time;
  }
  if (day === addDays(today, 1)) {
    return `明天 ${time}`;
  }
  if (day === addDays(today, -1)) {
    return `昨天 ${time}`;
  }
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${time}`;
}

/** 是否已逾期（未完成且到期时间早于此刻） */
export function isOverdue(todo: Todo): boolean {
  return !todo.done && todo.dueAt !== null && todo.dueAt < Date.now();
}

/** 把某天 09:00 作为新建事件的默认时刻（比 00:00 更贴近真实使用） */
export function defaultMomentOfDay(dayMs: number): number {
  const d = new Date(dayMs);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}
