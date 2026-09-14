import * as React from 'react';
import { Regex } from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { ResultBox } from '@/components/ResultBox';
import { Input } from '@/components/ui/input';
import { useCommandShell } from '@/hooks/useCommandShell';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'regex-tester';

const FLAG_OPTIONS: ReadonlyArray<{ flag: string; label: string }> = [
  { flag: 'g', label: '全局 g' },
  { flag: 'i', label: '忽略大小写 i' },
  { flag: 'm', label: '多行 m' },
  { flag: 's', label: '点匹配换行 s' },
  { flag: 'u', label: 'Unicode u' },
  { flag: 'y', label: '粘连 y' },
];

interface MatchInfo {
  index: number;
  value: string;
  groups: Record<string, string | undefined>;
}

/**
 * 正则表达式测试：实时匹配高亮（emerald 高亮片段），列出所有命中点与命名捕获组。
 * 解析失败在 memo 内返回 error，不在渲染期 setState，避免 React 副作用告警。
 */
export function RegexTester({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [pattern, setPattern] = React.useState<string>('');
  const [flags, setFlags] = React.useState<Set<string>>(new Set(['g']));
  const [test, setTest] = React.useState<string>(initialInput);

  const toggleFlag = React.useCallback((flag: string): void => {
    setFlags((prev) => {
      const next = new Set(prev);
      if (next.has(flag)) {
        next.delete(flag);
      } else {
        next.add(flag);
      }
      return next;
    });
  }, []);

  const flagsString = React.useMemo(
    () => FLAG_OPTIONS.map((option) => option.flag).filter((flag) => flags.has(flag)).join(''),
    [flags],
  );

  const { matches, highlighted, error } = React.useMemo<{
    matches: MatchInfo[];
    highlighted: React.ReactNode;
    error: string | null;
  }>(() => {
    if (!pattern) {
      return { matches: [], highlighted: null, error: null };
    }
    let regex: RegExp;
    try {
      // 高亮需要 g 标志，缺失时补上
      regex = new RegExp(pattern, flagsString.includes('g') ? flagsString : `${flagsString}g`);
    } catch (cause) {
      return {
        matches: [],
        highlighted: null,
        error: cause instanceof Error ? cause.message : '正则表达式无效',
      };
    }
    const found: MatchInfo[] = [];
    let match: RegExpExecArray | null;
    let guard = 0;
    regex.lastIndex = 0;
    while ((match = regex.exec(test)) !== null) {
      found.push({ index: match.index, value: match[0], groups: match.groups ?? {} });
      if (match.index === regex.lastIndex) {
        regex.lastIndex += 1; // 空匹配防死循环
      }
      guard += 1;
      if (guard > 10000) {
        break;
      }
    }
    const nodes: React.ReactNode[] = [];
    let cursor = 0;
    found.forEach((info, i) => {
      if (info.index > cursor) {
        nodes.push(<React.Fragment key={`t${i}`}>{test.slice(cursor, info.index)}</React.Fragment>);
      }
      nodes.push(
        <mark
          key={`m${i}`}
          className="rounded bg-emerald-100 px-0.5 text-foreground dark:bg-emerald-900/40"
        >
          {info.value || '∅'}
        </mark>,
      );
      cursor = info.index + info.value.length;
    });
    if (cursor < test.length) {
      nodes.push(<React.Fragment key="tail">{test.slice(cursor)}</React.Fragment>);
    }
    return { matches: found, highlighted: nodes.length ? nodes : null, error: null };
  }, [pattern, flagsString, test]);

  const matchSummary = React.useMemo(
    () =>
      matches
        .map((matchItem, i) => {
          const groups = Object.entries(matchItem.groups)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => `    ${key}: ${value}`)
            .join('\n');
          return `#${i + 1} @${matchItem.index}: ${matchItem.value}${groups ? `\n${groups}` : ''}`;
        })
        .join('\n'),
    [matches],
  );

  return (
    <CommandShell
      title="正则表达式测试"
      description="实时匹配高亮，支持命名捕获组"
      icon={<Regex className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={matchSummary}
      shortcutHint="修改正则或测试文本即时更新；高亮为匹配片段"
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-foreground" htmlFor="re-pattern">
            正则表达式
          </label>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-muted-foreground">/</span>
            <Input
              id="re-pattern"
              className="font-mono"
              value={pattern}
              placeholder="(\\w+)@(\\w+)"
              onChange={(event) => setPattern(event.target.value)}
            />
            <span className="font-mono text-sm text-muted-foreground">/{flagsString}</span>
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <div className="flex flex-wrap gap-3">
            {FLAG_OPTIONS.map((option) => (
              <label
                key={option.flag}
                className="flex items-center gap-1 text-xs text-muted-foreground"
              >
                <input
                  type="checkbox"
                  checked={flags.has(option.flag)}
                  onChange={() => toggleFlag(option.flag)}
                />
                {option.label}
              </label>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-2">
            <label className="text-sm font-medium text-foreground" htmlFor="re-test">
              测试文本
            </label>
            <textarea
              id="re-test"
              rows={8}
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={test}
              placeholder="name@example.com"
              onChange={(event) => setTest(event.target.value)}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <span className="text-sm font-medium text-foreground">匹配高亮（{matches.length} 处）</span>
            <pre className="min-h-[120px] max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-input bg-transparent p-3 font-mono text-sm scrollbar-thin">
              {highlighted ?? (
                <span className="text-muted-foreground">输入正则与测试文本后显示匹配</span>
              )}
            </pre>
          </div>
        </div>

        <ResultBox
          title={`匹配明细（${matches.length}）`}
          value={matchSummary}
          emptyHint="暂无匹配"
          mono
        />
      </div>
    </CommandShell>
  );
}

export default RegexTester;
