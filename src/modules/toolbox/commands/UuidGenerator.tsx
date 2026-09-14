import * as React from 'react';
import { Fingerprint } from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { CopyButton } from '@/components/CopyButton';
import { useCommandShell } from '@/hooks/useCommandShell';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'uuid-generator';

/** 生成单个 v4 UUID（优先 crypto.randomUUID，降级到 Math.random 实现）。 */
function generateV4(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // 降级实现（RFC 4122 v4 变体）
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] ?? 0) & 0x0f | 0x40;
  bytes[8] = (bytes[8] ?? 0) & 0x3f | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < 16; i += 1) {
    hex.push((bytes[i] ?? 0).toString(16).padStart(2, '0'));
  }
  return (
    `${hex[0]}${hex[1]}${hex[2]}${hex[3]}-${hex[4]}${hex[5]}-${hex[6]}${hex[7]}` +
    `-${hex[8]}${hex[9]}-${hex[10]}${hex[11]}${hex[12]}${hex[13]}${hex[14]}${hex[15]}`
  );
}

/** 应用大小写 / 连字符选项。 */
function formatUuid(id: string, uppercase: boolean, dashes: boolean): string {
  let out = uppercase ? id.toUpperCase() : id;
  if (!dashes) {
    out = out.replace(/-/g, '');
  }
  return out;
}

/**
 * UUID 生成器：批量产出 RFC 4122 v4 UUID，支持大小写与连字符开关，
 * 每行可单独复制，标题栏「一键复制」复制全部。
 */
export function UuidGenerator({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const initialCount = Number.parseInt(initialInput, 10);
  const [count, setCount] = React.useState<number>(
    Number.isFinite(initialCount) && initialCount > 0 ? Math.min(initialCount, 1000) : 5,
  );
  const [uppercase, setUppercase] = React.useState<boolean>(false);
  const [dashes, setDashes] = React.useState<boolean>(true);
  const [uuids, setUuids] = React.useState<string[]>([]);

  const generate = React.useCallback((): void => {
    const n = Math.max(1, Math.min(count || 1, 1000));
    const list = Array.from({ length: n }, () => formatUuid(generateV4(), uppercase, dashes));
    setUuids(list);
  }, [count, uppercase, dashes]);

  const copyTextValue = uuids.join('\n');

  return (
    <CommandShell
      title="UUID 生成器"
      description="批量生成 RFC 4122 v4 UUID，支持大小写与连字符选项"
      icon={<Fingerprint className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={copyTextValue}
      shortcutHint="设置数量后点击「生成」；每行可单独复制"
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            数量（1-1000）
            <Input
              type="number"
              min={1}
              max={1000}
              value={count}
              onChange={(event) => setCount(Number.parseInt(event.target.value, 10) || 1)}
              className="w-32"
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <Switch checked={uppercase} onCheckedChange={setUppercase} />
            大写
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <Switch checked={dashes} onCheckedChange={setDashes} />
            包含连字符
          </label>
          <Button onClick={generate} className="ml-auto">
            生成
          </Button>
        </div>

        {uuids.length > 0 ? (
          <div className="overflow-auto rounded-md border scrollbar-thin">
            <table className="w-full text-left text-xs">
              <tbody>
                {uuids.map((id, index) => (
                  <tr key={`${id}-${index}`} className="border-b border-border last:border-0">
                    <td className="px-2 py-1.5 font-mono text-foreground">{id}</td>
                    <td className="px-2 py-1.5 text-right">
                      <CopyButton text={id} label="复制" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            点击「生成」批量产出 UUID
          </div>
        )}
      </div>
    </CommandShell>
  );
}

export default UuidGenerator;
