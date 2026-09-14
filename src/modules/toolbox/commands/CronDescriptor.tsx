import * as React from 'react';
import { CalendarClock } from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { ResultBox } from '@/components/ResultBox';
import { useCommandShell } from '@/hooks/useCommandShell';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'cron-descriptor';

const WEEKDAY_NAMES: Record<string, string> = {
  '0': '周日',
  '1': '周一',
  '2': '周二',
  '3': '周三',
  '4': '周四',
  '5': '周五',
  '6': '周六',
  '7': '周日',
};

/** 单段描述（数字 / 列表 / 范围 / 步长）。 */
function fieldText(field: string, unitLabel: string): string {
  if (field === '*') {
    return `每${unitLabel}`;
  }
  if (field.startsWith('*/')) {
    return `每 ${field.slice(2)} ${unitLabel}`;
  }
  if (field.includes(',')) {
    return field
      .split(',')
      .map((part) => fieldText(part, unitLabel))
      .join('、');
  }
  if (field.includes('-')) {
    const [a, b] = field.split('-');
    return `${a} 至 ${b} ${unitLabel}`;
  }
  return `${field} ${unitLabel}`;
}

/** 星期段描述（映射数字为星期名）。 */
function dowText(field: string): string {
  const name = (value: string): string => WEEKDAY_NAMES[value] ?? value;
  if (field === '*') {
    return '每天';
  }
  if (field.startsWith('*/')) {
    return `每 ${field.slice(2)} 天`;
  }
  if (field.includes(',')) {
    return `每${field.split(',').map(name).join('、')}`;
  }
  if (field.includes('-')) {
    const [a, b] = field.split('-');
    if (!a || !b) {
      return field;
    }
    return `${name(a)} 至 ${name(b)}`;
  }
  return `每${name(field)}`;
}

/** 解析 5 段 cron 为中文描述。 */
function describeCron(expr: string): { ok: boolean; text: string; error?: string } {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { ok: false, text: '', error: `需要 5 段（分 时 日 月 周），当前 ${parts.length} 段` };
  }
  const [min, hour, dom, mon, dow] = parts;
  const monthPart = mon === '*' ? '' : `在${fieldText(mon ?? '*', '月')} `;
  const domPart = dom === '*' ? '' : `每月${fieldText(dom ?? '*', '日')} `;
  const dowPart = dow === '*' ? '' : `${dowText(dow ?? '*')} `;
  const hourPart = fieldText(hour ?? '*', '时');
  const minPart = fieldText(min ?? '*', '分');
  const text = `${monthPart}${domPart}${dowPart}的 ${hourPart} ${minPart} 执行`.replace(/\s+/g, ' ').trim();
  return { ok: true, text };
}

/**
 * Cron 描述：将标准 5 段 cron 表达式翻译成中文可读描述（纯 TS 解析）。
 */
export function CronDescriptor({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [input, setInput] = React.useState<string>(initialInput || '0 9 * * 1-5');

  const result = React.useMemo(() => describeCron(input), [input]);

  return (
    <CommandShell
      title="Cron 表达式解析"
      description="标准 5 段 cron → 中文描述"
      icon={<CalendarClock className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={result.ok ? result.text : ''}
      shortcutHint="格式：分 时 日 月 周（如 0 9 * * 1-5）"
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-2">
          <label className="text-sm font-medium text-foreground" htmlFor="cron-input">
            Cron 表达式
          </label>
          <textarea
            id="cron-input"
            rows={3}
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={input}
            placeholder="0 9 * * 1-5"
            onChange={(event) => setInput(event.target.value)}
          />
          {!result.ok && input.trim() ? (
            <p className="text-xs text-destructive">{result.error}</p>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <ResultBox
            title="中文描述"
            value={result.ok ? result.text : ''}
            emptyHint={result.ok ? '输入表达式后解析' : '表达式无效'}
            mono={false}
          />
        </div>
      </div>
    </CommandShell>
  );
}

export default CronDescriptor;
