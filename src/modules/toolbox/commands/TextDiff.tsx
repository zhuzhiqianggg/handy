import * as React from 'react';
import { FileDiff } from 'lucide-react';
import { diffChars, diffLines, diffWords } from 'diff';
import { CommandShell } from '@/components/CommandShell';
import { CopyButton } from '@/components/CopyButton';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useCommandShell } from '@/hooks/useCommandShell';
import { cn } from '@/lib/utils';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'text-diff';

/** 对比粒度 */
type Granularity = 'line' | 'word' | 'char';
/** 视图模式 */
type ViewMode = 'split' | 'inline';
/** 差异行类型 */
type RowKind = 'same' | 'added' | 'removed' | 'modified';
/** 行内片段标记 */
type SegMark = 'same' | 'added' | 'removed';

/** 行内片段（用于字符 / 单词级高亮） */
interface Seg {
  text: string;
  mark: SegMark;
}

/** 一侧的一行 */
interface SideLine {
  /** 行号（1 起） */
  no: number;
  /** 行内片段（行粒度时只有一段） */
  segs: Seg[];
  /** 该行纯文本 */
  text: string;
}

interface DiffRow {
  kind: RowKind;
  left: SideLine | null;
  right: SideLine | null;
}

/** 忽略选项 */
interface IgnoreOptions {
  /** 忽略首尾空白 */
  trimWhitespace: boolean;
  /** 忽略全部空白 */
  ignoreAllWhitespace: boolean;
  /** 忽略大小写 */
  ignoreCase: boolean;
  /** 忽略空行 */
  ignoreEmptyLines: boolean;
}

interface DiffStats {
  added: number;
  removed: number;
  modified: number;
  same: number;
  /** 相似度百分比（0-100） */
  similarity: number;
}

/** 渲染保护：超大批量只渲染前 N 行，避免 DOM 爆炸卡死 */
const MAX_RENDER_ROWS = 2000;
/** 字符级对比的文本长度上限（jsdiff diffChars 为 O(n·m)，超限降级为行级） */
const CHAR_DIFF_LIMIT = 20_000;
/** 单词级对比的文本长度上限 */
const WORD_DIFF_LIMIT = 200_000;
/** unified diff 上下文行数 */
const CONTEXT_LINES = 3;

/** 把 diff 块文本拆成行（丢弃末尾因换行产生的空串）。 */
function toLines(value: string): string[] {
  const lines = value.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/** 按忽略选项归一化文本（逐行处理，保持行数语义） */
function normalizeText(text: string, options: IgnoreOptions): string {
  let lines = text.split('\n');
  if (options.ignoreEmptyLines) {
    lines = lines.filter((line) => line.trim().length > 0);
  }
  if (options.trimWhitespace) {
    lines = lines.map((line) => line.trim());
  }
  if (options.ignoreAllWhitespace) {
    lines = lines.map((line) => line.replace(/\s+/g, ''));
  }
  if (options.ignoreCase) {
    lines = lines.map((line) => line.toLowerCase());
  }
  return lines.join('\n');
}

/** 行片段拼接为纯文本 */
function segsToText(segs: readonly Seg[]): string {
  let text = '';
  for (const seg of segs) {
    text += seg.text;
  }
  return text;
}

/** 修改行的行内片段：对左右两行再做一次词 / 字符级 diff */
function inlineSegs(leftText: string, rightText: string, granularity: Granularity): { left: Seg[]; right: Seg[] } {
  const changes = granularity === 'char' ? diffChars(leftText, rightText) : diffWords(leftText, rightText);
  const left: Seg[] = [];
  const right: Seg[] = [];
  for (const change of changes) {
    if (change.added) {
      right.push({ text: change.value, mark: 'added' });
      continue;
    }
    if (change.removed) {
      left.push({ text: change.value, mark: 'removed' });
      continue;
    }
    left.push({ text: change.value, mark: 'same' });
    right.push({ text: change.value, mark: 'same' });
  }
  return { left, right };
}

/** 行粒度：基于 diffLines 构建对齐行 */
function buildLineRows(leftText: string, rightText: string, granularity: Granularity): DiffRow[] {
  const changes = diffLines(leftText, rightText);
  const rows: DiffRow[] = [];
  let aNo = 0;
  let bNo = 0;
  let i = 0;

  while (i < changes.length) {
    const change = changes[i];
    if (!change) {
      break;
    }
    if (change.added) {
      for (const text of toLines(change.value)) {
        bNo += 1;
        rows.push({
          kind: 'added',
          left: null,
          right: { no: bNo, text, segs: [{ text, mark: 'added' }] },
        });
      }
      i += 1;
      continue;
    }
    if (change.removed) {
      const next = changes[i + 1];
      const addedLines = next && next.added ? toLines(next.value) : [];
      const removedLines = toLines(change.value);
      const max = Math.max(removedLines.length, addedLines.length);
      for (let k = 0; k < max; k += 1) {
        const leftRaw = removedLines[k];
        const rightRaw = addedLines[k];
        let left: SideLine | null = null;
        let right: SideLine | null = null;
        if (typeof leftRaw === 'string') {
          aNo += 1;
          left = { no: aNo, text: leftRaw, segs: [{ text: leftRaw, mark: 'removed' }] };
        }
        if (typeof rightRaw === 'string') {
          bNo += 1;
          right = { no: bNo, text: rightRaw, segs: [{ text: rightRaw, mark: 'added' }] };
        }
        if (left !== null && right !== null) {
          const inline = inlineSegs(left.text, right.text, granularity);
          left.segs = inline.left;
          right.segs = inline.right;
          rows.push({ kind: 'modified', left, right });
          continue;
        }
        rows.push({ kind: left !== null ? 'removed' : 'added', left, right });
      }
      i += next && next.added ? 2 : 1;
      continue;
    }
    for (const text of toLines(change.value)) {
      aNo += 1;
      bNo += 1;
      rows.push({
        kind: 'same',
        left: { no: aNo, text, segs: [{ text, mark: 'same' }] },
        right: { no: bNo, text, segs: [{ text, mark: 'same' }] },
      });
    }
    i += 1;
  }
  return rows;
}

/** 行缓冲条目（词 / 字符粒度用） */
interface Entry {
  leftSegs: Seg[];
  rightSegs: Seg[];
  /** 该行为空行（无内容） */
  blank: boolean;
  /** 该行主要标记（判定空行归属哪一侧） */
  mark: SegMark;
}

function newEntry(): Entry {
  return { leftSegs: [], rightSegs: [], blank: false, mark: 'same' };
}

/**
 * 词 / 字符粒度：把 diff 片段流按换行切分并重建成对齐行。
 *
 * 关键：片段可跨行，也可在同一行内混合「相同 / 删除 / 新增」三种标记，
 * 因此逐片段按 `\n` 切分后累积到当前行缓冲，遇换行即收束为一行。
 */
function buildTokenRows(leftText: string, rightText: string, granularity: Granularity): DiffRow[] {
  const changes = granularity === 'char' ? diffChars(leftText, rightText) : diffWords(leftText, rightText);
  const entries: Entry[] = [];
  let current = newEntry();
  let lineContent = false;
  let lineMark: SegMark = 'same';

  const flush = (): void => {
    if (current.leftSegs.length > 0 || current.rightSegs.length > 0 || current.blank) {
      entries.push(current);
    }
    current = newEntry();
    lineContent = false;
    lineMark = 'same';
  };

  for (const change of changes) {
    const mark: SegMark = change.added ? 'added' : change.removed ? 'removed' : 'same';
    if (mark !== 'same') {
      lineMark = mark;
    }
    const pieces = change.value.split('\n');
    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i] ?? '';
      if (piece.length > 0) {
        if (mark !== 'added') {
          current.leftSegs.push({ text: piece, mark });
        }
        if (mark !== 'removed') {
          current.rightSegs.push({ text: piece, mark });
        }
        lineContent = true;
      }
      if (i < pieces.length - 1) {
        if (!lineContent) {
          current.blank = true;
          current.mark = lineMark;
        }
        flush();
      }
    }
  }
  flush();

  const rows: DiffRow[] = [];
  let aNo = 0;
  let bNo = 0;
  for (const entry of entries) {
    if (entry.blank) {
      if (entry.mark === 'added') {
        bNo += 1;
        rows.push({ kind: 'added', left: null, right: { no: bNo, segs: [], text: '' } });
      } else if (entry.mark === 'removed') {
        aNo += 1;
        rows.push({ kind: 'removed', left: { no: aNo, segs: [], text: '' }, right: null });
      } else {
        aNo += 1;
        bNo += 1;
        rows.push({
          kind: 'same',
          left: { no: aNo, segs: [], text: '' },
          right: { no: bNo, segs: [], text: '' },
        });
      }
      continue;
    }

    const leftText = segsToText(entry.leftSegs);
    const rightText = segsToText(entry.rightSegs);
    const leftRemoved = entry.leftSegs.some((seg) => seg.mark === 'removed');
    const rightAdded = entry.rightSegs.some((seg) => seg.mark === 'added');
    const kind: RowKind =
      leftRemoved && rightAdded
        ? 'modified'
        : leftRemoved
          ? 'removed'
          : rightAdded
            ? 'added'
            : 'same';

    if (kind === 'removed') {
      aNo += 1;
      rows.push({ kind, left: { no: aNo, segs: entry.leftSegs, text: leftText }, right: null });
      continue;
    }
    if (kind === 'added') {
      bNo += 1;
      rows.push({ kind, left: null, right: { no: bNo, segs: entry.rightSegs, text: rightText } });
      continue;
    }
    aNo += 1;
    bNo += 1;
    rows.push({
      kind,
      left: { no: aNo, segs: entry.leftSegs, text: leftText },
      right: { no: bNo, segs: entry.rightSegs, text: rightText },
    });
  }
  return rows;
}

/** 统计各类行数与相似度 */
function computeStats(rows: readonly DiffRow[], leftText: string, rightText: string): DiffStats {
  let added = 0;
  let removed = 0;
  let modified = 0;
  let same = 0;
  let common = 0;

  for (const row of rows) {
    if (row.kind === 'added') {
      added += 1;
      continue;
    }
    if (row.kind === 'removed') {
      removed += 1;
    } else if (row.kind === 'modified') {
      modified += 1;
    } else {
      same += 1;
    }
    if (row.left !== null) {
      for (const seg of row.left.segs) {
        if (seg.mark === 'same') {
          common += seg.text.length;
        }
      }
    }
  }

  const total = leftText.length + rightText.length;
  const similarity = total === 0 ? 100 : Math.max(0, Math.min(100, Math.round((200 * common) / total)));
  return { added, removed, modified, same, similarity };
}

/** 差异行 → unified diff 操作序列 */
interface PatchOp {
  type: ' ' | '-' | '+';
  text: string;
}

function toOps(rows: readonly DiffRow[]): PatchOp[] {
  const ops: PatchOp[] = [];
  for (const row of rows) {
    if (row.kind === 'same') {
      ops.push({ type: ' ', text: row.left?.text ?? '' });
      continue;
    }
    if (row.left !== null) {
      ops.push({ type: '-', text: row.left.text });
    }
    if (row.right !== null) {
      ops.push({ type: '+', text: row.right.text });
    }
  }
  return ops;
}

/**
 * 生成 unified diff 文本（`--- 原文` / `+++ 新文` / `@@` 块）。
 * 自行实现，`diff` 包的 patch API 未在项目类型声明中暴露。
 */
function buildUnifiedPatch(rows: readonly DiffRow[], nameA: string, nameB: string): string {
  const ops = toOps(rows);
  if (ops.length === 0) {
    return `--- ${nameA}\n+++ ${nameB}\n`;
  }

  // 1) 标记变更位置并合并成块（间隔 ≤ 2×上下文 的块合并）
  const changed: number[] = [];
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i];
    if (op && op.type !== ' ') {
      changed.push(i);
    }
  }
  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of changed) {
    const last = ranges[ranges.length - 1];
    if (last && index - last.end <= CONTEXT_LINES * 2) {
      last.end = index;
    } else {
      ranges.push({ start: index, end: index });
    }
  }

  const lines: string[] = [`--- ${nameA}`, `+++ ${nameB}`];
  for (const range of ranges) {
    const from = Math.max(0, range.start - CONTEXT_LINES);
    const to = Math.min(ops.length, range.end + 1 + CONTEXT_LINES);
    let aCountBefore = 0;
    let bCountBefore = 0;
    for (let i = 0; i < from; i += 1) {
      const op = ops[i];
      if (!op) {
        continue;
      }
      if (op.type === ' ' || op.type === '-') {
        aCountBefore += 1;
      }
      if (op.type === ' ' || op.type === '+') {
        bCountBefore += 1;
      }
    }
    let aCount = 0;
    let bCount = 0;
    const body: string[] = [];
    for (let i = from; i < to; i += 1) {
      const op = ops[i];
      if (!op) {
        continue;
      }
      body.push(`${op.type}${op.text}`);
      if (op.type === ' ' || op.type === '-') {
        aCount += 1;
      }
      if (op.type === ' ' || op.type === '+') {
        bCount += 1;
      }
    }
    lines.push(`@@ -${aCountBefore + 1},${aCount} +${bCountBefore + 1},${bCount} @@`);
    lines.push(...body);
  }
  return `${lines.join('\n')}\n`;
}

/** 合并结果：未显式选择时默认取右侧（B），可逐块覆盖 */
function buildMergedText(rows: readonly DiffRow[], resolutions: Readonly<Record<number, 'left' | 'right'>>): string {
  const lines: string[] = [];
  rows.forEach((row, index) => {
    if (row.kind === 'same') {
      lines.push(row.left?.text ?? '');
      return;
    }
    const choice = resolutions[index] ?? 'right';
    if (row.kind === 'removed') {
      if (choice === 'left') {
        lines.push(row.left?.text ?? '');
      }
      return;
    }
    if (row.kind === 'added') {
      if (choice === 'right') {
        lines.push(row.right?.text ?? '');
      }
      return;
    }
    lines.push(choice === 'left' ? (row.left?.text ?? '') : (row.right?.text ?? ''));
  });
  return lines.join('\n');
}

/** 触发浏览器下载 */
function downloadFile(fileName: string, content: string): void {
  try {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    toast.error(`下载失败：${message}`);
  }
}

/** 行内片段渲染（变化字符用更深底色） */
function Segments({ segs }: { segs: readonly Seg[] }): React.JSX.Element {
  return (
    <span className="whitespace-pre-wrap break-all">
      {segs.length === 0 ? (
        <span>&nbsp;</span>
      ) : (
        segs.map((seg, index) => (
          <span
            key={index}
            className={cn(
              seg.mark === 'added' && 'rounded bg-emerald-200/80 text-emerald-900',
              seg.mark === 'removed' && 'rounded bg-red-200/80 text-red-900',
            )}
          >
            {seg.text}
          </span>
        ))
      )}
    </span>
  );
}

/** 单侧单元格（含行号与标记） */
function DiffCell({
  line,
  kind,
  side,
}: {
  line: SideLine | null;
  kind: RowKind;
  side: 'left' | 'right';
}): React.JSX.Element {
  if (line === null) {
    return <div className="min-h-[22px] rounded bg-muted/30" aria-hidden="true" />;
  }
  const isAdded = side === 'right' && (kind === 'added' || kind === 'modified');
  const isRemoved = side === 'left' && (kind === 'removed' || kind === 'modified');
  const marker = isAdded ? '+' : isRemoved ? '-' : ' ';
  return (
    <div
      className={cn(
        'flex min-h-[22px] items-start gap-2 rounded px-2 py-0.5 font-mono text-xs leading-5',
        isAdded && 'bg-emerald-50',
        isRemoved && 'bg-red-50',
      )}
    >
      <span className="w-8 shrink-0 select-none text-right text-muted-foreground/70">{line.no}</span>
      <span
        className={cn(
          'w-3 shrink-0 select-none font-semibold',
          isAdded && 'text-emerald-700',
          isRemoved && 'text-red-700',
          !isAdded && !isRemoved && 'text-muted-foreground/40',
        )}
      >
        {marker}
      </span>
      <Segments segs={line.segs} />
    </div>
  );
}

/** 小开关按钮（忽略选项用） */
function ToggleChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-md border px-2 py-0.5 text-xs transition-colors',
        active
          ? 'border-brand/40 bg-brand-muted text-brand'
          : 'border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground',
      )}
    >
      {children}
    </button>
  );
}

/**
 * 文本对比（对齐 ops-tools 参考实现）：
 * 行 / 单词 / 字符三档粒度、四项忽略选项、**修改行的字符级行内高亮**、
 * 并排 / 行内双视图、统计条（含相似度）、合并模式（逐块接受左 / 右）、
 * 左侧 / 右侧 / unified diff 三种下载。
 */
export function TextDiff({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [textA, setTextA] = React.useState<string>(initialInput);
  const [textB, setTextB] = React.useState<string>('');
  const [mode, setMode] = React.useState<ViewMode>('split');
  const [granularity, setGranularity] = React.useState<Granularity>('line');
  const [options, setOptions] = React.useState<IgnoreOptions>({
    trimWhitespace: false,
    ignoreAllWhitespace: false,
    ignoreCase: false,
    ignoreEmptyLines: false,
  });
  const [mergeMode, setMergeMode] = React.useState<boolean>(false);
  const [resolutions, setResolutions] = React.useState<Record<number, 'left' | 'right'>>({});

  const normalizedA = React.useMemo<string>(() => normalizeText(textA, options), [textA, options]);
  const normalizedB = React.useMemo<string>(() => normalizeText(textB, options), [textB, options]);

  // 大文本降级：字符 / 单词级 diff 代价高，超限自动回退行级并提示
  const tooLongForGranularity =
    (granularity === 'char' &&
      (normalizedA.length > CHAR_DIFF_LIMIT || normalizedB.length > CHAR_DIFF_LIMIT)) ||
    (granularity === 'word' &&
      (normalizedA.length > WORD_DIFF_LIMIT || normalizedB.length > WORD_DIFF_LIMIT));

  const rows = React.useMemo<DiffRow[] | null>(() => {
    if (normalizedA.length === 0 && normalizedB.length === 0) {
      return null;
    }
    if (tooLongForGranularity || granularity === 'line') {
      return buildLineRows(normalizedA, normalizedB, granularity);
    }
    return buildTokenRows(normalizedA, normalizedB, granularity);
  }, [normalizedA, normalizedB, granularity, tooLongForGranularity]);

  const stats = React.useMemo<DiffStats | null>(
    () => (rows === null ? null : computeStats(rows, normalizedA, normalizedB)),
    [rows, normalizedA, normalizedB],
  );

  const unified = React.useMemo<string>(
    () => (rows === null ? '' : buildUnifiedPatch(rows, '原文 A', '新文 B')),
    [rows],
  );

  const merged = React.useMemo<string>(
    () => (rows === null ? '' : buildMergedText(rows, resolutions)),
    [rows, resolutions],
  );

  const hasDiff = rows !== null && rows.some((row) => row.kind !== 'same');

  // 粒度 / 忽略项变化会重建行结构，逐块合并选择按行索引存储，必须重置以免错位
  React.useEffect(() => {
    setResolutions({});
  }, [granularity, options]);

  const toggleOption = React.useCallback((key: keyof IgnoreOptions): void => {
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const setResolution = React.useCallback((index: number, choice: 'left' | 'right'): void => {
    setResolutions((prev) => ({ ...prev, [index]: choice }));
  }, []);

  const applyAll = React.useCallback(
    (choice: 'left' | 'right'): void => {
      if (rows === null) {
        return;
      }
      const next: Record<number, 'left' | 'right'> = {};
      rows.forEach((row, index) => {
        if (row.kind !== 'same') {
          next[index] = choice;
        }
      });
      setResolutions(next);
      toast.success(choice === 'left' ? '已全部接受左侧' : '已全部接受右侧');
    },
    [rows],
  );

  const resetResolutions = React.useCallback((): void => {
    setResolutions({});
    toast.success('已重置为默认（取右侧 B）');
  }, []);

  const visibleRows = React.useMemo<DiffRow[]>(
    () => (rows === null ? [] : rows.slice(0, MAX_RENDER_ROWS)),
    [rows],
  );

  const swap = React.useCallback((): void => {
    setTextA(textB);
    setTextB(textA);
    setResolutions({});
  }, [textA, textB]);

  return (
    <CommandShell
      title="文本对比"
      description="行 / 单词 / 字符三档粒度对比，支持行内高亮与合并"
      icon={<FileDiff className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={merged.length > 0 && mergeMode ? merged : unified}
      shortcutHint="粘贴两段文本自动对比；可切字符粒度看行内高亮（Esc 返回）"
    >
      <div className="flex min-w-0 flex-col gap-3">
        {/* ——— 工具条：视图 / 粒度 / 忽略项 ——— */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            {(['split', 'inline'] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setMode(item)}
                className={cn(
                  'rounded-md px-2 py-1 text-xs transition-colors',
                  mode === item
                    ? 'bg-brand-muted text-brand'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                {item === 'split' ? '并排' : '行内'}
              </button>
            ))}
          </div>
          <span className="h-4 w-px bg-border" />
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground">粒度</span>
            {(
              [
                { value: 'line', label: '行' },
                { value: 'word', label: '单词' },
                { value: 'char', label: '字符' },
              ] as const
            ).map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => setGranularity(item.value)}
                className={cn(
                  'rounded-md px-2 py-1 text-xs transition-colors',
                  granularity === item.value
                    ? 'bg-brand-muted text-brand'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
          <span className="h-4 w-px bg-border" />
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-xs text-muted-foreground">忽略</span>
            <ToggleChip active={options.trimWhitespace} onClick={() => toggleOption('trimWhitespace')}>
              首尾空白
            </ToggleChip>
            <ToggleChip
              active={options.ignoreAllWhitespace}
              onClick={() => toggleOption('ignoreAllWhitespace')}
            >
              全部空白
            </ToggleChip>
            <ToggleChip active={options.ignoreCase} onClick={() => toggleOption('ignoreCase')}>
              大小写
            </ToggleChip>
            <ToggleChip active={options.ignoreEmptyLines} onClick={() => toggleOption('ignoreEmptyLines')}>
              空行
            </ToggleChip>
          </div>
          <ToggleChip active={mergeMode} onClick={() => setMergeMode((prev) => !prev)}>
            合并模式
          </ToggleChip>
        </div>

        {/* ——— 输入区：左右两栏 ——— */}
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          <textarea
            aria-label="原文本 A"
            autoFocus
            value={textA}
            onChange={(event) => setTextA(event.target.value)}
            placeholder="原文本 A"
            spellCheck={false}
            className={
              'h-[150px] w-full resize-none rounded-lg border border-input bg-background p-3 font-mono text-xs ' +
              'text-foreground placeholder:text-muted-foreground ' +
              'focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/20'
            }
          />
          <textarea
            aria-label="新文本 B"
            value={textB}
            onChange={(event) => setTextB(event.target.value)}
            placeholder="新文本 B"
            spellCheck={false}
            className={
              'h-[150px] w-full resize-none rounded-lg border border-input bg-background p-3 font-mono text-xs ' +
              'text-foreground placeholder:text-muted-foreground ' +
              'focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/20'
            }
          />
        </div>

        {/* ——— 统计条 ——— */}
        {stats !== null ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 text-xs">
            <span className="text-emerald-700">+{stats.added} 新增</span>
            <span className="text-red-700">-{stats.removed} 删除</span>
            <span className="text-amber-700">~{stats.modified} 修改</span>
            <span className="text-muted-foreground">{stats.same} 相同</span>
            <span className="ml-auto font-semibold text-foreground">相似度 {stats.similarity}%</span>
            {tooLongForGranularity ? (
              <span className="text-amber-600">文本过长，已自动回退行级对比</span>
            ) : null}
          </div>
        ) : null}

        {/* ——— 差异视图 ——— */}
        {rows === null ? (
          <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            在上方输入两段文本后自动对比
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
              <span className="text-sm font-medium text-foreground">差异</span>
              <div className="flex items-center gap-2">
                {rows.length > MAX_RENDER_ROWS ? (
                  <span className="text-xs text-amber-600">
                    共 {rows.length} 行，仅渲染前 {MAX_RENDER_ROWS} 行
                  </span>
                ) : null}
                <span className="text-xs text-muted-foreground">
                  {mode === 'split' ? '左右两栏可独立滚动' : '行内视图'}
                </span>
              </div>
            </div>

            {hasDiff ? (
              <div className="h-[340px] p-2">
                {mode === 'split' ? (
                  <div className="grid h-full grid-cols-2 gap-2">
                    <div className="scrollbar-thin h-full overflow-auto pr-1">
                      {visibleRows.map((row, index) => (
                        <div key={`l-${index}`} className="flex flex-col gap-0.5">
                          <DiffCell
                            line={row.left}
                            kind={row.kind}
                            side="left"
                          />
                          {mergeMode && row.kind !== 'same' ? (
                            <MergeBar
                              row={row}
                              index={index}
                              choice={resolutions[index]}
                              onChoose={setResolution}
                            />
                          ) : null}
                        </div>
                      ))}
                    </div>
                    <div className="scrollbar-thin h-full overflow-auto pr-1">
                      {visibleRows.map((row, index) => (
                        <div key={`r-${index}`} className="flex flex-col gap-0.5">
                          <DiffCell
                            line={row.right}
                            kind={row.kind}
                            side="right"
                          />
                          {mergeMode && row.kind !== 'same' ? (
                            <div className="min-h-[22px]" aria-hidden="true" />
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="scrollbar-thin h-full overflow-auto">
                    {visibleRows.map((row, index) => (
                      <div key={`i-${index}`} className="flex flex-col gap-0.5">
                        {row.kind === 'same' ? (
                          // 相同行只渲染一次（否则左右各一条，内容重复）
                          <DiffCell line={row.left} kind="same" side="left" />
                        ) : (
                          <>
                            {row.left !== null ? (
                              <DiffCell line={row.left} kind={row.kind} side="left" />
                            ) : null}
                            {row.right !== null ? (
                              <DiffCell line={row.right} kind={row.kind} side="right" />
                            ) : null}
                          </>
                        )}
                        {mergeMode && row.kind !== 'same' ? (
                          <MergeBar
                            row={row}
                            index={index}
                            choice={resolutions[index]}
                            onChoose={setResolution}
                          />
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="p-8 text-center text-sm text-muted-foreground">
                两段文本内容一致，无差异
              </div>
            )}
          </div>
        )}

        {/* ——— 合并结果 ——— */}
        {mergeMode && rows !== null ? (
          <div className="rounded-xl border border-border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
              <span className="text-sm font-medium text-foreground">合并结果</span>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => applyAll('left')}>
                  全部接受左
                </Button>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => applyAll('right')}>
                  全部接受右
                </Button>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={resetResolutions}>
                  重置
                </Button>
                <CopyButton text={merged} variant="ghost" size="sm" className="h-7 px-2 text-xs" />
              </div>
            </div>
            <div className="scrollbar-thin max-h-[180px] overflow-auto p-3">
              <pre className="whitespace-pre-wrap break-all font-mono text-xs text-foreground">
                {merged}
              </pre>
            </div>
            <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
              默认取右侧（B）内容；点击差异块下方的「接受左 / 接受右」可逐块覆盖。
            </div>
          </div>
        ) : null}

        {/* ——— 底部操作 ——— */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => downloadFile('handy-diff-left.txt', normalizedA)}
          >
            下载左侧
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => downloadFile('handy-diff-right.txt', normalizedB)}
          >
            下载右侧
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => downloadFile('handy-diff.patch', unified)}
            disabled={rows === null}
          >
            下载 unified diff
          </Button>
          <Button size="sm" variant="ghost" onClick={swap}>
            交换 A / B
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-muted-foreground"
            onClick={() => {
              setTextA('');
              setTextB('');
              setResolutions({});
            }}
          >
            清空
          </Button>
        </div>
      </div>
    </CommandShell>
  );
}

/** 差异块的「接受左 / 接受右」操作条 */
function MergeBar({
  row,
  index,
  choice,
  onChoose,
}: {
  row: DiffRow;
  index: number;
  choice?: 'left' | 'right';
  onChoose: (index: number, choice: 'left' | 'right') => void;
}): React.JSX.Element {
  const resolved = choice ?? 'right';
  const leftLabel = row.kind === 'added' ? '不采纳' : '接受左';
  const rightLabel = row.kind === 'removed' ? '不采纳' : '接受右';
  return (
    <div className="flex items-center gap-1 pl-2">
      <button
        type="button"
        onClick={() => onChoose(index, 'left')}
        className={cn(
          'rounded border px-1.5 py-0.5 text-[10px] transition-colors',
          resolved === 'left'
            ? 'border-red-300 bg-red-50 text-red-700'
            : 'border-border text-muted-foreground hover:text-foreground',
        )}
      >
        ← {leftLabel}
      </button>
      <button
        type="button"
        onClick={() => onChoose(index, 'right')}
        className={cn(
          'rounded border px-1.5 py-0.5 text-[10px] transition-colors',
          resolved === 'right'
            ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
            : 'border-border text-muted-foreground hover:text-foreground',
        )}
      >
        {rightLabel} →
      </button>
    </div>
  );
}

export default TextDiff;
