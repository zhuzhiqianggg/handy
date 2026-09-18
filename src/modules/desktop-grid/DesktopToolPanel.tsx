import * as React from 'react';
import { ArrowLeft, Boxes, Loader2, Search, Wrench, X } from 'lucide-react';
import { registry } from '@/core/moduleRegistry';
import { searchCommands } from '@/lib/search';
import type { CommandMeta } from '@/core/types';
import { cn } from '@/lib/utils';

/**
 * 桌面工具箱抽屉（V43）。
 *
 * 用户原话：
 *   · 「我们这个界面直接在桌面上搜索调出对应的工具，整个全量的工具箱列表框是否需要呢？
 *      如果需要的话我建议跟桌面成为一个整体而不是独立的窗口」
 *   · 「我在桌面上就能完成所有的操作 不需要调出一个窗口去找工具等 样式也优化美化下」
 *   · 「密码存储箱也可以作为一个工具存在，而不是一个独立的页面」
 *
 * 做法：**桌面上直接开一个抽屉** —— 左边是全量「工具 + 模块页面」列表（可搜索），
 * 右边就是**它本身的界面**（工具走 `CommandMeta.load()`、模块走 `ModuleMeta.loadView()`，
 * 与主窗口是同一条契约、同一个组件）。全程不切窗口、不离开桌面。
 *
 * 关于「是否还要那个独立窗口」：抽屉里能开的东西 = 主窗口侧栏能开的东西，
 * 所以主窗口退化成「设置 / 管理控制台」，日常使用不再需要它。
 */
export interface DesktopToolPanelProps {
  /** 关闭整个抽屉 */
  onClose: () => void;
  /** 直接从外部指定要打开的一项（如桌面搜索面板选中的结果） */
  initial?: PanelEntry | null;
}

/** 抽屉里能打开的一项：工具（命令）或模块页面 */
export interface PanelEntry {
  id: string;
  name: string;
  description: string;
  kind: 'tool' | 'module';
  load: () => Promise<{ default: React.ComponentType<Record<string, never>> }>;
}

/** 把注册表里的命令 / 模块统一成抽屉能渲染的条目 */
function collectEntries(): PanelEntry[] {
  const modules: PanelEntry[] = registry
    .enabled()
    .filter((mod) => typeof mod.loadView === 'function')
    .map((mod) => ({
      id: `module:${mod.id}`,
      name: mod.name,
      description: mod.description,
      kind: 'module' as const,
      load: mod.loadView as PanelEntry['load'],
    }));

  const tools: PanelEntry[] = registry
    .commands()
    .filter((command) => typeof command.load === 'function')
    .map((command) => ({
      id: command.id,
      name: command.name,
      description: command.description,
      kind: 'tool' as const,
      load: command.load as PanelEntry['load'],
    }));

  return [...modules, ...tools];
}

export function DesktopToolPanel({ onClose, initial = null }: DesktopToolPanelProps): React.JSX.Element {
  const [query, setQuery] = React.useState('');
  const [active, setActive] = React.useState<PanelEntry | null>(initial);
  const [View, setView] = React.useState<React.ComponentType<Record<string, never>> | null>(null);
  const [loading, setLoading] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const all = React.useMemo(collectEntries, []);

  /** 搜索：命令走拼音 / 模糊（`searchCommands`），模块按名称 / 描述过滤，两路合并 */
  const results = React.useMemo(() => {
    const keyword = query.trim();
    if (keyword.length === 0) {
      return all;
    }
    const hit = new Set(searchCommands(registry.commands(), keyword, 80).map((command) => command.id));
    const lower = keyword.toLowerCase();
    return all.filter(
      (entry) =>
        hit.has(entry.id) ||
        entry.name.toLowerCase().includes(lower) ||
        entry.description.toLowerCase().includes(lower),
    );
  }, [query, all]);

  // 选中 → 懒加载它自己的组件（与主窗口同一条 `load` / `loadView` 契约）
  React.useEffect(() => {
    if (active === null) {
      setView(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void active
      .load()
      .then((mod) => {
        if (!cancelled) {
          setView(() => mod.default as React.ComponentType<Record<string, never>>);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setView(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  // Esc：先退回列表，再关抽屉
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return;
      }
      if (active !== null) {
        setActive(null);
      } else {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, onClose]);

  const firstResult = results[0] ?? null;

  return (
    <div
      // 抽屉内部的事件不往桌面画布冒泡（否则会被当成「点空白处收面板」）
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      style={{ pointerEvents: 'auto' }}
      className="relative flex h-full w-full overflow-hidden rounded-2xl bg-neutral-900/93 text-neutral-100 shadow-2xl ring-1 ring-white/15 backdrop-blur-2xl"
    >
      {/* 左：全量列表 */}
      <div className="flex w-72 shrink-0 flex-col border-r border-white/10">
        <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2.5">
          <Search className="h-3.5 w-3.5 shrink-0 opacity-60" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && firstResult !== null) {
                setActive(firstResult);
              }
            }}
            placeholder="搜索工具 / 页面（名称 / 拼音首字母）…"
            className="min-w-0 flex-1 bg-transparent text-xs text-neutral-100 outline-none placeholder:text-neutral-500"
          />
          <span className="shrink-0 text-[10px] text-neutral-500">{results.length}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {results.length === 0 && (
            <p className="px-2 py-6 text-center text-[11px] text-neutral-500">没有匹配项</p>
          )}
          {results.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setActive(entry)}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition',
                active?.id === entry.id ? 'bg-white/15' : 'hover:bg-white/10',
              )}
            >
              <span className="mt-0.5 shrink-0 text-neutral-400">
                {entry.kind === 'module' ? (
                  <Boxes className="h-3.5 w-3.5" />
                ) : (
                  <Wrench className="h-3.5 w-3.5" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{entry.name}</span>
                <span className="block truncate text-[10px] text-neutral-400">
                  {entry.description}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* 右：工具 / 页面本体 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
          {active !== null && (
            <button
              type="button"
              onClick={() => setActive(null)}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-neutral-300 transition hover:bg-white/10"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              全部
            </button>
          )}
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {active === null ? '工具箱 · 在桌面上直接用' : active.name}
          </span>
          <button
            type="button"
            onClick={onClose}
            title="关闭工具箱（Esc）"
            className="rounded-md p-1 text-neutral-400 transition hover:bg-white/10 hover:text-neutral-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-neutral-950/50">
          {active === null ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
              <p className="text-sm text-neutral-300">左边选一项，界面就出现在这里</p>
              <p className="max-w-md text-[11px] leading-relaxed text-neutral-500">
                工具箱就在桌面上，不用再开一个窗口去找。回车打开第一个匹配项，Esc 退回列表。
              </p>
            </div>
          ) : loading || View === null ? (
            <div className="flex h-full items-center justify-center gap-2 text-[11px] text-neutral-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在打开 {active.name}…
            </div>
          ) : (
            <View />
          )}
        </div>
      </div>
    </div>
  );
}
