import * as React from 'react';
import { ChevronDown, ChevronRight, Download, Eye, EyeOff, RefreshCw, ShieldCheck } from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { CopyButton } from '@/components/CopyButton';
import { ResultBox } from '@/components/ResultBox';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { useCommandShell } from '@/hooks/useCommandShell';
import type { CommandProps } from '@/core/types';
import { cn } from '@/lib/utils';
import { downloadTextFile, timestampSuffix } from '@/modules/toolbox/lib/download';

const COMMAND_ID = 'password-generator';

/** 基础字符分类。 */
const CHAR_SETS = [
  { id: 'upper', label: '大写 A-Z', chars: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
  { id: 'lower', label: '小写 a-z', chars: 'abcdefghijklmnopqrstuvwxyz' },
  { id: 'digit', label: '数字 0-9', chars: '0123456789' },
  { id: 'symbol', label: '符号', chars: '' },
] as const;

type SetId = (typeof CHAR_SETS)[number]['id'];

/** 符号全集（分组过滤的输入池）。 */
const BASE_SYMBOLS: string = [
  '!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '-', '_', '=', '+',
  '[', ']', '{', '}', ';', ':', ',', '.', '<', '>', '?', '/', '~', '`',
  '|', "'", '"', '\\',
].join('');

/** 易混淆的相似字符（`il1Lo0O`）。 */
const SIMILAR_CHARS: string = ['i', 'l', '1', 'L', 'o', '0', 'O'].join('');
/** 视觉模糊 / 易被转义的字符。 */
const AMBIGUOUS_CHARS: string = [
  '{', '}', '[', ']', '(', ')', '/', '\\', "'", '"', '`', ',', ';', ':', '.', '<', '>', '|',
].join('');

/** 符号安全分组：按使用场景裁剪符号集。 */
interface SymbolGroup {
  id: string;
  label: string;
  hint: string;
  /** 返回该分组允许的符号子集。 */
  filter: (symbols: string) => string;
}

/** 仅保留白名单中的字符。 */
function keepOnly(source: string, allow: string): string {
  return source
    .split('')
    .filter((char) => allow.includes(char))
    .join('');
}

/** 剔除黑名单中的字符。 */
function excludeChars(source: string, banned: string): string {
  return source
    .split('')
    .filter((char) => !banned.includes(char))
    .join('');
}

const SYMBOL_GROUPS: readonly SymbolGroup[] = [
  {
    id: 'shell',
    label: 'Shell 安全',
    hint: '!@#$%^&*_-+=',
    filter: (symbols) => keepOnly(symbols, '!@#$%^&*_-+='),
  },
  { id: 'url', label: 'URL 安全', hint: '-_.~', filter: (symbols) => keepOnly(symbols, '-_.~') },
  {
    id: 'quote',
    label: '引号安全',
    hint: "不含 ' \" `",
    filter: (symbols) => excludeChars(symbols, "'\"`"),
  },
  {
    id: 'bracket',
    label: '括号安全',
    hint: '不含 ()[]{}<>',
    filter: (symbols) => excludeChars(symbols, '()[]{}<>'),
  },
  {
    id: 'sql',
    label: 'SQL 安全',
    hint: "不含 ' \" \\ ;",
    filter: (symbols) => excludeChars(symbols, "'\"\\;"),
  },
  {
    id: 'common',
    label: '常用符号',
    hint: '!@#$%^&*',
    filter: (symbols) => keepOnly(symbols, '!@#$%^&*'),
  },
];

/** 强度评分结果（多档 + 具体改进建议）。 */
interface Strength {
  /** 0–4：很弱 / 弱 / 中等 / 强 / 极强 */
  score: number;
  label: string;
  /** 进度条背景色 class */
  color: string;
  /** 具体改进建议（无建议时给出正向说明） */
  feedback: string[];
  /** 熵（bit） */
  entropy: number;
}

const STRENGTH_LABELS: readonly string[] = ['很弱', '弱', '中等', '强', '极强'];
const STRENGTH_COLORS: readonly string[] = [
  'bg-red-500',
  'bg-orange-500',
  'bg-amber-500',
  'bg-brand',
  'bg-emerald-600',
];
const STRENGTH_TEXT: readonly string[] = [
  'text-red-600',
  'text-orange-600',
  'text-amber-600',
  'text-brand',
  'text-emerald-600',
];

/**
 * 密码学安全的随机整数 `[0, maxExclusive)`。
 *
 * 用 `crypto.getRandomValues` + 拒绝采样（rejection sampling）消除模偏差；
 * 无 Web Crypto 时降级 `Math.random`（仅功能兜底，不用于真实密钥场景）。
 */
function randomInt(maxExclusive: number): number {
  if (maxExclusive <= 0) {
    return 0;
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
    const buf = new Uint32Array(1);
    for (;;) {
      crypto.getRandomValues(buf);
      const value = buf[0] ?? 0;
      if (value < limit) {
        return value % maxExclusive;
      }
    }
  }
  return Math.floor(Math.random() * maxExclusive);
}

/** 是否为字母或数字（用于统计符号占比）。 */
function isAlphanumeric(char: string): boolean {
  return /[A-Za-z0-9]/.test(char);
}

/** 是否含连续（abc / 321）或重复（aaa / 111）片段。 */
function hasSequentialOrRepeated(password: string): boolean {
  let repeat = 1;
  let ascend = 1;
  let descend = 1;
  for (let i = 1; i < password.length; i += 1) {
    const prev = password.charCodeAt(i - 1);
    const curr = password.charCodeAt(i);
    repeat = curr === prev ? repeat + 1 : 1;
    ascend = curr === prev + 1 ? ascend + 1 : 1;
    descend = curr === prev - 1 ? descend + 1 : 1;
    if (repeat >= 3 || ascend >= 3 || descend >= 3) {
      return true;
    }
  }
  return false;
}

/** 生成约束条件。 */
interface GenerateOptions {
  /** 最大符号占比（0–1） */
  maxSymbolRatio: number;
  /**
   * 位置优化（推荐开启）：首尾收敛为字母，把符号与数字集中到中段。
   *
   * 好处：手动输入时不会在首尾漏掉符号；复制粘贴、命令行粘贴、
   * 表格/表单填写时首尾符号更不容易被吞掉或与相邻内容粘连。
   */
  edgeLetter: boolean;
}

/** Fisher-Yates 原地洗牌（随机源为密码学安全的 `randomInt`）。 */
function shuffleInPlace(items: string[]): void {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    const a = items[i];
    const b = items[j];
    if (a === undefined || b === undefined) {
      continue;
    }
    items[i] = b;
    items[j] = a;
  }
}

/**
 * 把第 `pos` 位换成满足 `accept` 的字符（与数组内任一合格位互换，保持字符组成不变）。
 * 池中不存在合格字符时返回 `false`（由调用方的界面警告兜底，不抛错、不死循环）。
 */
function enforceAt(items: string[], pos: number, accept: (char: string) => boolean): boolean {
  const current = items[pos];
  if (current === undefined) {
    return true;
  }
  if (accept(current)) {
    return true;
  }
  for (let i = 0; i < items.length; i += 1) {
    const candidate = items[i];
    if (i !== pos && candidate !== undefined && accept(candidate)) {
      items[pos] = candidate;
      items[i] = current;
      return true;
    }
  }
  return false;
}

/**
 * 生成单条密码。
 *
 * 生成顺序（V18 重写，解决「勾了数字却一个数字都没有」「符号位置不可控」两个痛点）：
 *   1. **各字符类先各占一位**：每个勾选的分类（大写 / 小写 / 数字 / 符号）先强制出现一次，
 *      满足「必须同时包含数字与符号」类站点校验；
 *   2. 余位从整池随机填充，受最大符号占比约束（非符号池为空时自动放宽，永不死循环）；
 *   3. Fisher-Yates 洗牌，打散「先插入的分类总排在前几位」的痕迹；
 *   4. **位置优化**：首尾收敛为字母，符号与数字自然集中在中段。
 */
function generateOne(
  length: number,
  pool: string,
  requiredSets: readonly string[],
  nonSymbols: string,
  options: GenerateOptions,
): string {
  if (pool.length === 0 || length <= 0) {
    return '';
  }
  const maxSymbols = Math.floor(length * options.maxSymbolRatio);
  const out: string[] = [];
  let symbolCount = 0;

  // 1) 每个启用的字符类各先落一位
  for (const set of requiredSets) {
    if (out.length >= length) {
      break;
    }
    const char = set.charAt(randomInt(set.length));
    if (!isAlphanumeric(char)) {
      symbolCount += 1;
    }
    out.push(char);
  }

  // 2) 余位随机填充
  while (out.length < length) {
    const candidates = symbolCount >= maxSymbols && nonSymbols.length > 0 ? nonSymbols : pool;
    const char = candidates.charAt(randomInt(candidates.length));
    if (!isAlphanumeric(char)) {
      symbolCount += 1;
    }
    out.push(char);
  }

  // 3) 洗牌
  shuffleInPlace(out);

  // 4) 位置优化：首尾为字母（池中无字母时自动跳过，界面会给出警告）
  if (options.edgeLetter) {
    const isLetter = (char: string): boolean => /[A-Za-z]/.test(char);
    enforceAt(out, out.length - 1, isLetter);
    enforceAt(out, 0, isLetter);
  }

  return out.join('');
}

/** 综合强度评分：熵值定档，字符种类与连续/重复缺陷扣分。 */
function evaluateStrength(password: string, poolSize: number): Strength {
  const entropy = password.length * Math.log2(Math.max(2, poolSize));
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasDigit = /\d/.test(password);
  const hasSymbol = /[^A-Za-z0-9]/.test(password);
  const classCount = [hasUpper, hasLower, hasDigit, hasSymbol].filter(Boolean).length;
  const sequential = hasSequentialOrRepeated(password);

  const feedback: string[] = [];
  if (password.length < 12) {
    feedback.push('长度低于 12，建议至少 12 位');
  }
  if (!hasUpper) {
    feedback.push('缺少大写字母');
  }
  if (!hasLower) {
    feedback.push('缺少小写字母');
  }
  if (!hasDigit) {
    feedback.push('缺少数字');
  }
  if (!hasSymbol) {
    feedback.push('缺少符号');
  }
  if (sequential) {
    feedback.push('包含连续或重复字符（如 abc / 111）');
  }

  let score = 0;
  if (entropy >= 100) {
    score = 4;
  } else if (entropy >= 75) {
    score = 3;
  } else if (entropy >= 55) {
    score = 2;
  } else if (entropy >= 35) {
    score = 1;
  }
  if (classCount <= 2) {
    score = Math.max(0, score - 1);
  }
  if (sequential) {
    score = Math.max(0, score - 1);
  }

  if (feedback.length === 0) {
    feedback.push(`熵约 ${Math.round(entropy)} bit，字符组合充分`);
  }

  return {
    score,
    label: STRENGTH_LABELS[score] ?? '很弱',
    color: STRENGTH_COLORS[score] ?? 'bg-red-500',
    feedback,
    entropy,
  };
}

/** 字符去重（保持首次出现顺序）。 */
function dedupeChars(value: string): string {
  let out = '';
  for (const char of value) {
    if (!out.includes(char)) {
      out += char;
    }
  }
  return out;
}

/**
 * 密码生成器（对齐 ops-tools 的 PasswordGenerator）：
 * 长度 4–128、4 类字符集 + 6 种符号安全分组、排除相似 / 模糊字符、自定义字符集、
 * 批量生成 1–50 条、首尾字符约束、最大符号占比、多档强度评分与改进建议、
 * 显示 / 隐藏切换与 .txt 导出。
 *
 * 安全约束：本命令为敏感命令，结果**绝不写入任何历史 / 收藏 / 持久化**。
 */
export function PasswordGenerator(_props: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);

  const [length, setLength] = React.useState<number>(16);
  const [enabled, setEnabled] = React.useState<Record<SetId, boolean>>({
    upper: true,
    lower: true,
    digit: true,
    symbol: true,
  });
  const [symbolGroups, setSymbolGroups] = React.useState<Record<string, boolean>>({});
  const [excludeSimilar, setExcludeSimilar] = React.useState<boolean>(false);
  const [excludeAmbiguous, setExcludeAmbiguous] = React.useState<boolean>(false);
  const [customCharset, setCustomCharset] = React.useState<string>('');
  const [count, setCount] = React.useState<number>(1);
  const [edgeLetter, setEdgeLetter] = React.useState<boolean>(true);
  const [maxSymbolPercent, setMaxSymbolPercent] = React.useState<number>(100);
  const [advancedOpen, setAdvancedOpen] = React.useState<boolean>(false);
  const [visible, setVisible] = React.useState<boolean>(true);
  const [nonce, setNonce] = React.useState<number>(0);

  /** 符号集：按勾选的安全分组依次裁剪。 */
  const symbolChars = React.useMemo<string>(() => {
    let result = BASE_SYMBOLS;
    for (const group of SYMBOL_GROUPS) {
      if (symbolGroups[group.id] === true) {
        result = group.filter(result);
      }
    }
    return result;
  }, [symbolGroups]);

  /** 自定义字符集非空时完全接管（忽略分类开关）。 */
  const customMode = customCharset.trim().length > 0;

  /** 最终字符池。 */
  const pool = React.useMemo<string>(() => {
    if (customMode) {
      return dedupeChars(customCharset);
    }
    let base = CHAR_SETS.filter((set) => enabled[set.id])
      .map((set) => (set.id === 'symbol' ? symbolChars : set.chars))
      .join('');
    if (excludeSimilar) {
      base = excludeChars(base, SIMILAR_CHARS);
    }
    if (excludeAmbiguous) {
      base = excludeChars(base, AMBIGUOUS_CHARS);
    }
    return dedupeChars(base);
  }, [customMode, customCharset, enabled, symbolChars, excludeSimilar, excludeAmbiguous]);

  /** 池中的字母 / 非符号子集（约束用）。 */
  const letters = React.useMemo<string>(
    () => pool.split('').filter((char) => /[A-Za-z]/.test(char)).join(''),
    [pool],
  );
  const nonSymbols = React.useMemo<string>(
    () => pool.split('').filter(isAlphanumeric).join(''),
    [pool],
  );

  /**
   * 各字符类的字符池（先落一位用）：保证「勾选了某类就一定出现该类字符」。
   * 自定义字符集模式下退化为单类（池本身），不做分类保证。
   */
  const requiredSets = React.useMemo<string[]>(() => {
    if (customMode) {
      return [pool];
    }
    return CHAR_SETS.filter((set) => enabled[set.id])
      .map((set) => (set.id === 'symbol' ? symbolChars : set.chars))
      .map((chars) =>
        pool
          .split('')
          .filter((char) => chars.includes(char))
          .join(''),
      )
      .filter((chars) => chars.length > 0);
  }, [customMode, pool, enabled, symbolChars]);

  /** 约束不可满足时的警告（界面提示，不阻断生成）。 */
  const warnings = React.useMemo<string[]>(() => {
    const list: string[] = [];
    if (pool.length === 0) {
      list.push('当前字符集为空，请至少选择一类字符或填写自定义字符集');
      return list;
    }
    if (customMode) {
      list.push('已启用自定义字符集：分类开关与符号分组不再生效');
    }
    if (edgeLetter && letters.length === 0) {
      list.push('字符集不含字母，「首尾为字母」无法保证（已自动跳过）');
    }
    if (maxSymbolPercent === 0 && nonSymbols.length === 0) {
      list.push('字符集只剩符号，「最大符号占比 0%」无法保证');
    }
    if (symbolChars.length === 0 && enabled.symbol && !customMode) {
      list.push('符号分组交集为空，已不含任何符号');
    }
    return list;
  }, [pool.length, customMode, edgeLetter, letters.length, maxSymbolPercent, nonSymbols.length, symbolChars.length, enabled.symbol]);

  /** 批量生成结果。 */
  const passwords = React.useMemo<string[]>(() => {
    if (pool.length === 0) {
      return [];
    }
    const options: GenerateOptions = {
      maxSymbolRatio: maxSymbolPercent / 100,
      edgeLetter,
    };
    const list: string[] = [];
    for (let i = 0; i < count; i += 1) {
      list.push(generateOne(length, pool, requiredSets, nonSymbols, options));
    }
    return list;
    // nonce 变化触发重新生成
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [length, pool, requiredSets, nonSymbols, count, edgeLetter, maxSymbolPercent, nonce]);

  /** 首条密码的强度（列表逐条强度单独计算）。 */
  const strength = React.useMemo<Strength>(
    () => evaluateStrength(passwords[0] ?? '', Math.max(2, pool.length)),
    [passwords, pool.length],
  );

  const regenerate = React.useCallback((): void => {
    if (pool.length === 0) {
      toast.error('当前字符集为空，无法生成');
      return;
    }
    setNonce((value) => value + 1);
  }, [pool.length]);

  /** 导出全部密码为 .txt（仅本地 Blob 下载，不做任何持久化）。 */
  const handleDownload = React.useCallback((): void => {
    if (passwords.length === 0) {
      toast.error('暂无可导出的密码');
      return;
    }
    const ok = downloadTextFile(`handy-passwords-${timestampSuffix()}.txt`, passwords.join('\n'));
    if (ok) {
      toast.success(`已导出 ${passwords.length} 条密码为 .txt`);
    } else {
      toast.error('导出失败，请重试');
    }
  }, [passwords]);

  const switchRow = (
    label: string,
    checked: boolean,
    onChange: (value: boolean) => void,
    hint?: string,
  ): React.JSX.Element => (
    <label className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2">
      <span className="min-w-0 text-sm text-foreground">
        {label}
        {hint ? <span className="ml-1 text-xs text-muted-foreground">{hint}</span> : null}
      </span>
      <Switch
        checked={checked}
        onCheckedChange={(value) => onChange(value === true)}
        aria-label={label}
      />
    </label>
  );

  return (
    <CommandShell
      title="密码生成器"
      description="本地随机强密码：符号安全分组、排除易混淆字符、批量生成（敏感内容不写历史）"
      icon={<ShieldCheck className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      favoriteDisabled={shell.favoriteDisabled}
      copyText={passwords.join('\n')}
      primaryAction={{ label: '重新生成', onClick: regenerate, disabled: pool.length === 0 }}
      shortcutHint="调整选项自动重新生成（Esc 返回）"
    >
      {/* 1180×820 基准：两列并排（左选项 / 右结果），窄屏（<1024px）自动回退单列。
          断点用 lg(1024) 而非 xl(1280)：工具页预设宽度就是 1180，用 xl 会在默认尺寸下退化成单列。 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* ===== 左列：选项 ===== */}
        <div className="scrollbar-thin flex min-w-0 flex-col gap-4">
          {/* 长度 */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-foreground" htmlFor="pwd-length">
                长度
              </label>
              <span className="font-mono text-sm text-brand">{length}</span>
            </div>
            <Slider
              id="pwd-length"
              min={4}
              max={128}
              step={1}
              value={[length]}
              onValueChange={(values) => {
                const next = values[0];
                if (typeof next === 'number') {
                  setLength(next);
                }
              }}
            />
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span>4</span>
              <span>128</span>
            </div>
          </div>

          {/* 字符分类 */}
          <div className="grid grid-cols-2 gap-2">
            {CHAR_SETS.map((set) => (
              <label
                key={set.id}
                className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2"
              >
                <span className="text-sm text-foreground">{set.label}</span>
                <Switch
                  checked={enabled[set.id]}
                  disabled={customMode}
                  onCheckedChange={(checked) => {
                    setEnabled((current) => {
                      const next = { ...current, [set.id]: checked === true };
                      // 至少保留一类字符
                      const any = Object.values(next).some(Boolean);
                      return any ? next : current;
                    });
                  }}
                  aria-label={set.label}
                />
              </label>
            ))}
          </div>

          {/* 位置优化（V18）：默认开启，把结论直接摆在一级选项里，不必翻高级选项 */}
          <label className="flex items-start justify-between gap-3 rounded-lg border border-brand/30 bg-brand-muted/40 px-3 py-2">
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">
                位置优化
                <span className="ml-1 text-[11px] font-normal text-brand">推荐</span>
              </span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                首尾固定为字母，符号与数字集中在中段；每类勾选的字符至少出现一次
              </span>
            </span>
            <Switch
              checked={edgeLetter}
              onCheckedChange={(value) => setEdgeLetter(value === true)}
              aria-label="位置优化（首尾为字母）"
            />
          </label>

          {/* 高级选项 */}
          <div className="rounded-lg border border-border bg-card">
            <button
              type="button"
              className="flex w-full items-center gap-1.5 px-3 py-2 text-sm font-medium text-foreground"
              onClick={() => setAdvancedOpen((value) => !value)}
              aria-expanded={advancedOpen}
            >
              {advancedOpen ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
              高级选项
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                符号分组 / 排除字符 / 自定义字符集 / 约束
              </span>
            </button>
            {advancedOpen ? (
              <div className="flex flex-col gap-3 border-t border-border p-3">
                {/* 符号安全分组 */}
                <div className="flex flex-col gap-2">
                  <span className="text-xs font-medium text-foreground">符号安全分组（可多选，取交集）</span>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {SYMBOL_GROUPS.map((group) => (
                      <label
                        key={group.id}
                        className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5"
                      >
                        <span className="min-w-0 text-xs text-foreground">
                          {group.label}
                          <span className="ml-1 font-mono text-[11px] text-muted-foreground">
                            {group.hint}
                          </span>
                        </span>
                        <Switch
                          checked={symbolGroups[group.id] === true}
                          disabled={customMode}
                          onCheckedChange={(checked) =>
                            setSymbolGroups((current) => ({ ...current, [group.id]: checked === true }))
                          }
                          aria-label={group.label}
                        />
                      </label>
                    ))}
                  </div>
                </div>

                {/* 排除字符 */}
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {switchRow('排除相似字符', excludeSimilar, setExcludeSimilar, `(${SIMILAR_CHARS})`)}
                  {switchRow('排除模糊字符', excludeAmbiguous, setExcludeAmbiguous, `(${AMBIGUOUS_CHARS.slice(0, 8)}…)`)}
                  {switchRow('位置优化（首尾为字母）', edgeLetter, setEdgeLetter, '推荐')}
                </div>

                {/* 自定义字符集 */}
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  自定义字符集（填写后将完全接管可用字符）
                  <Input
                    value={customCharset}
                    onChange={(event) => setCustomCharset(event.target.value)}
                    placeholder="留空则使用上方分类与符号分组"
                    className="font-mono"
                    spellCheck={false}
                    autoComplete="off"
                  />
                </label>

                {/* 最大符号占比 */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-foreground">最大符号占比</span>
                    <span className="font-mono text-xs text-brand">{maxSymbolPercent}%</span>
                  </div>
                  <Slider
                    min={0}
                    max={100}
                    step={5}
                    value={[maxSymbolPercent]}
                    onValueChange={(values) => {
                      const next = values[0];
                      if (typeof next === 'number') {
                        setMaxSymbolPercent(next);
                      }
                    }}
                  />
                </div>
              </div>
            ) : null}
          </div>

          {/* 批量数量 */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-foreground">生成数量</span>
              <span className="font-mono text-sm text-brand">{count}</span>
            </div>
            <Slider
              min={1}
              max={50}
              step={1}
              value={[count]}
              onValueChange={(values) => {
                const next = values[0];
                if (typeof next === 'number') {
                  setCount(next);
                }
              }}
            />
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span>1</span>
              <span>50</span>
            </div>
          </div>

          {/* 强度 */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">强度</span>
              <span className="font-medium text-foreground">
                {pool.length === 0 ? (
                  '请至少选择一类字符'
                ) : (
                  <span className={cn(STRENGTH_TEXT[strength.score] ?? 'text-foreground')}>
                    {strength.label}
                  </span>
                )}
                <span className="ml-1 text-muted-foreground">
                  （约 {Math.round(strength.entropy)} bit 熵 · 字符池 {pool.length}）
                </span>
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                className={cn('h-full rounded-full transition-all', strength.color)}
                style={{ width: `${pool.length === 0 ? 0 : (strength.score + 1) * 20}%` }}
              />
            </div>
            {pool.length > 0 ? (
              <ul className="mt-1 flex flex-wrap gap-1">
                {strength.feedback.map((item) => (
                  <li
                    key={item}
                    className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                  >
                    {item}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          {warnings.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {warnings.map((item) => (
                <li key={item} className="text-[11px] text-amber-600">
                  · {item}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {/* ===== 右列：结果 ===== */}
        <div className="flex min-w-0 flex-col gap-3">
          <ResultBox
            title={`生成结果（${passwords.length}）`}
            value={visible ? passwords.join('\n') : passwords.map((item) => '•'.repeat(item.length)).join('\n')}
            emptyHint="选择字符类型后自动生成"
            // 隐藏态下屏蔽结果区自带复制，避免复制到掩码串；逐条复制按钮仍复制真实密码
            copyable={visible}
            fill
            actions={
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => setVisible((value) => !value)}
                >
                  {visible ? <EyeOff className="mr-1 h-3 w-3" /> : <Eye className="mr-1 h-3 w-3" />}
                  {visible ? '隐藏' : '显示'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={handleDownload}
                >
                  <Download className="mr-1 h-3 w-3" />
                  下载
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={regenerate}
                >
                  <RefreshCw className="mr-1 h-3 w-3" />
                  重新生成
                </Button>
              </div>
            }
          />

          {/* 逐条展示（独立复制 + 独立强度点） */}
          {passwords.length > 1 ? (
            <div className="scrollbar-thin flex max-h-[280px] flex-col gap-2 overflow-auto rounded-xl border border-border bg-card p-3">
              {passwords.map((password, index) => {
                const rowStrength = evaluateStrength(password, Math.max(2, pool.length));
                return (
                  <div
                    key={`${index}-${password}`}
                    className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2"
                  >
                    <span className="w-6 shrink-0 text-right font-mono text-xs text-muted-foreground">
                      {index + 1}
                    </span>
                    <span
                      className={cn(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        rowStrength.color,
                      )}
                      title={`强度：${rowStrength.label}`}
                    />
                    <code className="scrollbar-thin min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-sm text-foreground">
                      {visible ? password : '•'.repeat(password.length)}
                    </code>
                    <CopyButton text={password} disabled={password.length === 0} />
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-card p-3">
              <code className="block break-all font-mono text-sm text-foreground">
                {passwords[0] ? (visible ? passwords[0] : '•'.repeat(passwords[0].length)) : '—'}
              </code>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            敏感内容：不写入历史、不进入收藏、不做任何本地持久化；关闭页面即消失。
          </p>
        </div>
      </div>
    </CommandShell>
  );
}

export default PasswordGenerator;
