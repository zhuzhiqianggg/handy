import * as React from 'react';
import { CalendarClock, Check, Copy, Info, Wand2, X } from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useCommandShell } from '@/hooks/useCommandShell';
import { useToolState } from '@/hooks/useToolState';
import {
  CRON_PRESETS,
  analyzeCron,
  buildCron,
  fieldLayout,
  formatRunTime,
  humanRunTime,
  type CronBuildInput,
  type CronBuildMode,
  type CronFieldResult,
  type CronFieldSpec,
} from '@/lib/cron';
import { cn } from '@/lib/utils';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'cron-descriptor';

/**
 * Cron 表达式解析（V21）。
 *
 * # 用户反馈
 *
 * 「既然你下面加了分时日月周，为什么没有和前面的表达式对齐呢？要对齐展示或者更好的方式
 *   清晰直观。缺少 `*` 斜杠 5 这样的吗？最小到分钟吗、如果每 5 分钟呢？注意齐全点。」
 *
 * # 这一版怎么改的
 *
 * 1. **逐段编辑**（回答「对齐」）—— 原来那行「分 时 日 月 周」只是挂在输入框下面的
 *    装饰性文字，跟表达式里的每一段对不上，属于「看着像对齐，其实没关系」。现在
 *    改成**真的逐段输入框**：每段一个格子，标签压在各自格子上方、解析含义贴在格子
 *    下方，改哪段点哪段，上方表达式实时同步 —— 对齐是布局意义上的对齐，不是画一排字。
 * 2. **预设铺全**（回答「齐全点」）—— 高频组按 2/3/5/6/10/15/20/30 分钟铺满，补上
 *    秒级（Quartz 6 段）与多日 / 季度写法；生成器加了「每 N 秒」「星期区间」「多日期」
 *    「每月最后一天」四种模式，并给间隔加了常用值的快选按钮。
 * 3. **粒度说清** —— 界面里明写：标准 5 段最小粒度是 **1 分钟**（没有秒段），
 *    要秒级必须切 6 段（第 1 段就是秒）。
 *
 * 看得懂 / 算得出 / 不用背 / 能反着来（V20 已交付）：字段拆解表、未来 8 次执行时间、
 * 20+ 条运维预设、参数化反向生成。
 * 状态（表达式 + 生成器参数）经 `useToolState` 持久化：关掉工具再打开还在。
 */

/** 生成器模式选项 */
const BUILD_MODES: ReadonlyArray<{ value: CronBuildMode; label: string; hint: string }> = [
  { value: 'seconds', label: '每 N 秒', hint: 'Quartz 6 段：0/N * * * * ?（最小到秒）' },
  { value: 'minutes', label: '每 N 分钟', hint: '标准写法 */N * * * *' },
  { value: 'hours', label: '每 N 小时', hint: '0 */N * * *' },
  { value: 'daily', label: '每天固定时刻', hint: 'M H * * *' },
  { value: 'weekly', label: '每周某天', hint: 'M H * * D' },
  { value: 'weeklyRange', label: '每周某区间', hint: 'M H * * 1-5' },
  { value: 'weekdays', label: '工作日固定时刻', hint: 'M H * * 1-5' },
  { value: 'monthly', label: '每月某号', hint: 'M H D * *' },
  { value: 'dayList', label: '每月多号', hint: 'M H 1,15 * *' },
  { value: 'lastDay', label: '每月最后一天', hint: 'Quartz：M H L * ?' },
];

/** 生成器里各「间隔」组的常用值快选（省得一个个敲数字） */
const STEP_SUGGESTIONS: Record<'seconds' | 'minutes' | 'hours', readonly number[]> = {
  seconds: [5, 10, 15, 20, 30],
  minutes: [2, 3, 5, 6, 10, 15, 20, 30],
  hours: [2, 3, 4, 6, 8, 12],
};

/**
 * 「间隔」类模式的元信息：单位、上限、以及去 `STEP_SUGGESTIONS` 取常用值的键。
 *
 * 不在表里的模式（每天 / 每周 / 每月…）走的是「时 + 分」参数，不需要间隔数值。
 */
const STEP_MODE_INFO: Partial<
  Record<CronBuildMode, { unit: string; max: number; key: 'seconds' | 'minutes' | 'hours' }>
> = {
  seconds: { unit: '秒', max: 59, key: 'seconds' },
  minutes: { unit: '分钟', max: 59, key: 'minutes' },
  hours: { unit: '小时', max: 23, key: 'hours' },
};

const WEEKDAY_PICKER: readonly string[] = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

interface CronToolState {
  input: string;
  showBuild: boolean;
  showPresets: boolean;
  build: CronBuildInput;
}

/**
 * 生成器参数的完整默认值。
 *
 * 单独抽出来是因为 `useToolState` 只做**浅合并**：老版本存过的 `build` 会整块盖掉
 * 新默认值，新增字段（`weekdayTo` / `days`）在旧草稿里就是 `undefined`。
 * 渲染前统一 `{...DEFAULT_BUILD, ...state.build}` 兜一层，缺字段也不会生成出 `NaN`。
 */
const DEFAULT_BUILD: CronBuildInput = {
  mode: 'daily',
  every: 5,
  hour: 9,
  minute: 0,
  weekday: 1,
  weekdayTo: 5,
  day: 1,
  days: [1, 15],
};

const INITIAL_STATE: CronToolState = {
  input: '0 9 * * 1-5',
  showBuild: false,
  showPresets: true,
  build: { ...DEFAULT_BUILD },
};

/** 字段拆解表的一行 */
function FieldRow({ field }: { field: CronFieldResult }): React.JSX.Element {
  return (
    <div
      className={cn(
        'grid grid-cols-[64px_minmax(0,140px)_minmax(0,1fr)] items-start gap-2 rounded-md px-2 py-1.5 text-xs',
        field.ok ? 'hover:bg-accent/40' : 'bg-destructive/5',
      )}
    >
      <span className="font-medium text-muted-foreground">{field.label}</span>
      <code
        className={cn(
          'truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]',
          field.ok ? 'text-foreground' : 'bg-destructive/10 text-destructive',
        )}
        title={field.raw}
      >
        {field.raw}
      </code>
      <span className={field.ok ? 'text-foreground' : 'text-destructive'}>
        {field.ok ? field.text : `⚠ ${field.error ?? '格式错误'}`}
        {field.ok && field.values !== null && field.values.length > 0 && field.values.length <= 12 ? (
          <span className="ml-1 text-[11px] text-muted-foreground">
            （{field.values.join(', ')}）
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** 小圆点徽标 */
function Badge({
  tone,
  children,
}: {
  tone: 'ok' | 'warn' | 'error' | 'info';
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]',
        tone === 'ok' && 'bg-emerald-100 text-emerald-700',
        tone === 'warn' && 'bg-amber-100 text-amber-800',
        tone === 'error' && 'bg-destructive/10 text-destructive',
        tone === 'info' && 'bg-muted text-muted-foreground',
      )}
    >
      {children}
    </span>
  );
}

/**
 * Cron 描述 + 分析：把标准 5 段 / Quartz 6-7 段翻译成中文，
 * 推算下次执行时间，并支持预设与反向生成。
 */
export function CronDescriptor({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [state, patch] = useToolState<CronToolState>(COMMAND_ID, {
    ...INITIAL_STATE,
    input: initialInput || INITIAL_STATE.input,
  });

  const analysis = React.useMemo(() => analyzeCron(state.input), [state.input]);
  const hasSeconds = analysis.form === 'quartz';

  /** 生成器参数（补齐旧草稿缺失的字段，见 `DEFAULT_BUILD`） */
  const build: CronBuildInput = React.useMemo(
    () => ({ ...DEFAULT_BUILD, ...state.build }),
    [state.build],
  );
  const generated = React.useMemo(() => buildCron(build), [build]);

  /** 按空白切段；逐段编辑器与生成的表达式都基于它 */
  const segments: string[] = React.useMemo(
    () => state.input.trim().split(/\s+/).filter((part) => part.length > 0),
    [state.input],
  );
  /** 当前段数对应的界面规格；null = 段数不合法（只能编原始表达式） */
  const layout: readonly CronFieldSpec[] | null = React.useMemo(
    () => fieldLayout(segments.length),
    [segments.length],
  );
  const isMacro = state.input.trim().startsWith('@');

  /**
   * 改写第 index 段并重组成完整表达式。
   *
   * 段内的空白直接吃掉（cron 靠空白分段，留着空格会把一段劈成两段）；
   * 清空某段时回落成 `*`，否则 `join(' ')` 会产出连续空格、段数跟着变，界面会跳。
   */
  const withSegment = (index: number, raw: string): string => {
    const next = [...segments];
    next[index] = raw.replace(/\s+/g, '') || '*';
    return next.join(' ');
  };

  const [copied, setCopied] = React.useState(false);
  const copyExpression = (): void => {
    void navigator.clipboard
      .writeText(state.input.trim())
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => toast.error('复制失败'));
  };

  const apply = (expr: string): void => {
    patch({ input: expr });
  };

  return (
    <CommandShell
      title="Cron 表达式解析"
      description="逐段编辑 · 5 / 6 / 7 段 · Quartz 扩展 · 字段拆解 · 下次执行时间"
      icon={<CalendarClock className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={analysis.ok ? analysis.summary : ''}
      shortcutHint="逐段编辑：每个格子改一段，上方表达式实时同步；预设里 2/3/5/6/10/15/20/30 分钟都齐了"
    >
      <div className="flex flex-col gap-4">
        {/* ——— 表达式输入 ——— */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-foreground" htmlFor="cron-input">
              Cron 表达式
            </label>
            {analysis.ok ? (
              <Badge tone={analysis.form === 'quartz' ? 'info' : 'ok'}>
                {analysis.form === 'macro' ? '宏' : analysis.form === 'quartz' ? 'Quartz 6/7 段' : '标准 5 段'}
              </Badge>
            ) : (
              <Badge tone="error">
                <X className="h-3 w-3" />
                无法解析
              </Badge>
            )}
            <button
              type="button"
              onClick={copyExpression}
              className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied ? '已复制' : '复制表达式'}
            </button>
          </div>
          <input
            id="cron-input"
            value={state.input}
            spellCheck={false}
            placeholder="0 9 * * 1-5   或   0/30 * * * * ?"
            onChange={(event) => patch({ input: event.target.value })}
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-base tracking-wide shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />

          {/* ——— 逐段编辑：标签压在各自输入框上方，与表达式**逐段对齐** ——— */}
          {layout !== null && !isMacro ? (
            <div className="rounded-xl border border-border bg-card p-3">
              <div className="mb-2.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-xs font-medium text-foreground">逐段编辑</span>
                <span className="text-[11px] text-muted-foreground">
                  改哪段点哪段，上面的表达式实时同步
                </span>
                <span className="ml-auto rounded bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                  最小粒度：标准 5 段 = 1 分钟（无秒段）；要秒级请用 6 段，第 1 段就是「秒」
                </span>
              </div>
              <div
                className="grid gap-2"
                style={{ gridTemplateColumns: `repeat(${layout.length}, minmax(0, 1fr))` }}
              >
                {layout.map((spec: CronFieldSpec, index: number) => {
                  const field: CronFieldResult | undefined = analysis.fields[index];
                  const value: string = segments[index] ?? '';
                  const bad: boolean = field !== undefined && !field.ok;
                  return (
                    <div key={spec.key} className="flex min-w-0 flex-col items-stretch gap-1">
                      <span
                        className="text-center text-[11px] font-medium text-muted-foreground"
                        title={spec.hint}
                      >
                        {spec.label}
                      </span>
                      <input
                        value={value}
                        spellCheck={false}
                        aria-label={`${spec.label} 段`}
                        title={spec.hint}
                        onChange={(event) => patch({ input: withSegment(index, event.target.value) })}
                        className={cn(
                          'w-full rounded-md border bg-transparent px-1.5 py-1 text-center font-mono text-xs shadow-sm transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                          bad ? 'border-destructive/50 text-destructive' : 'border-input text-foreground',
                        )}
                      />
                      <span
                        className={cn(
                          'min-h-[2.6em] text-center text-[10px] leading-snug',
                          bad ? 'text-destructive' : 'text-muted-foreground',
                        )}
                        title={field !== undefined && !field.ok ? field.error : spec.hint}
                      >
                        {field === undefined
                          ? '—'
                          : field.ok
                            ? field.text
                            : `⚠ ${field.error ?? '格式错误'}`}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
              {isMacro
                ? '这是宏写法（@daily 等），展开后的分段含义见下方「字段拆解」。'
                : `当前 ${segments.length} 段，不是 5 / 6 / 7 段，没法逐段编辑 —— 先在上面的输入框里把段数补齐。`}
            </p>
          )}

          {!analysis.ok ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {analysis.error}
            </p>
          ) : null}
        </div>

        {/* ——— 中文描述 ——— */}
        {analysis.ok ? (
          <div className="rounded-xl border border-border bg-card p-4 shadow-panel">
            <p className="text-sm font-medium text-foreground">{analysis.summary}</p>
            {analysis.normalized !== state.input.trim() && analysis.form === 'macro' ? (
              <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                展开：{analysis.normalized}
              </p>
            ) : null}
            {analysis.dayOrWeek ? (
              <p className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
                <Info className="mt-0.5 h-3 w-3 shrink-0" />
                <span>
                  日与周**同时**限定：「日」和「周」是**或**的关系（传统 Vixie cron 语义），
                  例如 1 号或周一都会触发，不是「1 号且周一」。要表达「且」，请用 Quartz 的
                  <code className="mx-1 rounded bg-amber-100 px-1">?</code>把其中一段设为不指定。
                </span>
              </p>
            ) : null}
          </div>
        ) : null}

        {/* ——— 字段拆解 ——— */}
        {analysis.fields.length > 0 ? (
          <div className="rounded-xl border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-4 py-2">
              <span className="text-sm font-medium text-foreground">字段拆解</span>
              <span className="text-[11px] text-muted-foreground">
                {analysis.ok ? '逐段校验通过' : '红色即出错的那一段'}
              </span>
            </div>
            <div className="p-2">
              {analysis.fields.map((field) => (
                <FieldRow key={field.key} field={field} />
              ))}
            </div>
          </div>
        ) : null}

        {/* ——— 下次执行时间 ——— */}
        {analysis.ok && analysis.next.length > 0 ? (
          <div className="rounded-xl border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-4 py-2">
              <span className="text-sm font-medium text-foreground">接下来 8 次执行</span>
              <span className="text-[11px] text-muted-foreground">本机时区 · 由当前时间起算</span>
            </div>
            <div className="flex flex-wrap gap-2 p-3">
              {analysis.next.map((time, index) => {
                const isFirst = index === 0;
                return (
                  <span
                    key={time}
                    className={cn(
                      'inline-flex items-baseline gap-1.5 rounded-lg border px-2.5 py-1.5',
                      isFirst ? 'border-brand/40 bg-brand-muted/60' : 'border-border',
                    )}
                  >
                    <span className="text-[11px] text-muted-foreground">{humanRunTime(time)}</span>
                    <span className="font-mono text-xs font-medium text-foreground">
                      {formatRunTime(time, hasSeconds)}
                    </span>
                  </span>
                );
              })}
            </div>
          </div>
        ) : analysis.ok ? (
          <p className="rounded-xl border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
            该表达式在未来 2 年内没有可推算的执行时间（例如限定了已过去的年份，或 `@reboot` 这类无时间语义的写法）。
          </p>
        ) : null}

        {/* ——— 预设 —— */}
        <div className="rounded-xl border border-border bg-card">
          <div className="flex items-center gap-2 border-b border-border px-4 py-2">
            <span className="text-sm font-medium text-foreground">常用表达式</span>
            <span className="text-[11px] text-muted-foreground">点一下填进输入框</span>
            <button
              type="button"
              onClick={() => patch({ showPresets: !state.showPresets })}
              className="ml-auto rounded-md px-2 py-0.5 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
            >
              {state.showPresets ? '收起' : '展开'}
            </button>
          </div>
          {state.showPresets ? (
            <div className="flex flex-col gap-3 p-3">
              {['高频', '每天', '每周', '每月', '进阶'].map((group) => {
                const list = CRON_PRESETS.filter((preset) => preset.group === group);
                if (list.length === 0) {
                  return null;
                }
                return (
                  <div key={group}>
                    <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">{group}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {list.map((preset) => (
                        <button
                          key={preset.expr + preset.label}
                          type="button"
                          title={preset.note || preset.expr}
                          onClick={() => apply(preset.expr)}
                          className={cn(
                            'group inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-left transition',
                            state.input.trim() === preset.expr
                              ? 'border-brand/50 bg-brand-muted/60'
                              : 'border-border hover:border-brand/40 hover:bg-accent/40',
                          )}
                        >
                          <span className="text-xs text-foreground">{preset.label}</span>
                          <code className="font-mono text-[10px] text-muted-foreground">
                            {preset.expr}
                          </code>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>

        {/* ——— 反向生成器 ——— */}
        <div className="rounded-xl border border-border bg-card">
          <div className="flex items-center gap-2 border-b border-border px-4 py-2">
            <Wand2 className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">说人话生成表达式</span>
            <span className="text-[11px] text-muted-foreground">
              {BUILD_MODES.find((item) => item.value === build.mode)?.hint ?? ''}
            </span>
            <button
              type="button"
              onClick={() => patch({ showBuild: !state.showBuild })}
              className="ml-auto rounded-md px-2 py-0.5 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
            >
              {state.showBuild ? '收起' : '展开'}
            </button>
          </div>
          {state.showBuild ? (
            <div className="flex flex-col gap-3 p-3">
              {/* 模式 */}
              <div className="flex flex-wrap items-center gap-1.5">
                {BUILD_MODES.map((mode) => (
                  <button
                    key={mode.value}
                    type="button"
                    title={mode.hint}
                    onClick={() => patch({ build: { ...build, mode: mode.value } })}
                    className={cn(
                      'rounded-md border px-2 py-1 text-[11px] transition',
                      build.mode === mode.value
                        ? 'border-brand/50 bg-brand-muted text-brand'
                        : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
                    )}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>

              <div className="flex flex-wrap items-end gap-3">
                {/* 间隔类模式：数值 + 常用值快选 */}
                {STEP_MODE_INFO[build.mode] !== undefined ? (
                  <div className="flex flex-col gap-1">
                    <span className="text-[11px] text-muted-foreground">
                      间隔（{STEP_MODE_INFO[build.mode]?.unit}）
                    </span>
                    <div className="flex flex-wrap items-center gap-1">
                      <input
                        type="number"
                        min={1}
                        max={STEP_MODE_INFO[build.mode]?.max}
                        value={build.every}
                        aria-label="间隔数值"
                        onChange={(event) =>
                          patch({ build: { ...build, every: Number(event.target.value) } })
                        }
                        className="w-20 rounded-md border border-input bg-transparent px-2 py-1 text-sm text-foreground"
                      />
                      {STEP_SUGGESTIONS[STEP_MODE_INFO[build.mode]?.key ?? 'minutes'].map((step) => (
                        <button
                          key={step}
                          type="button"
                          onClick={() => patch({ build: { ...build, every: step } })}
                          className={cn(
                            'rounded border px-2 py-1 text-[11px] transition',
                            build.every === step
                              ? 'border-brand/50 bg-brand-muted text-brand'
                              : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
                          )}
                        >
                          {step}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {/* 固定时刻类模式：时 + 分 */}
                {STEP_MODE_INFO[build.mode] === undefined ? (
                  <>
                    <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                      时
                      <input
                        type="number"
                        min={0}
                        max={23}
                        value={build.hour}
                        onChange={(event) =>
                          patch({ build: { ...build, hour: Number(event.target.value) } })
                        }
                        className="w-20 rounded-md border border-input bg-transparent px-2 py-1 text-sm text-foreground"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                      分
                      <input
                        type="number"
                        min={0}
                        max={59}
                        value={build.minute}
                        onChange={(event) =>
                          patch({ build: { ...build, minute: Number(event.target.value) } })
                        }
                        className="w-20 rounded-md border border-input bg-transparent px-2 py-1 text-sm text-foreground"
                      />
                    </label>
                  </>
                ) : null}

                {build.mode === 'weekly' ? (
                  <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                    星期
                    <select
                      value={build.weekday}
                      onChange={(event) =>
                        patch({ build: { ...build, weekday: Number(event.target.value) } })
                      }
                      className="rounded-md border border-input bg-transparent px-2 py-1 text-sm text-foreground"
                    >
                      {WEEKDAY_PICKER.map((label, index) => (
                        <option key={label} value={index}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}

                {build.mode === 'weeklyRange' ? (
                  <div className="flex items-end gap-1">
                    <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                      从
                      <select
                        value={build.weekday}
                        onChange={(event) =>
                          patch({ build: { ...build, weekday: Number(event.target.value) } })
                        }
                        className="rounded-md border border-input bg-transparent px-2 py-1 text-sm text-foreground"
                      >
                        {WEEKDAY_PICKER.map((label, index) => (
                          <option key={label} value={index}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                      到
                      <select
                        value={build.weekdayTo}
                        onChange={(event) =>
                          patch({ build: { ...build, weekdayTo: Number(event.target.value) } })
                        }
                        className="rounded-md border border-input bg-transparent px-2 py-1 text-sm text-foreground"
                      >
                        {WEEKDAY_PICKER.map((label, index) => (
                          <option key={label} value={index}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                ) : null}

                {build.mode === 'monthly' ? (
                  <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                    几号
                    <input
                      type="number"
                      min={1}
                      max={31}
                      value={build.day}
                      onChange={(event) =>
                        patch({ build: { ...build, day: Number(event.target.value) } })
                      }
                      className="w-20 rounded-md border border-input bg-transparent px-2 py-1 text-sm text-foreground"
                    />
                  </label>
                ) : null}

                {build.mode === 'dayList' ? (
                  <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                    几号（逗号分隔，如 1,15）
                    <input
                      value={build.days.join(',')}
                      spellCheck={false}
                      onChange={(event) => {
                        const days = event.target.value
                          .split(/[,，\s]+/)
                          .map((piece) => Number.parseInt(piece, 10))
                          .filter((value) => Number.isFinite(value) && value >= 1 && value <= 31);
                        patch({ build: { ...build, days: [...new Set(days)].sort((a, b) => a - b) } });
                      }}
                      className="w-52 rounded-md border border-input bg-transparent px-2 py-1 font-mono text-sm text-foreground"
                    />
                  </label>
                ) : null}

                <div className="ml-auto flex items-center gap-2">
                  <code className="rounded-md bg-muted px-2 py-1 font-mono text-sm text-foreground">
                    {generated}
                  </code>
                  <Button size="sm" className="h-7 px-2.5 text-xs" onClick={() => apply(generated)}>
                    填入
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </CommandShell>
  );
}

export default CronDescriptor;
