import * as React from 'react';
import { FileCode } from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { ResultBox } from '@/components/ResultBox';
import { useCommandShell } from '@/hooks/useCommandShell';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'json-to-ts';

/** 字符串 → PascalCase（仅保留字母数字与空格）。 */
function pascalCase(input: string): string {
  const cleaned = input.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (!cleaned) {
    return '';
  }
  return cleaned
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

/** 是否为合法 JS/TS 标识符。 */
function isValidKey(key: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
}

interface BuildState {
  interfaces: string[];
  used: Set<string>;
}

/** 取不重复的接口名（重名追加序号）。 */
function uniqueName(base: string, state: BuildState): string {
  const candidate = pascalCase(base) || 'Root';
  if (!state.used.has(candidate)) {
    state.used.add(candidate);
    return candidate;
  }
  let i = 2;
  while (state.used.has(`${candidate}${i}`)) {
    i += 1;
  }
  const name = `${candidate}${i}`;
  state.used.add(name);
  return name;
}

function primitiveType(value: unknown): string {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (value === null) return 'null';
  return 'unknown';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeOfValue(value: unknown, keyHint: string, state: BuildState): string {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return 'unknown[]';
    }
    const first = value[0];
    if (isPlainObject(first)) {
      const name = uniqueName(`${keyHint}Item`, state);
      buildInterface(first, name, state);
      return `${name}[]`;
    }
    return `${primitiveType(first)}[]`;
  }
  if (isPlainObject(value)) {
    const name = uniqueName(keyHint, state);
    buildInterface(value, name, state);
    return name;
  }
  return primitiveType(value);
}

function buildInterface(obj: Record<string, unknown>, name: string, state: BuildState): void {
  const lines: string[] = [`export interface ${name} {`];
  for (const [key, value] of Object.entries(obj)) {
    const fieldType = typeOfValue(value, key, state);
    const finalType = value === null ? `${fieldType} | null` : fieldType;
    const safeKey = isValidKey(key) ? key : `'${key.replace(/'/g, "\\'")}'`;
    lines.push(`  ${safeKey}: ${finalType};`);
  }
  lines.push('}');
  state.interfaces.push(lines.join('\n'));
}

/** 解析 JSON 并生成 TypeScript 接口文本。 */
function convert(input: string): { ok: boolean; ts: string; error?: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, ts: '' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (cause) {
    return { ok: false, ts: '', error: cause instanceof Error ? cause.message : 'JSON 解析失败' };
  }
  const state: BuildState = { interfaces: [], used: new Set() };
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return { ok: true, ts: 'export type Root = unknown[];' };
    }
    const first = parsed[0];
    if (isPlainObject(first)) {
      const name = uniqueName('RootItem', state);
      buildInterface(first, name, state);
      return { ok: true, ts: [...state.interfaces, `export type Root = ${name}[];`].join('\n\n') };
    }
    return { ok: true, ts: `export type Root = ${primitiveType(first)}[];` };
  }
  if (isPlainObject(parsed)) {
    buildInterface(parsed, 'Root', state);
    return { ok: true, ts: state.interfaces.join('\n\n') };
  }
  return { ok: true, ts: `export type Root = ${primitiveType(parsed)};` };
}

/**
 * JSON → TypeScript 接口生成器：根据粘贴的 JSON 样例递归推导接口，
 * 支持嵌套对象、数组与命名捕获，结果可一键复制。
 */
export function JsonToTs({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [input, setInput] = React.useState<string>(initialInput);
  const result = React.useMemo(() => convert(input), [input]);

  return (
    <CommandShell
      title="JSON → TypeScript"
      description="粘贴 JSON，生成 TypeScript 接口定义"
      icon={<FileCode className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={result.ok ? result.ts : ''}
      shortcutHint="支持嵌套对象与数组；结果可一键复制"
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-2">
          <label className="text-sm font-medium text-foreground" htmlFor="json-input">
            JSON
          </label>
          <textarea
            id="json-input"
            autoFocus
            rows={14}
            className="w-full min-h-0 flex-1 rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={input}
            placeholder={'{\n  "id": 1,\n  "name": "Handy",\n  "tags": ["a", "b"]\n}'}
            onChange={(event) => setInput(event.target.value)}
          />
          {input.trim() && !result.ok ? (
            <p className="text-xs text-destructive">JSON 解析失败：{result.error}</p>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <ResultBox
            title="TypeScript 接口"
            value={result.ok ? result.ts : ''}
            emptyHint={input.trim() ? 'JSON 无效' : '粘贴 JSON 后自动生成'}
            mono
          />
        </div>
      </div>
    </CommandShell>
  );
}

export default JsonToTs;
