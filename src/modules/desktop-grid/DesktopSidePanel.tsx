import * as React from 'react';
import {
  AppWindow,
  ArrowLeft,
  Boxes,
  CalendarDays,
  ChevronDown,
  Link2,
  Loader2,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  Wrench,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { registry } from '@/core/moduleRegistry';
import { ipc } from '@/lib/ipc';
import { toast } from '@/components/ui/toast';
import { searchCommands } from '@/lib/search';
import { categoryMetaOf, orderedCategories } from '@/core/toolCategories';
import { resolveIcon } from '@/lib/icons';
import { ACTION_ICONS } from '@/modules/workstation/QuickActionsRail';
import { loadQuickLinks, type QuickLink } from '@/modules/workstation/quicklinks';
import { useAppStore } from '@/stores/useAppStore';
import type { SysAction } from '@/types/sys';
import { cn } from '@/lib/utils';

/**
 * 桌面右侧统一面板（V45 建立 · V46 实心化）。
 *
 * ## 为什么推倒重来
 *
 * V42–V44 期间桌面上一共有**四个各自为政的浮层**：中部搜索小浮层、偏左的大抽屉式
 * 工具箱（`DesktopToolPanel`，宽 `min(1120px,90vw)` 几乎铺满）、右下快捷浮层
 * （`DesktopQuickActions`）、底部 Dock。用户 09-19 的截图反馈：
 *   · 「工具搜索应该放在右侧，跟工作台差不多 直接搜索获取，而不是打开额外的对话框 很乱」
 *   · 「还是有点混乱」
 * 病根是**同一件事有多个入口、每个入口一个位置一套交互**：想搜个工具得先想「该点搜索
 * 还是工具箱」，然后面对一个铺满桌面的大框，左边一列列表右边一块空白 —— 与「在桌面上
 * 顺手用一下」完全相反。
 *
 * ## 现在的模型：一个面板，两个页签
 *
 * 固定贴在桌面右侧（不铺满、不居中弹），所有「找东西 / 用东西」都在这一个容器里：
 *   · **工具**页签：顶部搜索框 → 结果列表（空查询时按分类分组浏览）→ 点一项，
 *     **面板原地**换成那个工具本体的界面（顶部一条「返回」），全程不弹第二个框；
 *   · **快捷**页签：应用入口（工具箱 / 工作台 / 密码存储器 / 桌面整理 / 设置 / 主窗口）
 *     + 我的快捷方式（与 Dock 同一份 `quicklinks` 数据）+ 系统入口（hosts 编辑 / 服务 /
 *     证书…，走 Rust 白名单 `sys_action_run`，无注入面）。
 *
 * ## V46：桌面上的东西一律**实心**
 *
 * 用户 09-19 的反馈：「工具箱这些工具类**不要透明了**，透明有问题」「现在这个全都是透明
 * 很难清楚的操作。还有大小也不太友好」。
 *
 * 半透明在桌面上是**可用性缺陷**而不是美化：壁纸是一张高对比照片时，面板里的文字、
 * 次级按钮、列表分隔都糊在背景上，读不清也点不准。所以 V46 起：
 *   · 面板外壳 `bg-neutral-900`（不透明），工具本体区 `bg-neutral-950`（不透明）
 *     —— 只保留 1px 的 `ring-white/15` 作边界，不再用 `/93 + backdrop-blur` 那套玻璃；
 *   · 尺寸按「装得下一个真实工具」定（`min(820px, ...)`、上下留白），不再按浮层定；
 *   · 标题栏提供 **「在控制台打开」**：桌面负责顺手用一下，控制台（主窗口）负责完整界面。
 *
 * ## 与其它组件的关系
 *
 * 本组件取代并删除了 `DesktopToolPanel`（大抽屉）与 `DesktopQuickActions`（右下浮层）；
 * Dock 保持原样 —— 它是「用户主动拖进来的快捷方式」，与这里的「找 / 用」不是同一诉求。
 * 工具本体仍走 `CommandMeta.load()` / `ModuleMeta.loadView()`，与主窗口同一条契约，
 * 不存在第二份实现。
 */

/** 面板里能打开的一项：工具（命令）或模块页面 */
export interface PanelEntry {
  id: string;
  name: string;
  description: string;
  kind: 'tool' | 'module';
  /** 工具分类（仅工具用；列表右侧的灰标签） */
  category?: string;
  /** 图标名（走 `resolveIcon`）；缺省按 kind 兜底 */
  icon?: string;
  load: () => Promise<{ default: React.ComponentType<Record<string, never>> }>;
}

/** 面板页签 */
export type SidePanelTab = 'tools' | 'quick';

export interface DesktopSidePanelProps {
  /** 打开时落在哪个页签 */
  initialTab?: SidePanelTab;
  /** 直接进入「使用模式」的那一项（如从工具栏「密码箱」带过来的） */
  initialEntry?: PanelEntry | null;
  /** 关闭面板 */
  onClose: () => void;
  /** 快捷页签里打开一个应用入口（`module:<id>` / 命令 id / `settings`） */
  onLaunch: (target: string) => void;
  /** 打开一条用户快捷方式 */
  onOpenLink: (link: QuickLink) => void;
  /** 移除一条用户快捷方式 */
  onRemoveLink: (id: string) => void;
}

/**
 * 面板外壳的定位 / 尺寸类（由 `GridOverlay` 渲染外层容器时套用）。
 *
 * - `right-[252px]`：右下角常驻着桌面工具栏（`right-5` 起、竖排四组、最宽一组是
 *   「原生图标隐藏 / 对账 / 隐藏」约 236px）。面板整体落在它**左侧**，
 *   两者永不重叠 —— V45 用的 `right-[124px]` 是按「工具栏约 92px 宽」估的，
 *   V45 加了「密码箱」按钮之后工具栏变宽，估算就失效了，面板会盖住工具栏
 *   （用户截图里「工具栏不见了」的观感来源之一）；
 * - `bottom-[92px]`：底部**居中**的 Dock 快捷条最宽可到 `60vw`，横向必然与面板相交
 *   （面板左缘在 1707px 屏上约 x=635），所以纵向必须让开它 —— Dock 高约 44px + 距底 20px，
 *   面板停在 92px 处即可。⚠️ 别因为「Dock 在中间、面板在右边」就以为不重叠：
 *   60vw 的宽度是**跨到右边的**。
 *
 * 尺寸按「装得下一个真实工具」定：分栏类工具（JSON 格式化 / 文本对比）左右两栏
 * 都要撑得开，所以宽度下限取 820px（而不是 V45 的 620px）。
 */
export const SIDE_PANEL_SHELL =
  'absolute right-[252px] top-4 bottom-[92px] z-40 w-[min(820px,calc(100vw-300px))]';

/** 把注册表里的命令 / 模块统一成面板能渲染的条目 */
export function collectPanelEntries(): PanelEntry[] {
  const tools: PanelEntry[] = registry
    .commands()
    .filter((command) => typeof command.load === 'function')
    .map((command) => ({
      id: command.id,
      name: command.name,
      description: command.description,
      kind: 'tool' as const,
      ...(command.category !== undefined ? { category: command.category } : {}),
      ...(command.icon !== undefined ? { icon: command.icon } : {}),
      load: command.load as PanelEntry['load'],
    }));

  const modules: PanelEntry[] = registry
    .enabled()
    .filter((mod) => typeof mod.loadView === 'function')
    .map((mod) => ({
      id: `module:${mod.id}`,
      name: mod.name,
      description: mod.description,
      kind: 'module' as const,
      icon: mod.icon,
      load: mod.loadView as PanelEntry['load'],
    }));

  return [...tools, ...modules];
}

/** 桌面「应用入口」（点一下在面板里打开，不弹窗口） */
const APP_SHORTCUTS: ReadonlyArray<{
  target: string;
  name: string;
  description: string;
  icon: LucideIcon;
}> = [
  { target: 'module:toolbox', name: '工具箱', description: '全部本地小工具', icon: Wrench },
  { target: 'module:notes', name: '工作台', description: '日历 · 计划 · 笔记', icon: CalendarDays },
  { target: 'vault', name: '密码存储器', description: 'AES-256-GCM 本地密码库', icon: ShieldCheck },
  { target: 'module:desktop-organizer', name: '桌面整理', description: '一键整理 · 布局备份', icon: Boxes },
];

export function DesktopSidePanel({
  initialTab = 'tools',
  initialEntry = null,
  onClose,
  onLaunch,
  onOpenLink,
  onRemoveLink,
}: DesktopSidePanelProps): React.JSX.Element {
  const [tab, setTab] = React.useState<SidePanelTab>(initialEntry !== null ? 'tools' : initialTab);
  const [query, setQuery] = React.useState('');
  const [active, setActive] = React.useState<PanelEntry | null>(initialEntry);
  const [View, setView] = React.useState<React.ComponentType<Record<string, never>> | null>(null);
  const [loading, setLoading] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  const all = React.useMemo(collectPanelEntries, []);

  // 落在「工具」页签且还在列表态时自动聚焦搜索框：打开面板就能直接敲
  React.useEffect(() => {
    if (tab === 'tools' && active === null) {
      inputRef.current?.focus();
    }
  }, [tab, active]);

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

  /** 空查询时按分类分组（可发现性：不只靠搜，也能顺着一栏栏看过去） */
  const grouped = React.useMemo(() => {
    const buckets = new Map<string, PanelEntry[]>();
    for (const entry of results) {
      const key = entry.kind === 'module' ? '__modules__' : (entry.category ?? 'other');
      const list = buckets.get(key);
      if (list) {
        list.push(entry);
      } else {
        buckets.set(key, [entry]);
      }
    }
    const ordered: { key: string; title: string; entries: PanelEntry[] }[] = [];
    for (const meta of orderedCategories()) {
      const list = buckets.get(meta.id);
      if (list && list.length > 0) {
        ordered.push({ key: meta.id, title: meta.name, entries: list });
      }
    }
    for (const [key, list] of buckets) {
      if (categoryMetaOf(key) === undefined && key !== '__modules__') {
        ordered.push({ key, title: '其他', entries: list });
      }
    }
    const modules = buckets.get('__modules__');
    if (modules && modules.length > 0) {
      ordered.push({ key: '__modules__', title: '页面', entries: modules });
    }
    return ordered;
  }, [results]);

  // 选中 → 懒加载它自己的组件（与主窗口同一条 `load` / `loadView` 契约）
  React.useEffect(() => {
    if (active === null) {
      setView(null);
      return undefined;
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

  // Esc：先退回列表，再关面板
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

  /** 快捷页签里「点了就走」的入口：先收面板，再执行（用户马上就能看到结果） */
  const launchAndClose = (fn: () => Promise<void>): void => {
    onClose();
    void fn().catch((error: unknown) =>
      toast.error(error instanceof Error ? error.message : String(error)),
    );
  };

  /**
   * 「在控制台打开」（V46）：收面板 → 显示主窗口并**直达**这一个工具 / 页面。
   *
   * 走 `desktop_open_view`（Rust 侧 `show_main_palette` + `handy:navigate` 事件），
   * 与顶部贴条「打开工作台」是同一套机制 —— 视图状态每窗口各持一份（ADR-8），
   * 挂件窗改不了主窗口的 store，只能发事件。
   * `entry.id` 对模块是 `module:<id>`、对工具是命令 id，与那个监听的语义正好对齐。
   */
  const openInConsole = (entry: PanelEntry): void => {
    onClose();
    void ipc
      .desktopOpenView(entry.id)
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : String(error)),
      );
  };

  return (
    <div
      // 面板内部的事件不往桌面画布冒泡（否则会被当成「点空白处收面板」）
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      style={{ pointerEvents: 'auto' }}
      // V46 实心化：`bg-neutral-900`（不透明）+ 1px 边界。半透明玻璃在真实壁纸上
      // 会让正文、次级按钮、分隔线全部糊掉，用户的判断是「很难清楚的操作」——这是
      // 可用性问题，不是审美偏好。阴影保留，用来和壁纸区分层次。
      className="flex h-full w-full flex-col overflow-hidden rounded-2xl bg-neutral-900 text-neutral-100 shadow-2xl ring-1 ring-white/15"
    >
      {/* —— 顶栏：页签 + 控制台 + 关闭 —— */}
      <div className="flex items-center gap-1 border-b border-white/10 px-2.5 py-2">
        <TabButton
          icon={Wrench}
          label="工具"
          tip="搜索并使用任意工具 / 页面（在面板里就地打开）"
          active={tab === 'tools'}
          onClick={() => {
            setTab('tools');
            setActive(null);
          }}
        />
        <TabButton
          icon={Zap}
          label="快捷"
          tip="应用入口 · 我的快捷方式 · 系统入口"
          active={tab === 'quick'}
          onClick={() => {
            setTab('quick');
            setActive(null);
          }}
        />
        {/* V46：桌面 → 控制台的固定出口。用户原话：「工具打开还是可以直接切换 handy
            控制台页面」——桌面负责顺手用一下，控制台负责完整界面，任何时候都能过去。 */}
        <button
          type="button"
          onClick={() => launchAndClose(() => ipc.appShowMain())}
          title="打开 Handy 控制台（主窗口）：工作台 · 桌面整理控制台 · 全部模块的完整界面"
          className="ml-auto flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-neutral-300 transition hover:bg-white/10 hover:text-neutral-100"
        >
          <AppWindow className="h-3.5 w-3.5" />
          控制台
        </button>
        <button
          type="button"
          onClick={onClose}
          title="关闭面板（Esc）"
          className="rounded-md p-1 text-neutral-400 transition hover:bg-white/10 hover:text-neutral-100"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {tab === 'tools' ? (
        <ToolsTab
          active={active}
          View={View}
          loading={loading}
          query={query}
          setQuery={setQuery}
          inputRef={inputRef}
          results={results}
          grouped={grouped}
          firstResult={results[0] ?? null}
          onPick={setActive}
          onBack={() => setActive(null)}
          onOpenConsole={openInConsole}
        />
      ) : (
        <QuickTab
          onLaunch={onLaunch}
          onOpenLink={onOpenLink}
          onRemoveLink={onRemoveLink}
          onOpenSettings={() => launchAndClose(() => ipc.desktopOpenView('settings'))}
          onOpenMain={() => launchAndClose(() => ipc.appShowMain())}
        />
      )}
    </div>
  );
}

/** 页签按钮 */
function TabButton({
  icon: Icon,
  label,
  tip,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  tip: string;
  active: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={tip}
      className={cn(
        'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition',
        active ? 'bg-white/15 text-sky-200' : 'text-neutral-300 hover:bg-white/10',
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

/** 「工具」页签：搜索 + 列表，或（选中后）工具本体 */
function ToolsTab({
  active,
  View,
  loading,
  query,
  setQuery,
  inputRef,
  results,
  grouped,
  firstResult,
  onPick,
  onBack,
  onOpenConsole,
}: {
  active: PanelEntry | null;
  View: React.ComponentType<Record<string, never>> | null;
  loading: boolean;
  query: string;
  setQuery: (value: string) => void;
  inputRef: React.MutableRefObject<HTMLInputElement | null>;
  results: PanelEntry[];
  grouped: { key: string; title: string; entries: PanelEntry[] }[];
  firstResult: PanelEntry | null;
  onPick: (entry: PanelEntry) => void;
  onBack: () => void;
  onOpenConsole: (entry: PanelEntry) => void;
}): React.JSX.Element {
  if (active !== null) {
    return (
      <>
        <div className="flex items-center gap-2 border-b border-white/10 px-2.5 py-2">
          <button
            type="button"
            onClick={onBack}
            className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-neutral-300 transition hover:bg-white/10 hover:text-neutral-100"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            返回
          </button>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{active.name}</span>
          {/* V46：工具窗的固定出口 —— 需要更大空间 / 完整界面时去控制台，不必先关面板。 */}
          <button
            type="button"
            onClick={() => onOpenConsole(active)}
            title={`在 Handy 控制台打开「${active.name}」（完整界面）`}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[12px] text-neutral-200 transition hover:border-sky-400/40 hover:bg-white/10 hover:text-sky-200"
          >
            <AppWindow className="h-3.5 w-3.5" />
            在控制台打开
          </button>
        </div>
        {/* V46：工具本体底**必须不透明** —— 工具自己只画内容，不再叠在半透明玻璃上 */}
        <div className="min-h-0 flex-1 overflow-auto bg-neutral-950">
          {loading || View === null ? (
            <div className="flex h-full items-center justify-center gap-2 text-[12px] text-neutral-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在打开 {active.name}…
            </div>
          ) : (
            <View />
          )}
        </div>
      </>
    );
  }

  const keyword = query.trim();

  return (
    <>
      <div className="flex items-center gap-2 border-b border-white/10 px-3.5 py-2.5">
        <Search className="h-4 w-4 shrink-0 opacity-60" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && firstResult !== null) {
              onPick(firstResult);
            }
          }}
          placeholder="搜索工具 / 页面（名称、拼音首字母都行）…"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-neutral-100 outline-none placeholder:text-neutral-500"
        />
        <span className="shrink-0 text-[11px] text-neutral-500">{results.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {results.length === 0 && (
          <p className="px-2 py-6 text-center text-[12px] text-neutral-500">没有匹配项</p>
        )}
        {keyword.length > 0
          ? results.map((entry) => <EntryRow key={entry.id} entry={entry} onPick={onPick} />)
          : grouped.map((group) => (
              <div key={group.key} className="mb-2">
                <p className="px-2.5 pb-1.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                  {group.title}
                </p>
                {group.entries.map((entry) => (
                  <EntryRow key={entry.id} entry={entry} onPick={onPick} />
                ))}
              </div>
            ))}
      </div>
      <p className="border-t border-white/10 px-3.5 py-2 text-[11px] text-neutral-500">
        回车打开第一项 · 工具就在这块面板里用，需要更大空间点标题栏「在控制台打开」
      </p>
    </>
  );
}

/** 列表里的一行 */
function EntryRow({
  entry,
  onPick,
}: {
  entry: PanelEntry;
  onPick: (entry: PanelEntry) => void;
}): React.JSX.Element {
  const Icon =
    entry.icon !== undefined ? resolveIcon(entry.icon) : entry.kind === 'module' ? Boxes : Wrench;
  const category = entry.kind === 'tool' ? categoryMetaOf(entry.category) : undefined;
  return (
    <button
      type="button"
      onClick={() => onPick(entry)}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-white/10"
    >
      <span className="shrink-0 rounded-md bg-white/10 p-2 text-neutral-200">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{entry.name}</span>
        <span className="block truncate text-[11px] text-neutral-400">{entry.description}</span>
      </span>
      {category !== undefined && (
        <span className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-neutral-400">
          {category.name}
        </span>
      )}
    </button>
  );
}

/** 「快捷」页签：应用入口 + 我的快捷方式 + 系统入口 */
function QuickTab({
  onLaunch,
  onOpenLink,
  onRemoveLink,
  onOpenSettings,
  onOpenMain,
}: {
  onLaunch: (target: string) => void;
  onOpenLink: (link: QuickLink) => void;
  onRemoveLink: (id: string) => void;
  onOpenSettings: () => void;
  onOpenMain: () => void;
}): React.JSX.Element {
  const [actions, setActions] = React.useState<SysAction[]>([]);
  const [links, setLinks] = React.useState<QuickLink[]>(() => loadQuickLinks());
  const [runningId, setRunningId] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [showAll, setShowAll] = React.useState(false);

  const pinnedIds = useAppStore((state) => state.settings.quickActionIds);
  const updateSettings = useAppStore((state) => state.updateSettings);

  /** 把一条系统入口固定 / 取消固定到桌面 Dock（共用同一份 `settings.quickActionIds`） */
  const togglePin = (id: string): void => {
    const next = pinnedIds.includes(id)
      ? pinnedIds.filter((item) => item !== id)
      : [...pinnedIds, id];
    void updateSettings({ quickActionIds: next }).catch((error: unknown) => {
      toast.error(`固定失败：${error instanceof Error ? error.message : String(error)}`);
    });
  };

  React.useEffect(() => {
    void ipc
      .sysActionList()
      .then((list) => {
        setActions(list);
        setNotice(null);
      })
      .catch((error: unknown) => {
        setNotice(error instanceof Error ? error.message : String(error));
      });
  }, []);

  // 用户快捷方式可能在 Dock 拖入后变化，这里订阅 localStorage 实时同步
  React.useEffect(() => {
    const sync = (): void => setLinks(loadQuickLinks());
    window.addEventListener('handy:quicklinks', sync as EventListener);
    return () => window.removeEventListener('handy:quicklinks', sync as EventListener);
  }, []);

  const byId = React.useMemo(() => new Map(actions.map((action) => [action.id, action])), [actions]);
  const pinned = React.useMemo(
    () =>
      pinnedIds
        .map((id) => byId.get(id))
        .filter((action): action is SysAction => action !== undefined),
    [pinnedIds, byId],
  );

  const groupedActions = React.useMemo(() => {
    const map = new Map<string, SysAction[]>();
    for (const action of actions) {
      const bucket = map.get(action.group);
      if (bucket) {
        bucket.push(action);
      } else {
        map.set(action.group, [action]);
      }
    }
    return Array.from(map.entries());
  }, [actions]);

  const run = (action: SysAction): void => {
    setRunningId(action.id);
    void ipc
      .sysActionRun(action.id)
      .then(() => {
        if (action.elevated) {
          toast.success(`已请求管理员权限：${action.name}`, {
            description: '请在系统弹窗中点「是」以继续',
          });
        }
      })
      .catch((error: unknown) => {
        toast.error(`执行失败：${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => setRunningId(null));
  };

  const ActionButton = ({ action }: { action: SysAction }): React.JSX.Element => {
    const Icon = ACTION_ICONS[action.id] ?? Wrench;
    const running = runningId === action.id;
    const isPinned = pinnedIds.includes(action.id);
    return (
      <div className="group relative">
        <button
          type="button"
          disabled={running}
          title={`${action.name} — ${action.description}`}
          onClick={() => run(action)}
          className="flex w-full items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 pr-6 text-left transition hover:border-sky-400/40 hover:bg-white/10"
        >
          <Icon className="h-3.5 w-3.5 shrink-0 text-neutral-200" />
          <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-100">{action.name}</span>
          {action.elevated ? (
            <span className="shrink-0 rounded bg-amber-400/20 px-1 text-[8px] text-amber-200">管</span>
          ) : null}
          {running ? <Loader2 className="h-3 w-3 shrink-0 animate-spin text-sky-300" /> : null}
        </button>
        {/* 图钉开关：钉 = 同时出现在桌面 Dock 上（V44.1 起可在桌面直接钉，不必回工作台） */}
        <button
          type="button"
          onClick={() => togglePin(action.id)}
          title={isPinned ? '取消固定（同时从桌面 Dock 移除）' : '固定到桌面 Dock'}
          className={cn(
            'absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 transition',
            isPinned
              ? 'text-sky-300'
              : 'text-neutral-500 opacity-0 hover:text-neutral-200 group-hover:opacity-100',
          )}
        >
          {isPinned ? <ChevronDown className="h-3 w-3 rotate-180" /> : <Plus className="h-3 w-3" />}
        </button>
      </div>
    );
  };

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
      {/* —— 应用入口 —— */}
      <Section title="应用入口">
        <div className="grid grid-cols-2 gap-1.5">
          {APP_SHORTCUTS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.target}
                type="button"
                onClick={() => onLaunch(item.target)}
                title={item.description}
                className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-left transition hover:border-sky-400/40 hover:bg-white/10"
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-neutral-200" />
                <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-100">{item.name}</span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={onOpenSettings}
            title="快捷键 · 主题 · 开机启动 · 备份还原"
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-left transition hover:border-sky-400/40 hover:bg-white/10"
          >
            <Settings className="h-3.5 w-3.5 shrink-0 text-neutral-200" />
            <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-100">设置</span>
          </button>
          <button
            type="button"
            onClick={onOpenMain}
            title="打开 Handy 主窗口（工作台 / 桌面整理控制台 / 全部模块的完整界面）"
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-left transition hover:border-sky-400/40 hover:bg-white/10"
          >
            <AppWindow className="h-3.5 w-3.5 shrink-0 text-neutral-200" />
            <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-100">主窗口</span>
          </button>
        </div>
      </Section>

      {/* —— 我的快捷方式（与 Dock 同源） —— */}
      <Section title={`我的快捷方式（${links.length}）`}>
        {links.length === 0 ? (
          <p className="px-1 py-1.5 text-[11px] leading-relaxed text-neutral-500">
            把桌面图标 / 文件拖到下方的快捷条（Dock）即可收成一条；这里与 Dock 是同一份数据。
          </p>
        ) : (
          <div className="space-y-1">
            {links.map((link) => (
              <div
                key={link.id}
                className="group flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 transition hover:border-sky-400/40 hover:bg-white/10"
              >
                {link.type === 'url' ? (
                  <Link2 className="h-3.5 w-3.5 shrink-0 text-sky-200" />
                ) : (
                  <Boxes className="h-3.5 w-3.5 shrink-0 text-neutral-200" />
                )}
                <button
                  type="button"
                  onClick={() => onOpenLink(link)}
                  title={`${link.name}\n${link.value}\n单击打开`}
                  className="min-w-0 flex-1 truncate text-left text-[12px] text-neutral-100"
                >
                  {link.name}
                </button>
                <button
                  type="button"
                  onClick={() => onRemoveLink(link.id)}
                  title="从快捷方式移除（不删文件）"
                  className="shrink-0 rounded p-0.5 text-neutral-500 opacity-0 transition hover:bg-white/10 hover:text-red-300 group-hover:opacity-100"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* —— 系统快捷（已钉的常用入口） —— */}
      <Section title={`系统快捷（${pinned.length}）`}>
        {pinned.length === 0 ? (
          <p className="px-1 py-1.5 text-[11px] leading-relaxed text-neutral-500">
            还没有固定常用入口。展开下面的「全部系统入口」，鼠标移到任意项上点右侧图钉即可固定到桌面
            Dock。
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            {pinned.map((action) => (
              <ActionButton key={action.id} action={action} />
            ))}
          </div>
        )}
      </Section>

      {/* —— 全部系统入口（可折叠） —— */}
      <Section
        title="全部系统入口"
        action={
          <button
            type="button"
            onClick={() => setShowAll((prev) => !prev)}
            className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-sky-300 transition hover:bg-white/10"
          >
            {showAll ? '收起' : '展开'}
            <ChevronDown className={cn('h-3 w-3 transition', showAll ? 'rotate-180' : '')} />
          </button>
        }
      >
        {showAll ? (
          notice !== null ? (
            <p className="px-1 py-1 text-[10px] text-amber-300">{notice}</p>
          ) : (
            <div className="space-y-2">
              {groupedActions.map(([groupName, list]) => (
                <div key={groupName}>
                  <p className="mb-1 text-[10px] font-medium text-neutral-400">{groupName}</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {list.map((action) => (
                      <ActionButton key={action.id} action={action} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )
        ) : (
          <p className="px-1 py-1.5 text-[11px] leading-relaxed text-neutral-500">
            网络 / 服务 / 证书 / hosts 编辑 / 终端 / 控制面板… 共 {actions.length} 个系统面板，展开后点一下即开。
          </p>
        )}
      </Section>
    </div>
  );
}

/** 小标题 + 可选右侧操作 */
function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">{title}</span>
        <span className="h-px flex-1 bg-white/5" />
        {action}
      </div>
      {children}
    </div>
  );
}
