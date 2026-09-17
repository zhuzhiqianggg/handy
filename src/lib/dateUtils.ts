/**
 * 日期纯函数工具集（**本地时间**口径）。
 *
 * # 为什么独立成一个 `src/lib/` 模块
 *
 * 这批函数最早长在 `modules/workstation/planUtils.ts` 里，桌面日历挂件要用同一套
 * 口径时，第一反应是「从 workstation 里 import 过来」—— 那会在模块之间拉一条
 * 横向依赖（`desktop-grid` → `workstation`），谁先谁后说不清，日后挪文件必炸。
 *
 * 而项目约定是「**纯逻辑全在 `src/lib/`**」（见 `.workbuddy/memory/MEMORY.md` §2）。
 * 所以这里把与「计划」无关的日期数学抽出来，`planUtils` 与桌面挂件各自 import；
 * `planUtils` 同时把原名字**原样再导出**，既有调用方一行都不用改。
 *
 * 口径约定（与全项目一致）：一律 `Date.setDate` 做加减，不用 `±86400000` —— 夏令时
 * 会让「加一天」变成「加 23 或 25 小时」，零点就漂了。
 */

/** 一天毫秒数（**仅用于差值估算**，不用于日期加减） */
export const DAY_MS = 86_400_000;

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

/** 把某天 09:00 作为新建事件的默认时刻（比 00:00 更贴近真实使用） */
export function defaultMomentOfDay(dayMs: number): number {
  const d = new Date(dayMs);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}
