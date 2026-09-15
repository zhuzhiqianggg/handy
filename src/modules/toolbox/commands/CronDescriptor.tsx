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
  formatRunTime,
  humanRunTime,
  type CronBuildInput,
  type CronBuildMode,
  type CronFieldResult,
} from '@/lib/cron';
import { cn } from '@/lib/utils';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'cron-descriptor';

/**
 * Cron 表达式解析（V20 重做）。
 *
 * # 用户反馈
 *
 * 「Cron 表达式解析这个功能太简单了，你需要加强优化这个工具，增强完善功能。」
 * 原实现只把 5 段翻译成一句中文，且**不校验**（`99 99 * * *` 也照译）。
 *
 * # 这一版补齐四件事
 *
 * 1. **看得懂** —— 逐字段拆解表（原始值 / 中文含义 / 取值范围），错误定位到第几段；
 * 2. **算得出** —— 推算未来 8 次执行时间（含「今天 / 明天 / 周几」），
 *    支持 Quartz 的 `L` `W` `#` 与 6/7 段（秒 / 年）；
 * 3. **不用背** —— 20 条运维常用预设按场景分组，点一下直接填；
 * 4. **能反着来** —— 「每 N 分钟 / 每天 HH:mm / 每周几 / 每月几号」参数化生成表达式。
 *
 * 状态（表达式 + 生成器参数）经 `useToolState` 持久化：关掉工具再打开还在。
 */

/** 生成器模式选项 */
const BUILD_MODES: ReadonlyArray<{ value: CronBuildMode; label: string }> = [
  { value: 'minutes', label: '每 N 分钟' },
  { value: 'hours', label: '每 N 小时' },
  { value: 'daily', label: '每天固定时刻' },
  { value: 'weekly', label: '每周某天' },
  { value: 'weekdays', label: '工作日固定时刻' },
  { value: 'monthly', label: '每月某号' },
];

const WEEKDAY_PICKER: readonly string[] = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

interface CronToolState {
  input: string;
  showBuild: boolean;
  showPresets: boolean;
  build: CronBuildInput;
}

const INITIAL_STATE: CronToolState = {
  input: '0 9 * * 1-5',
  showBuild: false,
  showPresets: true,
  build: { mode: 'daily', every: 5, hour: 9, minute: 0, weekday: 1, day: 1 },
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
  const generated = React.useMemo(() => buildCron(state.build), [state.build]);

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
      description="5 / 6 / 7 段 · Quartz 扩展 · 字段拆解 · 下次执行时间"
      icon={<CalendarClock className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={analysis.ok ? analysis.summary : ''}
      shortcutHint="支持 * ? , - / L W # 与 @daily 等宏；6 段时第 1 段是「秒」"
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
          {/* 段位提示：让用户一眼对上「这格是分还是秒」 */}
          <div className="grid grid-cols-7 gap-1 text-center text-[10px] text-muted-foreground">
            {(hasSeconds
              ? ['秒', '分', '时', '日', '月', '周', '年']
              : ['—', '分', '时', '日', '月', '周', '—']
            ).map((label, index) => (
              <span key={index} className={label === '—' ? 'opacity-0' : ''}>
                {label}
              </span>
            ))}
          </div>
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
              <div className="flex flex-wrap items-center gap-2">
                {BUILD_MODES.map((mode) => (
                  <button
                    key={mode.value}
                    type="button"
                    onClick={() => patch({ build: { ...state.build, mode: mode.value } })}
                    className={cn(
                      'rounded-md border px-2 py-1 text-[11px] transition',
                      state.build.mode === mode.value
                        ? 'border-brand/50 bg-brand-muted text-brand'
                        : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
                    )}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>

              <div className="flex flex-wrap items-end gap-3">
                {state.build.mode === 'minutes' || state.build.mode === 'hours' ? (
                  <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                    间隔（{state.build.mode === 'minutes' ? '分钟' : '小时'}）
                    <input
                      type="number"
                      min={1}
                      max={state.build.mode === 'minutes' ? 59 : 23}
                      value={state.build.every}
                      onChange={(event) =>
                        patch({ build: { ...state.build, every: Number(event.target.value) } })
                      }
                      className="w-24 rounded-md border border-input bg-transparent px-2 py-1 text-sm text-foreground"
                    />
                  </label>
                ) : null}

                {state.build.mode !== 'minutes' && state.build.mode !== 'hours' ? (
                  <>
                    <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                      时
                      <input
                        type="number"
                        min={0}
                        max={23}
                        value={state.build.hour}
                        onChange={(event) =>
                          patch({ build: { ...state.build, hour: Number(event.target.value) } })
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
                        value={state.build.minute}
                        onChange={(event) =>
                          patch({ build: { ...state.build, minute: Number(event.target.value) } })
                        }
                        className="w-20 rounded-md border border-input bg-transparent px-2 py-1 text-sm text-foreground"
                      />
                    </label>
                  </>
                ) : null}

                {state.build.mode === 'weekly' ? (
                  <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                    星期
                    <select
                      value={state.build.weekday}
                      onChange={(event) =>
                        patch({ build: { ...state.build, weekday: Number(event.target.value) } })
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

                {state.build.mode === 'monthly' ? (
                  <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                    几号
                    <input
                      type="number"
                      min={1}
                      max={31}
                      value={state.build.day}
                      onChange={(event) =>
                        patch({ build: { ...state.build, day: Number(event.target.value) } })
                      }
                      className="w-20 rounded-md border border-input bg-transparent px-2 py-1 text-sm text-foreground"
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
