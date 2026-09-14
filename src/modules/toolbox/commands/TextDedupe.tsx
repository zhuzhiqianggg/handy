import * as React from 'react';
import { Filter } from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { ResultBox } from '@/components/ResultBox';
import { Switch } from '@/components/ui/switch';
import { useCommandShell } from '@/hooks/useCommandShell';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'text-dedup';

/**
 * 文本去重：按行去重，支持「去首尾空格」「忽略大小写」「结果排序」选项。
 * 标题栏「一键复制」复制去重后全部行。
 */
export function TextDedupe({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [input, setInput] = React.useState<string>(initialInput);
  const [trim, setTrim] = React.useState<boolean>(true);
  const [ignoreCase, setIgnoreCase] = React.useState<boolean>(false);
  const [sort, setSort] = React.useState<boolean>(false);

  const { output, removed } = React.useMemo(() => {
    const raw = input.split(/\r?\n/);
    const processed = raw.map((line) => (trim ? line.trim() : line));
    const seen = new Set<string>();
    const out: string[] = [];
    let dup = 0;
    for (const line of processed) {
      const key = ignoreCase ? line.toLowerCase() : line;
      if (seen.has(key)) {
        dup += 1;
        continue;
      }
      seen.add(key);
      out.push(line);
    }
    if (sort) {
      out.sort((a, b) => a.localeCompare(b));
    }
    return { output: out.join('\n'), removed: dup };
  }, [input, trim, ignoreCase, sort]);

  const lineCount = output.length > 0 ? output.split('\n').length : 0;

  return (
    <CommandShell
      title="文本去重"
      description="按行去除重复，支持去空格 / 忽略大小写 / 排序"
      icon={<Filter className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={output}
      shortcutHint={`已去除 ${removed} 行重复`}
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-3">
          <label className="text-sm font-medium text-foreground" htmlFor="dedup-input">
            输入（每行一条）
          </label>
          <textarea
            id="dedup-input"
            rows={12}
            className="w-full min-h-0 flex-1 rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={input}
            placeholder={'apple\nApple\n banana\napple'}
            onChange={(event) => setInput(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-foreground">
              <Switch checked={trim} onCheckedChange={setTrim} />
              去空格
            </label>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <Switch checked={ignoreCase} onCheckedChange={setIgnoreCase} />
              忽略大小写
            </label>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <Switch checked={sort} onCheckedChange={setSort} />
              排序
            </label>
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <div className="text-sm text-muted-foreground">
            结果（共 {lineCount} 行，去除 {removed} 行重复）
          </div>
          <ResultBox title="去重后" value={output} emptyHint="输入文本后自动去重" mono />
        </div>
      </div>
    </CommandShell>
  );
}

export default TextDedupe;
