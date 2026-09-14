import * as React from 'react';
import { Scale } from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { ResultBox } from '@/components/ResultBox';
import { Input } from '@/components/ui/input';
import { useCommandShell } from '@/hooks/useCommandShell';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'unit-converter';

interface Unit {
  id: string;
  label: string;
  /** 相对基准单位的因子（温度类为 0，单独处理） */
  factor: number;
}

interface Category {
  label: string;
  units: Unit[];
  temp: boolean;
}

const CATEGORIES: Record<string, Category> = {
  length: {
    label: '长度',
    temp: false,
    units: [
      { id: 'mm', label: '毫米 mm', factor: 0.001 },
      { id: 'cm', label: '厘米 cm', factor: 0.01 },
      { id: 'm', label: '米 m', factor: 1 },
      { id: 'km', label: '千米 km', factor: 1000 },
      { id: 'in', label: '英寸 in', factor: 0.0254 },
      { id: 'ft', label: '英尺 ft', factor: 0.3048 },
      { id: 'mi', label: '英里 mi', factor: 1609.344 },
    ],
  },
  mass: {
    label: '重量',
    temp: false,
    units: [
      { id: 'mg', label: '毫克 mg', factor: 0.001 },
      { id: 'g', label: '克 g', factor: 1 },
      { id: 'kg', label: '千克 kg', factor: 1000 },
      { id: 't', label: '吨 t', factor: 1e6 },
      { id: 'oz', label: '盎司 oz', factor: 28.3495 },
      { id: 'lb', label: '磅 lb', factor: 453.592 },
    ],
  },
  data: {
    label: '数据存储',
    temp: false,
    units: [
      { id: 'B', label: '字节 B', factor: 1 },
      { id: 'KB', label: 'KB', factor: 1024 },
      { id: 'MB', label: 'MB', factor: 1024 ** 2 },
      { id: 'GB', label: 'GB', factor: 1024 ** 3 },
      { id: 'TB', label: 'TB', factor: 1024 ** 4 },
    ],
  },
  temp: {
    label: '温度',
    temp: true,
    units: [
      { id: 'C', label: '摄氏度 °C', factor: 0 },
      { id: 'F', label: '华氏度 °F', factor: 0 },
      { id: 'K', label: '开尔文 K', factor: 0 },
    ],
  },
};

/** 温度：转成摄氏度基准。 */
function toCelsius(value: number, unit: string): number {
  if (unit === 'F') return ((value - 32) * 5) / 9;
  if (unit === 'K') return value - 273.15;
  return value;
}

/** 温度：从摄氏度转到目标单位。 */
function fromCelsius(c: number, unit: string): number {
  if (unit === 'F') return (c * 9) / 5 + 32;
  if (unit === 'K') return c + 273.15;
  return c;
}

/**
 * 单位换算：长度 / 重量 / 数据存储 / 温度，纯 TS 查找表（无依赖）。
 * 输入值实时换算到所有目标单位，可一键复制完整结果。
 */
export function UnitConverter({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [categoryId, setCategoryId] = React.useState<string>('length');
  const [fromUnit, setFromUnit] = React.useState<string>('m');
  const [value, setValue] = React.useState<string>(initialInput || '1');

  const category = CATEGORIES[categoryId] ?? CATEGORIES.length;

  React.useEffect(() => {
    const cat = CATEGORIES[categoryId];
    if (cat) {
      setFromUnit(cat.units[0]?.id ?? '');
    }
  }, [categoryId]);

  const num = Number.parseFloat(value);
  const valid = Number.isFinite(num) && category !== undefined;

  const results = React.useMemo<Record<string, number>>(() => {
    const cat = CATEGORIES[categoryId];
    const out: Record<string, number> = {};
    if (!cat || !valid) {
      return out;
    }
    if (cat.temp) {
      const c = toCelsius(num, fromUnit);
      for (const unit of cat.units) {
        out[unit.id] = fromCelsius(c, unit.id);
      }
      return out;
    }
    const base = num * (cat.units.find((u) => u.id === fromUnit)?.factor ?? 1);
    for (const unit of cat.units) {
      out[unit.id] = base / unit.factor;
    }
    return out;
  }, [categoryId, fromUnit, num, valid]);

  const resultText = React.useMemo(
    () =>
      Object.entries(results)
        .map(([id, v]) => {
          const unit = CATEGORIES[categoryId]?.units.find((u) => u.id === id);
          const display = Number.isInteger(v) ? String(v) : v.toFixed(6).replace(/\.?0+$/, '');
          return `${display} ${unit?.label ?? id}`;
        })
        .join('\n'),
    [results, categoryId],
  );

  const categoryKeys = Object.keys(CATEGORIES);

  return (
    <CommandShell
      title="单位换算"
      description="长度 / 重量 / 数据存储 / 温度 换算"
      icon={<Scale className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={resultText}
      shortcutHint="选择类别与源单位，输入数值实时换算所有单位"
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            类别
            <select
              className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
            >
              {categoryKeys.map((key) => (
                <option key={key} value={key}>
                  {CATEGORIES[key]?.label ?? key}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            源单位
            <select
              className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
              value={fromUnit}
              onChange={(event) => setFromUnit(event.target.value)}
            >
              {(CATEGORIES[categoryId]?.units ?? []).map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            数值
            <Input
              type="number"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              className="w-32"
            />
          </label>
        </div>

        <ResultBox
          title={`换算结果（${CATEGORIES[categoryId]?.label ?? ''}）`}
          value={resultText}
          emptyHint="输入数值后自动换算"
          mono
        />
      </div>
    </CommandShell>
  );
}

export default UnitConverter;
