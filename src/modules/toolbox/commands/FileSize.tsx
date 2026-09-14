import * as React from 'react';
import { HardDrive } from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { ResultBox } from '@/components/ResultBox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useCommandShell } from '@/hooks/useCommandShell';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'file-size';

const BINARY_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;
const DECIMAL_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

function humanize(bytes: number, base: number): { value: number; unit: string } {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return { value: 0, unit: 'B' };
  }
  const units = base === 1024 ? BINARY_UNITS : DECIMAL_UNITS;
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(base)), units.length - 1);
  return { value: bytes / base ** exponent, unit: units[exponent] ?? 'B' };
}

function unitFactor(unit: string, base: number): number {
  const units: readonly string[] = base === 1024 ? BINARY_UNITS : DECIMAL_UNITS;
  const index = units.indexOf(unit);
  return index < 0 ? 1 : base ** index;
}

/**
 * 文件大小格式化：字节 ⇄ 人类可读（KB/MB/GB…），base-2 / base-10 可切换。
 */
export function FileSize({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [tab, setTab] = React.useState<string>('b2h');
  const [base2, setBase2] = React.useState<boolean>(true);
  const [bytesInput, setBytesInput] = React.useState<string>(initialInput);
  const [valueInput, setValueInput] = React.useState<string>('');
  const [unit, setUnit] = React.useState<string>('MB');

  const base = base2 ? 1024 : 1000;

  const bytesNum = Number.parseFloat(bytesInput);
  const b2hList = React.useMemo(() => {
    if (!Number.isFinite(bytesNum) || bytesNum < 0) {
      return '';
    }
    const units = base2 ? BINARY_UNITS : DECIMAL_UNITS;
    return units
      .map((u, i) => {
        const v = bytesNum / base ** i;
        const display = Number.isInteger(v) ? String(v) : v.toFixed(2);
        return `${display} ${u}`;
      })
      .join('\n');
  }, [bytesNum, base2, base]);

  const h2bResult = React.useMemo<string>(() => {
    const v = Number.parseFloat(valueInput);
    if (!Number.isFinite(v) || v < 0) {
      return '';
    }
    const bytes = v * unitFactor(unit, base);
    const display = Number.isInteger(bytes) ? String(bytes) : bytes.toPrecision(12).replace(/\.?0+$/, '');
    return `${display} 字节（${base2 ? 'base-2' : 'base-10'}）`;
  }, [valueInput, unit, base, base2]);

  const copyText = tab === 'b2h' ? b2hList : h2bResult;

  const onTabChange = React.useCallback((value: string): void => {
    setTab(value);
  }, []);

  const units = base2 ? BINARY_UNITS : DECIMAL_UNITS;

  return (
    <CommandShell
      title="文件大小格式化"
      description="字节 ⇄ 人类可读（base-2 / base-10 切换）"
      icon={<HardDrive className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={copyText}
      shortcutHint="切换上方标签；右下开关切换 base-2 / base-10"
    >
      <div className="flex flex-col gap-4">
        <label className="flex items-center gap-2 text-sm text-foreground">
          <Switch checked={base2} onCheckedChange={setBase2} />
          {base2 ? 'base-2（KiB/MiB…）' : 'base-10（KB/MB…）'}
        </label>
        <Tabs value={tab} onValueChange={onTabChange}>
          <TabsList>
            <TabsTrigger value="b2h">字节 → 易读</TabsTrigger>
            <TabsTrigger value="h2b">易读 → 字节</TabsTrigger>
          </TabsList>

          <TabsContent value="b2h">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-foreground" htmlFor="fs-bytes">
                  字节数
                </label>
                <Input
                  id="fs-bytes"
                  type="number"
                  min={0}
                  value={bytesInput}
                  onChange={(event) => setBytesInput(event.target.value)}
                  placeholder="1048576"
                />
              </div>
              <ResultBox title="易读结果" value={b2hList} emptyHint="输入字节数后自动换算" mono />
            </div>
          </TabsContent>

          <TabsContent value="h2b">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="flex flex-col gap-3">
                <label className="text-sm font-medium text-foreground" htmlFor="fs-value">
                  数值
                </label>
                <Input
                  id="fs-value"
                  type="number"
                  value={valueInput}
                  onChange={(event) => setValueInput(event.target.value)}
                  placeholder="1"
                />
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  单位
                  <select
                    className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
                    value={unit}
                    onChange={(event) => setUnit(event.target.value)}
                  >
                    {units.map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <ResultBox title="字节结果" value={h2bResult} emptyHint="输入数值与单位后换算" mono />
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </CommandShell>
  );
}

export default FileSize;
