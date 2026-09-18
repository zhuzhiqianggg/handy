import * as React from 'react';
import {
  AppWindow,
  Boxes,
  ChevronDown,
  Link2,
  Loader2,
  Plus,
  Settings,
  ShieldCheck,
  StickyNote,
  Trash2,
  Wrench,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { registry } from '@/core/moduleRegistry';
import { ipc } from '@/lib/ipc';
import { openSettings } from '@/core/navigation';
import { toast } from '@/components/ui/toast';
import { ACTION_ICONS } from '@/modules/workstation/QuickActionsRail';
import {
  loadQuickLinks,
  type QuickLink,
} from '@/modules/workstation/quicklinks';
import { useAppStore } from '@/stores/useAppStore';
import type { SysAction } from '@/types/sys';
import { cn } from '@/lib/utils';

/**
 * 桌面「快捷操作」浮层（V44）。
 *
 * 用户原话：
 *   · 「原工作台我们不是添加了各种快捷入口吗（如 hosts 文件编辑等都没有了呢）」
 *   · 「工作台 便签功能都在桌面了，还有必要保留之前的工作台窗口吗？所有工作台的
 *      功能都迁移到桌面上，快捷入口的快捷方式我说了直接在桌面上做成快捷入口
 *      像快捷导航入口那样。」
 *
 * 做法：**工作台窗口退场，它的能力全部搬上桌面**。这个浮层就是桌面版的「快捷导航入口」：
 *   · 系统快捷动作（hosts 编辑 / 管理员终端 / 网络 / 服务等 50+，图标与工作台同一套
 *     `ACTION_ICONS`，走 Rust 白名单 `sys_action_run`，无注入面）；
 *   · 我的快捷方式（与桌面 Dock 同一份 `quicklinks` 数据，可打开 / 移除）；
 *   · 应用入口（工具箱 / 便签 / 密码 / 桌面整理 / 设置），点一下直接在桌面抽屉打开。
 * 全程不弹窗口。要加更多系统入口，展开「全部系统入口」即点即跑。
 */
export interface DesktopQuickActionsProps {
  onClose: () => void;
  /** 在桌面抽屉里打开一个模块 / 命令（'module:<id>' 或命令 id） */
  onLaunch: (target: string) => void;
  /** 打开一条用户快捷方式（与 Dock 同逻辑） */
  onOpenLink: (link: QuickLink) => void;
  /** 从快捷方式里移除一条 */
  onRemoveLink: (id: string) => void;
}

/** 桌面「应用入口」卡片（点一下在桌面抽屉打开，不弹窗口） */
const APP_SHORTCUTS: ReadonlyArray<{
  target: string;
  name: string;
  description: string;
  icon: LucideIcon;
}> = [
  { target: 'module:toolbox', name: '工具箱', description: '全部本地小工具', icon: Wrench },
  { target: 'module:notes', name: '便签', description: '桌面便签', icon: StickyNote },
  { target: 'module:vault', name: '密码存储器', description: 'AES-256-GCM 本地密码库', icon: ShieldCheck },
  { target: 'module:desktop-organizer', name: '桌面整理', description: '一键整理 · 布局备份', icon: AppWindow },
];

export function DesktopQuickActions({
  onClose,
  onLaunch,
  onOpenLink,
  onRemoveLink,
}: DesktopQuickActionsProps): React.JSX.Element {
  const [actions, setActions] = React.useState<SysAction[]>([]);
  const [links, setLinks] = React.useState<QuickLink[]>(() => loadQuickLinks());
  const [runningId, setRunningId] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [showAll, setShowAll] = React.useState(false);

  const pinnedIds = useAppStore((state) => state.settings.quickActionIds);

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

  // Esc 关闭
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const byId = React.useMemo(() => new Map(actions.map((action) => [action.id, action])), [actions]);
  const pinned = React.useMemo(
    () =>
      pinnedIds
        .map((id) => byId.get(id))
        .filter((action): action is SysAction => action !== undefined),
    [pinnedIds, byId],
  );

  const grouped = React.useMemo(() => {
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
    return (
      <button
        type="button"
        disabled={running}
        title={`${action.name} — ${action.description}`}
        onClick={() => run(action)}
        className="group relative flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-left transition hover:border-sky-400/40 hover:bg-white/10"
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-neutral-200" />
        <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-100">{action.name}</span>
        {action.elevated ? (
          <span className="shrink-0 rounded bg-amber-400/20 px-1 text-[8px] text-amber-200">管</span>
        ) : null}
        {running ? <Loader2 className="h-3 w-3 shrink-0 animate-spin text-sky-300" /> : null}
      </button>
    );
  };

  return (
    <div
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      style={{ pointerEvents: 'auto' }}
      className="absolute bottom-24 right-5 z-40 flex max-h-[72vh] w-[380px] flex-col overflow-hidden rounded-2xl bg-neutral-900/93 text-neutral-100 shadow-2xl ring-1 ring-white/15 backdrop-blur-2xl"
    >
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <ZapIcon />
        <span className="text-xs font-medium">快捷操作</span>
        <span className="text-[10px] text-neutral-400">桌面版快捷导航</span>
        <button
          type="button"
          onClick={onClose}
          title="关闭（Esc）"
          className="ml-auto rounded-md p-1 text-neutral-400 transition hover:bg-white/10 hover:text-neutral-100"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

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
                  <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-100">{item.name}</span>
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => openSettings()}
              title="快捷键 · 主题 · 开机启动 · 备份还原"
              className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-left transition hover:border-sky-400/40 hover:bg-white/10"
            >
              <Settings className="h-3.5 w-3.5 shrink-0 text-neutral-200" />
              <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-100">设置</span>
            </button>
          </div>
        </Section>

        {/* —— 我的快捷方式（与 Dock 同源） —— */}
        <Section title={`我的快捷方式（${links.length}）`}>
          {links.length === 0 ? (
            <p className="px-1 py-1 text-[10px] leading-relaxed text-neutral-500">
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
                    className="min-w-0 flex-1 truncate text-left text-[11px] text-neutral-100"
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
            <p className="px-1 py-1 text-[10px] leading-relaxed text-neutral-500">
              还没有钉常用入口。展开下面的「全部系统入口」即点即跑；要常驻就到工作台里勾选。
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
                {grouped.map(([groupName, list]) => (
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
            <p className="px-1 py-1 text-[10px] leading-relaxed text-neutral-500">
              网络 / 服务 / 证书 / hosts 编辑 / 终端 / 控制面板… 共 {actions.length} 个系统面板，展开后点一下即开。
            </p>
          )}
        </Section>
      </div>
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
        <span className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">{title}</span>
        <span className="h-px flex-1 bg-white/5" />
        {action}
      </div>
      {children}
    </div>
  );
}

/** 「快捷操作」标题前的闪电图标 */
function ZapIcon(): React.JSX.Element {
  return <Zap className="h-3.5 w-3.5 text-sky-300" />;
}
