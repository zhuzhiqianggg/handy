import * as React from 'react';
import { Clock } from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useCommandShell } from '@/hooks/useCommandShell';
import { copyText } from '@/lib/clipboard';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'timestamp';

/** 输入模式：时间戳 → 日期，或 日期 → 时间戳（对齐 ops-tools 参考实现）。 */
type InputMode = 'timestamp' | 'datetime';
/** 时间戳单位。 */
type TsUnit = 'seconds' | 'milliseconds';

/** 相对偏移语法：`+1d` / `-2h` / `+30m` / `+10s` / `+500ms`（基于当前时刻）。 */
const RELATIVE_RE = /^[+-]\d+(ms|s|m|h|d)$/;

interface BatchRow {
  input: string;
  seconds: number;
  milliseconds: number;
  local: string;
  utc: string;
  iso: string;
  relative: string;
  valid: boolean;
}

/**
 * 在指定时区按格式串格式化（en-CA 拿到稳定 2 位分段，再套格式模板）。
 * 格式支持：YYYY / MM / DD / HH / mm / ss。时区无效返回 null。
 */
function formatInZone(ms: number, timeZone: string, fmt: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(new Date(ms));
    const values: Record<string, string> = {};
    for (const part of parts) {
      values[part.type] = part.value;
    }
    return fmt
      .replace('YYYY', values.year ?? '')
      .replace('MM', values.month ?? '')
      .replace('DD', values.day ?? '')
      .replace('HH', values.hour ?? '')
      .replace('mm', values.minute ?? '')
      .replace('ss', values.second ?? '');
  } catch {
    return null;
  }
}

/** 相对时间描述（N秒/分钟/小时/天 前·后）。 */
function relativeTime(ms: number): string {
  const diffSec = Math.floor((Date.now() - ms) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 60) {
    return diffSec >= 0 ? `${diffSec}秒前` : `${abs}秒后`;
  }
  const diffMin = Math.floor(diffSec / 60);
  if (Math.abs(diffMin) < 60) {
    return diffMin >= 0 ? `${diffMin}分钟前` : `${-diffMin}分钟后`;
  }
  const diffHour = Math.floor(diffMin / 60);
  if (Math.abs(diffHour) < 24) {
    return diffHour >= 0 ? `${diffHour}小时前` : `${-diffHour}小时后`;
  }
  const diffDay = Math.floor(diffHour / 24);
  if (Math.abs(diffDay) < 30) {
    return diffDay >= 0 ? `${diffDay}天前` : `${-diffDay}天后`;
  }
  return '很久以前';
}

/** 指定时区的星期（中文短格式，如「周一」）。 */
function weekdayInZone(ms: number, timeZone: string): string {
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  try {
    return new Intl.DateTimeFormat('zh-CN', { timeZone, weekday: 'short' }).format(new Date(ms));
  } catch {
    return weekdays[new Date(ms).getDay()] ?? '';
  }
}

/** 解析相对偏移（如 `-1d`）为 Date。 */
function parseRelative(token: string): Date {
  const sign = token[0] === '-' ? -1 : 1;
  const unitTag = token.match(/(ms|s|m|h|d)$/)?.[0] ?? 's';
  const value = Number.parseInt(token.slice(1).replace(/(ms|s|m|h|d)$/, ''), 10);
  const delta =
    unitTag === 'ms'
      ? value
      : unitTag === 's'
        ? value * 1000
        : unitTag === 'm'
          ? value * 60_000
          : unitTag === 'h'
            ? value * 3_600_000
            : value * 86_400_000;
  return new Date(Date.now() + sign * delta);
}

/**
 * 解析单行输入为时间戳毫秒值。
 * - timestamp 模式：相对偏移 / 10 位秒 / 13 位毫秒 / 其余按所选单位；
 * - datetime 模式：Date.parse 兼容字符串（`/` 归一为 `-`）。
 * 无效返回 null。
 */
function parseLine(raw: string, mode: InputMode, unit: TsUnit): number | null {
  const token = raw.trim();
  if (token.length === 0) {
    return null;
  }
  if (mode === 'timestamp') {
    if (RELATIVE_RE.test(token)) {
      return parseRelative(token).getTime();
    }
    if (/^\d{10}$/.test(token)) {
      return Number(token) * 1000;
    }
    if (/^\d{13}$/.test(token)) {
      return Number(token);
    }
    const num = Number.parseInt(token, 10);
    if (Number.isNaN(num)) {
      return null;
    }
    return unit === 'seconds' ? num * 1000 : num;
  }
  const parsed = Date.parse(token.replace(/\//g, '-'));
  return Number.isNaN(parsed) ? null : parsed;
}

/** 固定时区展示集（6 时区，对齐 ops-tools）。 */
const TIME_ZONES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'Asia/Shanghai', label: '北京时间 (UTC+8)' },
  { id: 'UTC', label: 'UTC 时间 (UTC±0)' },
  { id: 'America/New_York', label: '纽约时间 (UTC-5/-4)' },
  { id: 'Europe/London', label: '伦敦时间 (UTC+0/+1)' },
  { id: 'Asia/Tokyo', label: '东京时间 (UTC+9)' },
  { id: 'America/Los_Angeles', label: '洛杉矶时间 (UTC-8/-7)' },
];

/** 输出格式集（6 种，对齐 ops-tools）。 */
const FORMATS: ReadonlyArray<string> = [
  'YYYY-MM-DD HH:mm:ss',
  'YYYY/MM/DD HH:mm:ss',
  'MM/DD/YYYY HH:mm:ss',
  'DD-MM-YYYY HH:mm:ss',
  'YYYY-MM-DD',
  'HH:mm:ss',
];

/** 单条结果报告（多行文本，供 ResultBox / 一键复制）。 */
function toReport(ms: number, timezone: string, fmt: string): string {
  const date = new Date(ms);
  const zoneLines = TIME_ZONES.map((zone) => {
    const formatted = formatInZone(ms, zone.id, 'YYYY-MM-DD HH:mm:ss');
    return formatted === null ? null : `${zone.label}：${formatted}`;
  }).filter((line): line is string => line !== null);
  const selected = formatInZone(ms, timezone, fmt) ?? date.toISOString();
  return [
    `所选时区（${timezone}）：${selected}`,
    ...zoneLines,
    `ISO 8601：${date.toISOString()}`,
    `Unix 秒：${Math.floor(ms / 1000)}`,
    `Unix 毫秒：${ms}`,
    `相对时间：${relativeTime(ms)}`,
    `星期：${weekdayInZone(ms, timezone)}`,
  ].join('\n');
}

/** 批量结果 → CSV 文本。 */
function rowsToCsv(rows: readonly BatchRow[]): string {
  const header = 'input,seconds,milliseconds,local,utc,iso,relative';
  const body = rows.map((row) =>
    [row.input, row.seconds, row.milliseconds, row.local, row.utc, row.iso, row.relative]
      .map((cell) => String(cell).replace(/"/g, '""'))
      .map((cell) => (/[",\n]/.test(cell) ? `"${cell}"` : cell))
      .join(','),
  );
  return [header, ...body].join('\n');
}

/** 结果单元格（输出网格的统一小卡片）。 */
function StatCell({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): React.JSX.Element {
  return (
    <div className="rounded-md bg-muted p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-sm font-semibold break-all ${mono ? 'font-mono' : ''}`}>{value}</div>
    </div>
  );
}

/**
 * 顶部当前时间横幅：实时显示当前 Unix 秒 / 毫秒 / 所选时区格式化时间，
 * 每秒刷新，右侧「复制」按钮复制形如 `秒:{s} 毫秒:{ms} {formatted}` 的文本。
 * 增量功能，不影响原有快捷按钮。
 */
function NowBanner({ timezone, fmt }: { timezone: string; fmt: string }): React.JSX.Element {
  const [nowMs, setNowMs] = React.useState<number>(Date.now());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const seconds = Math.floor(nowMs / 1000);
  const formatted = formatInZone(nowMs, timezone, fmt) ?? '';

  const copyNow = React.useCallback(async (): Promise<void> => {
    const ok = await copyText(`秒:${seconds} 毫秒:${nowMs} ${formatted}`);
    if (ok) {
      toast.success('已复制当前时间');
    } else {
      toast.error('复制失败');
    }
  }, [seconds, nowMs, formatted]);

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md bg-muted p-2">
      <div className="flex flex-1 flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span>
          当前 Unix 秒：<span className="font-mono font-semibold text-foreground">{seconds}</span>
        </span>
        <span>
          毫秒：<span className="font-mono font-semibold text-foreground">{nowMs}</span>
        </span>
        <span>
          本地时间：<span className="font-mono font-semibold text-foreground">{formatted}</span>
        </span>
      </div>
      <Button size="sm" variant="ghost" className="text-xs" onClick={copyNow}>
        复制
      </Button>
    </div>
  );
}

/**
 * 时间戳转换（V15 对齐 ops-tools 参考实现）：
 * 双向转换（时间戳 ⇄ 日期）、秒/毫秒单位、相对偏移（+1d/-2h）、
 * 相对时间与星期、6 时区、6 输出格式、批量多行、快捷时间（当前/当天零点/当天结束）、
 * 一键复制 + 批量结果复制为 CSV / JSON。
 */
export function TimestampConverter({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [mode, setMode] = React.useState<InputMode>('timestamp');
  const [unit, setUnit] = React.useState<TsUnit>('seconds');
  const [text, setText] = React.useState<string>(initialInput);
  const [timezone, setTimezone] = React.useState<string>('Asia/Shanghai');
  const [fmt, setFmt] = React.useState<string>(FORMATS[0] ?? 'YYYY-MM-DD HH:mm:ss');
  /** 相对偏移控件输入（如 +1h / -2d / +30m / +500ms）。 */
  const [offsetInput, setOffsetInput] = React.useState<string>('');

  const lines = React.useMemo<string[]>(
    () => text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0),
    [text],
  );
  const isBatch = lines.length > 1;

  // 单条结果：ms + 报告文本（无效输入返回 null）
  const single = React.useMemo<{ ms: number; report: string } | null>(() => {
    if (lines.length === 0) {
      return null;
    }
    const ms = parseLine(lines[0] ?? '', mode, unit);
    return ms === null ? null : { ms, report: toReport(ms, timezone, fmt) };
  }, [lines, mode, unit, timezone, fmt]);

  // 批量结果：逐行转换（无效行 valid=false，照常展示便于定位）
  const batch = React.useMemo<BatchRow[] | null>(() => {
    if (!isBatch) {
      return null;
    }
    return lines.map((line) => {
      const ms = parseLine(line, mode, unit);
      if (ms === null) {
        return {
          input: line,
          seconds: 0,
          milliseconds: 0,
          local: '',
          utc: '',
          iso: '',
          relative: '无效输入',
          valid: false,
        };
      }
      const date = new Date(ms);
      return {
        input: line,
        seconds: Math.floor(ms / 1000),
        milliseconds: ms,
        local: formatInZone(ms, timezone, 'YYYY-MM-DD HH:mm:ss') ?? '',
        utc: formatInZone(ms, 'UTC', 'YYYY-MM-DD HH:mm:ss') ?? '',
        iso: date.toISOString(),
        relative: relativeTime(ms),
        valid: true,
      };
    });
  }, [isBatch, lines, mode, unit, timezone]);

  // 相对时间每 30 秒自动刷新（保持「N分钟前」新鲜）
  const [, setTick] = React.useState<number>(0);
  React.useEffect(() => {
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 30_000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const fillNow = React.useCallback((): void => {
    if (mode === 'datetime') {
      const formatted = formatInZone(Date.now(), timezone, 'YYYY-MM-DD HH:mm:ss');
      if (formatted !== null) {
        // 尊重当前 Tab：日期模式下填入当前日期字符串，不切走模式
        setText(formatted);
        return;
      }
      // 时区无效时退回 timestamp 填充
    }
    setMode('timestamp');
    setUnit('seconds');
    setText(String(Math.floor(Date.now() / 1000)));
  }, [mode, timezone]);

  /** 应用相对偏移：从当前结果（或批量首行/当前时刻）出发，两种模式均可使用。 */
  const applyOffset = React.useCallback((): void => {
    const token = offsetInput.trim();
    if (!RELATIVE_RE.test(token)) {
      toast.warning('偏移格式应为 +1h / -2d / +30m / +10s / +500ms');
      return;
    }
    const sign = token[0] === '-' ? -1 : 1;
    const unitTag = token.match(/(ms|s|m|h|d)$/)?.[0] ?? 's';
    const value = Number.parseInt(token.slice(1).replace(/(ms|s|m|h|d)$/, ''), 10);
    const delta =
      unitTag === 'ms'
        ? value
        : unitTag === 's'
          ? value * 1000
          : unitTag === 'm'
            ? value * 60_000
            : unitTag === 'h'
              ? value * 3_600_000
              : value * 86_400_000;
    const base =
      single?.ms ??
      (batch && batch[0]?.valid ? parseLine(batch[0].input, mode, unit) : null) ??
      Date.now();
    const newMs = base + sign * delta;
    if (mode === 'datetime') {
      setText(formatInZone(newMs, timezone, 'YYYY-MM-DD HH:mm:ss') ?? '');
    } else {
      setMode('timestamp');
      setUnit('seconds');
      setText(String(Math.floor(newMs / 1000)));
    }
  }, [offsetInput, single, batch, mode, unit, timezone]);

  const fillTodayStart = React.useCallback((): void => {
    try {
      const datePart = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
      setMode('datetime');
      setText(`${datePart} 00:00:00`);
    } catch {
      toast.error('当天零点计算失败');
    }
  }, [timezone]);

  const fillTodayEnd = React.useCallback((): void => {
    try {
      const datePart = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
      setMode('datetime');
      setText(`${datePart} 23:59:59`);
    } catch {
      toast.error('当天结束计算失败');
    }
  }, [timezone]);

  const copyBatchCsv = React.useCallback(async (): Promise<void> => {
    if (!batch || batch.length === 0) {
      toast.warning('暂无批量结果');
      return;
    }
    const ok = await copyText(rowsToCsv(batch));
    if (ok) {
      toast.success('CSV 已复制到剪贴板');
    } else {
      toast.error('复制失败');
    }
  }, [batch]);

  const copyBatchJson = React.useCallback(async (): Promise<void> => {
    if (!batch || batch.length === 0) {
      toast.warning('暂无批量结果');
      return;
    }
    const ok = await copyText(JSON.stringify(batch, null, 2));
    if (ok) {
      toast.success('JSON 已复制到剪贴板');
    } else {
      toast.error('复制失败');
    }
  }, [batch]);

  const copyTextValue = isBatch ? (batch ? rowsToCsv(batch) : '') : (single?.report ?? '');

  const modeButton = (value: InputMode, label: string): React.JSX.Element => (
    <Button
      key={value}
      size="sm"
      variant={mode === value ? 'default' : 'ghost'}
      className="h-7 px-2.5 text-xs"
      onClick={() => setMode(value)}
    >
      {label}
    </Button>
  );

  return (
    <CommandShell
      title="时间戳转换"
      description="Unix 时间戳（秒 / 毫秒）与日期时间互转，多时区多格式"
      icon={<Clock className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={copyTextValue}
      shortcutHint="支持多行批量；相对偏移如 +1h / -2d（也可用下方「应用偏移」）；「当前时间」按当前 Tab 填入"
    >
      {/* 顶部当前时间横幅（默认展示、每秒刷新、可复制） */}
      <NowBanner timezone={timezone} fmt={fmt} />

      {/* V15：两列基准（≥1024px 并排）：左输入 / 选项，右结果，操作条通栏 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-3">
        {/* 模式切换 */}
        <div className="flex items-center gap-1.5">
          {modeButton('timestamp', '时间戳 → 日期')}
          {modeButton('datetime', '日期 → 时间戳')}
        </div>

        {/* 输入区 */}
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-foreground" htmlFor="ts-input">
            {mode === 'timestamp' ? '时间戳（每行一条，可批量）' : '日期时间（每行一条，可批量）'}
          </label>
          <textarea
            id="ts-input"
            autoFocus
            rows={isBatch ? 4 : 2}
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={text}
            placeholder={
              mode === 'timestamp'
                ? '1704067200 / 1704067200000 / +1d / -2h\n（多行批量）'
                : '2024-01-01 08:00:00 / 2024-01-01T00:00:00Z\n（多行批量）'
            }
            onChange={(event) => setText(event.target.value)}
          />
          {mode === 'timestamp' ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>单位</span>
              <select
                className="h-7 rounded-md border border-input bg-background px-2 text-xs"
                value={unit}
                onChange={(event) => setUnit(event.target.value as TsUnit)}
              >
                <option value="seconds">秒 (10 位)</option>
                <option value="milliseconds">毫秒 (13 位)</option>
              </select>
              <span className="ml-2">10 / 13 位自动识别</span>
            </div>
          ) : null}
        </div>

        {/* 时区 + 输出格式 */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            所选时区
            <select
              className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
            >
              {TIME_ZONES.map((zone) => (
                <option key={zone.id} value={zone.id}>
                  {zone.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            输出格式
            <select
              className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
              value={fmt}
              onChange={(event) => setFmt(event.target.value)}
            >
              {FORMATS.map((format) => (
                <option key={format} value={format}>
                  {format}
                </option>
              ))}
            </select>
          </label>
        </div>

        </div>

        {/* 结果区 */}
        <div className="flex min-w-0 flex-col gap-3">
        {isBatch && batch ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>批量结果：{batch.length} 条（无效 {batch.filter((row) => !row.valid).length} 条）</span>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={copyBatchCsv}>
                  复制 CSV
                </Button>
                <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={copyBatchJson}>
                  复制 JSON
                </Button>
              </div>
            </div>
            <div className="overflow-auto rounded-md border scrollbar-thin">
              <table className="w-full text-left text-xs">
                <thead className="bg-muted text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5">输入</th>
                    <th className="px-2 py-1.5">Unix 秒</th>
                    <th className="px-2 py-1.5">当地时间</th>
                    <th className="px-2 py-1.5">UTC</th>
                    <th className="px-2 py-1.5">相对</th>
                  </tr>
                </thead>
                <tbody>
                  {batch.map((row, index) => (
                    <tr key={`${row.input}-${index}`} className={row.valid ? '' : 'text-destructive'}>
                      <td className="px-2 py-1.5 font-mono">{row.input}</td>
                      <td className="px-2 py-1.5 font-mono">{row.valid ? row.seconds : '—'}</td>
                      <td className="px-2 py-1.5 font-mono">{row.local || '—'}</td>
                      <td className="px-2 py-1.5 font-mono">{row.utc || '—'}</td>
                      <td className="px-2 py-1.5">{row.relative}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : single ? (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <StatCell label={`所选时区（${timezone}）`} value={formatInZone(single.ms, timezone, fmt) ?? '—'} />
              <StatCell label="UTC" value={formatInZone(single.ms, 'UTC', 'YYYY-MM-DD HH:mm:ss') ?? '—'} />
              <StatCell label="ISO 8601" value={new Date(single.ms).toISOString()} />
              <StatCell label="Unix 秒" value={String(Math.floor(single.ms / 1000))} mono />
              <StatCell label="Unix 毫秒" value={String(single.ms)} mono />
              <StatCell label={`星期（${timezone}）`} value={weekdayInZone(single.ms, timezone)} />
            </div>
            <div className="flex items-center justify-between rounded-md bg-muted p-2">
              <div>
                <div className="text-xs text-muted-foreground">相对时间</div>
                <div className="mt-0.5 text-sm font-semibold">{relativeTime(single.ms)}</div>
              </div>
              <div className="text-right text-xs text-muted-foreground">
                6 时区明细见「一键复制」结果
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            {lines.length === 0
              ? '输入时间戳或日期后自动转换'
              : '无法识别输入，请检查格式'}
          </div>
        )}
        </div>

        {/* 快捷操作（通栏） */}
        <div className="flex flex-wrap items-center gap-2 lg:col-span-2">
          <Button size="sm" onClick={fillNow}>
            当前时间
          </Button>
          <Button size="sm" variant="secondary" onClick={fillTodayStart}>
            当天零点
          </Button>
          <Button size="sm" variant="secondary" onClick={fillTodayEnd}>
            当天结束
          </Button>
          {/* 相对偏移控件：独立、可发现的「应用偏移」输入 */}
          <input
            className="h-7 w-32 rounded-md border border-input bg-background px-2 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder="+1h / -2d / +30m / +500ms"
            value={offsetInput}
            onChange={(event) => setOffsetInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                applyOffset();
              }
            }}
          />
          <Button size="sm" variant="secondary" onClick={applyOffset}>
            应用偏移
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-destructive"
            onClick={() => setText('')}
          >
            清空
          </Button>
        </div>
      </div>
    </CommandShell>
  );
}

export default TimestampConverter;
