import * as React from 'react';
import { AtSign } from 'lucide-react';
import { pinyin } from 'pinyin-pro';
import { CommandShell } from '@/components/CommandShell';
import { ResultBox } from '@/components/ResultBox';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useCommandShell } from '@/hooks/useCommandShell';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'slug-generator';

type Separator = '-' | '_' | '.';

/** 生成 URL slug（纯 TS；中文可走 pinyin-pro 拼音化）。 */
function slugify(
  text: string,
  separator: Separator,
  lowercase: boolean,
  romanize: boolean,
  maxLength: number,
): string {
  let working = text;
  if (romanize) {
    working = pinyin(working, { toneType: 'none', nonZh: 'consecutive' });
  }
  if (lowercase) {
    working = working.toLowerCase();
  }
  const escaped = separator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out = working.replace(/[^a-z0-9]+/gi, separator);
  out = out.replace(new RegExp(`${escaped}+`, 'g'), separator);
  out = out.replace(new RegExp(`^${escaped}+|${escaped}+$`, 'g'), '');
  if (maxLength > 0 && out.length > maxLength) {
    out = out.slice(0, maxLength).replace(new RegExp(`${escaped}+$`), '');
  }
  return out;
}

/**
 * Slug 生成：文本 → URL slug，可选分隔符、小写、拼音化与最大长度。
 * 复用项目既有依赖 pinyin-pro 处理中文。
 */
export function SlugGenerator({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [input, setInput] = React.useState<string>(initialInput || 'Handy 顺手 · 效率工具');
  const [separator, setSeparator] = React.useState<Separator>('-');
  const [lowercase, setLowercase] = React.useState<boolean>(true);
  const [romanize, setRomanize] = React.useState<boolean>(true);
  const [maxLength, setMaxLength] = React.useState<number>(0);

  const output = React.useMemo(
    () => slugify(input, separator, lowercase, romanize, maxLength),
    [input, separator, lowercase, romanize, maxLength],
  );

  return (
    <CommandShell
      title="Slug 生成"
      description="文本 → URL slug（支持拼音化与分隔符选项）"
      icon={<AtSign className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={output}
      shortcutHint="中文可开启「拼音化」转为拼音 slug"
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-3">
          <label className="text-sm font-medium text-foreground" htmlFor="slug-input">
            输入文本
          </label>
          <textarea
            id="slug-input"
            rows={4}
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={input}
            onChange={(event) => setInput(event.target.value)}
          />
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              分隔符
              <select
                className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
                value={separator}
                onChange={(event) => setSeparator(event.target.value as Separator)}
              >
                <option value="-">-（连字符）</option>
                <option value="_">_（下划线）</option>
                <option value=".">.（点）</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              最大长度（0=不限）
              <Input
                type="number"
                min={0}
                max={200}
                value={maxLength}
                onChange={(event) =>
                  setMaxLength(Math.max(0, Math.min(200, Number.parseInt(event.target.value, 10) || 0)))
                }
                className="w-28"
              />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-foreground">
              <Switch checked={lowercase} onCheckedChange={setLowercase} />
              小写
            </label>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <Switch checked={romanize} onCheckedChange={setRomanize} />
              拼音化（中文）
            </label>
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <ResultBox title="Slug" value={output} emptyHint="输入文本后自动生成" mono />
        </div>
      </div>
    </CommandShell>
  );
}

export default SlugGenerator;
