import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AppWindow,
  BadgeCheck,
  BatteryCharging,
  Bluetooth,
  Cable,
  CalendarClock,
  Check,
  ClipboardList,
  Clock,
  Cpu,
  Database,
  DownloadCloud,
  Eraser,
  FileCode,
  FolderOpen,
  FolderTree,
  Gauge,
  Globe,
  HardDrive,
  HardDriveDownload,
  History,
  Info,
  LayoutGrid,
  LineChart,
  Loader2,
  Monitor,
  MonitorSmartphone,
  Network,
  Package,
  Plug,
  Printer,
  RefreshCw,
  Rocket,
  RotateCcw,
  ScrollText,
  Settings,
  Settings2,
  Shield,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  SquareTerminal,
  Terminal,
  Trash2,
  UserCog,
  Users,
  Variable,
  Volume2,
  Wifi,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { toast } from '@/components/ui/toast';
import { ipc } from '@/lib/ipc';
import { isTauri } from '@/platform/detect';
import { openModule, openSettings } from '@/core/navigation';
import { DEFAULT_QUICK_ACTION_IDS } from '@/core/settings';
import { useAppStore } from '@/stores/useAppStore';
import { cn } from '@/lib/utils';
import type { SysAction } from '@/types/sys';

/**
 * 工作台「快捷入口」竖排图标栏。
 *
 * # 用户反馈（V20）
 *
 * 「快捷入口应该要放在一个随手可以点击到的地方这样才叫快捷，你现在这个要拉到最下面才能点击；
 *   最好对应 window 的功能图标，直接图标贴在工作台的左边或者右边，竖排大图标，
 *   鼠标上去显示说明。」
 *
 * 于是从「底部一整块卡片」改成**右侧竖排图标栏**：
 *   - 图标 **44×44**、单手可点，鼠标悬停浮出「名称 + 一句话说明」；
 *   - 分两段：**应用内跳转**（工作台 / 工具箱 / 密码库 / 桌面整理）+ **系统面板**（用户自选）；
 *   - 每个系统动作都有对应的 lucide 图标（终端 / 网卡 / 服务 / 证书 / 打印机……），
 *     不再是清一色的扳手；
 *   - 「自定义」从右侧滑出全量清单，勾选即保存（`settings.quickActionIds`）。
 *
 * 安全边界不变：前端只传动作 **id**，可执行目标与参数硬编码在 Rust 白名单表
 * （`src-tauri/src/commands/sys.rs`），不存在命令注入面。
 */

/** 动作 id → 图标（未列出的回退扳手） */
const ACTION_ICONS: Record<string, LucideIcon> = {
  'powershell-admin': ShieldCheck,
  'cmd-admin': Terminal,
  powershell: SquareTerminal,
  ipconfig: Network,
  ncpa: Cable,
  'dns-flush': RefreshCw,
  'hosts-edit': FileCode,
  'hosts-folder': FolderOpen,
  'network-settings': Wifi,
  'wifi-settings': Wifi,
  'proxy-settings': Globe,
  'shared-folders': FolderTree,
  taskmgr: Activity,
  services: Settings2,
  'device-mgr': Cpu,
  'disk-mgr': HardDrive,
  'event-viewer': ScrollText,
  firewall: Shield,
  registry: Database,
  'system-info': Info,
  perfmon: LineChart,
  'env-vars': Variable,
  'system-props': SlidersHorizontal,
  programs: Package,
  'windows-update': DownloadCloud,
  'startup-apps': Rocket,
  'display-settings': Monitor,
  'storage-settings': HardDrive,
  power: BatteryCharging,
  'date-time': Clock,
  sound: Volume2,
  'control-panel': LayoutGrid,
  'temp-folder': Trash2,
  'task-scheduler': CalendarClock,
  'resource-monitor': Gauge,
  'system-config': Wrench,
  'disk-cleanup': Eraser,
  defrag: HardDriveDownload,
  'user-accounts': UserCog,
  'local-users': Users,
  'cert-manager': BadgeCheck,
  odbc: Plug,
  'system-restore': History,
  'printer-settings': Printer,
  'bluetooth-settings': Bluetooth,
  'default-apps': AppWindow,
  'clipboard-settings': ClipboardList,
  'remote-desktop': MonitorSmartphone,
  defender: ShieldAlert,
};

/** 应用内跳转（走模块视图，跨窗口状态由 store 驱动） */
const APP_SHORTCUTS: ReadonlyArray<{ moduleId: string; name: string; description: string; icon: LucideIcon }> = [
  { moduleId: 'notes', name: '工作台', description: '日历 · 任务 · 便签 · 快捷入口', icon: LayoutGrid },
  { moduleId: 'toolbox', name: '工具箱', description: '23 个本地小工具（对比 / Cron / 正则 / 编码…）', icon: Wrench },
  { moduleId: 'vault', name: '密码存储器', description: 'AES-256-GCM 加密的本地密码库', icon: ShieldCheck },
  { moduleId: 'desktop-organizer', name: '桌面整理', description: '一键整理桌面 · 布局备份还原', icon: AppWindow },
];

/** 悬停浮出的说明气泡 */
function RailTip({ name, description, elevated }: { name: string; description: string; elevated?: boolean }): React.JSX.Element {
  return (
    <span className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 hidden w-56 -translate-y-1/2 rounded-lg bg-neutral-900/95 px-2.5 py-1.5 text-left shadow-xl ring-1 ring-white/10 group-hover:block">
      <span className="flex items-center gap-1.5">
        <span className="text-[11px] font-medium text-neutral-50">{name}</span>
        {elevated === true ? (
          <span className="rounded bg-amber-400/20 px-1 text-[9px] text-amber-200">管理员</span>
        ) : null}
      </span>
      <span className="mt-0.5 block text-[10px] leading-snug text-neutral-300">{description}</span>
    </span>
  );
}

/** 栏内单个图标按钮 */
function RailButton({
  icon: Icon,
  name,
  description,
  elevated,
  running,
  active,
  onClick,
}: {
  icon: LucideIcon;
  name: string;
  description: string;
  elevated?: boolean;
  running?: boolean;
  active?: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={running}
      title={`${name} — ${description}`}
      className={cn(
        'group relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border transition',
        active
          ? 'border-brand/50 bg-brand-muted text-brand'
          : 'border-transparent text-muted-foreground hover:border-brand/40 hover:bg-brand-muted/60 hover:text-brand',
        running && 'opacity-60',
      )}
    >
      {running === true ? <Loader2 className="h-5 w-5 animate-spin" /> : <Icon className="h-5 w-5" />}
      {elevated === true ? (
        <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-amber-400" />
      ) : null}
      <RailTip name={name} description={description} elevated={elevated} />
    </button>
  );
}

export function QuickActionsRail(): React.JSX.Element {
  const [actions, setActions] = useState<SysAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [customizing, setCustomizing] = useState(false);

  const selectedIds = useAppStore((state) => state.settings.quickActionIds);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const view = useAppStore((state) => state.view);

  const load = useCallback((): void => {
    if (!isTauri()) {
      setLoading(false);
      setNotice('系统快捷入口需在 Handy 桌面应用内运行');
      return;
    }
    setLoading(true);
    void ipc
      .sysActionList()
      .then((list) => {
        setActions(list);
        setNotice(null);
      })
      .catch((error: unknown) => {
        setNotice(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const grouped = useMemo(() => {
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

  const pinned = useMemo(() => {
    const byId = new Map(actions.map((action) => [action.id, action]));
    return selectedIds
      .map((id) => byId.get(id))
      .filter((action): action is SysAction => action !== undefined);
  }, [actions, selectedIds]);

  const toggle = (id: string): void => {
    const next = selectedIds.includes(id)
      ? selectedIds.filter((item) => item !== id)
      : [...selectedIds, id];
    void updateSettings({ quickActionIds: next }).catch((error: unknown) => {
      toast.error('保存快捷入口设置失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const run = (action: SysAction): void => {
    setRunningId(action.id);
    void ipc
      .sysActionRun(action.id)
      .then(() => {
        toast.success(action.elevated ? `已请求管理员权限：${action.name}` : `已打开：${action.name}`, {
          description: action.elevated ? '请在系统弹窗中点「是」以继续' : undefined,
        });
      })
      .catch((error: unknown) => {
        toast.error(`执行失败：${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => setRunningId(null));
  };

  const isModuleActive = (moduleId: string): boolean =>
    view.kind === 'module' && view.moduleId === moduleId;

  return (
    <aside className="relative flex w-[68px] shrink-0 flex-col items-center gap-1.5 self-start rounded-2xl border border-border bg-card py-3 shadow-panel">
      {/* —— 应用内跳转 —— */}
      {APP_SHORTCUTS.map((item) => (
        <RailButton
          key={item.moduleId}
          icon={item.icon}
          name={item.name}
          description={item.description}
          active={isModuleActive(item.moduleId)}
          onClick={() => openModule(item.moduleId)}
        />
      ))}

      <span className="my-1 h-px w-8 shrink-0 bg-border" />

      {/* —— 系统面板（用户自选） —— */}
      {loading ? (
        <span className="flex h-11 w-11 items-center justify-center text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </span>
      ) : (
        pinned.map((action) => (
          <RailButton
            key={action.id}
            icon={ACTION_ICONS[action.id] ?? Wrench}
            name={action.name}
            description={action.description}
            elevated={action.elevated}
            running={runningId === action.id}
            onClick={() => run(action)}
          />
        ))
      )}

      {pinned.length === 0 && !loading ? (
        <button
          type="button"
          onClick={() => setCustomizing(true)}
          title="还没选快捷入口，点这里挑几个"
          className="group relative flex h-11 w-11 items-center justify-center rounded-xl border border-dashed border-border text-muted-foreground transition hover:border-brand/40 hover:text-brand"
        >
          <Wrench className="h-5 w-5" />
          <RailTip name="还没有快捷入口" description="点这里从 50+ 个系统面板里挑常用的（终端 / 网络 / 服务 / 证书…）" />
        </button>
      ) : null}

      {notice !== null ? (
        <span
          title={notice}
          className="mt-1 flex h-6 w-11 items-center justify-center rounded-md bg-amber-100 text-[9px] leading-tight text-amber-800"
        >
          需桌面版
        </span>
      ) : null}

      <span className="my-1 h-px w-8 shrink-0 bg-border" />

      <RailButton
        icon={Settings}
        name="设置中心"
        description="快捷键 · 主题 · 开机启动 · 备份还原"
        active={view.kind === 'settings'}
        onClick={() => openSettings()}
      />

      {/* —— 自定义（底部固定） —— */}
      <button
        type="button"
        onClick={() => setCustomizing((prev) => !prev)}
        title="自定义快捷入口"
        className={cn(
          'group relative mt-auto flex h-11 w-11 items-center justify-center rounded-xl border transition',
          customizing
            ? 'border-brand/50 bg-brand-muted text-brand'
            : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        <Settings2 className="h-5 w-5" />
        <RailTip name="自定义快捷入口" description="从全量系统面板里勾选常用项，选择立即保存" />
      </button>

      {/* —— 自定义面板（从栏右侧滑出） —— */}
      {customizing ? (
        <div className="absolute right-full top-0 z-40 mr-2 w-[420px] overflow-hidden rounded-2xl border border-border bg-card shadow-xl">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <span className="text-sm font-medium text-foreground">自定义快捷入口</span>
            <span className="text-[11px] text-muted-foreground">
              已选 {pinned.length} 项 · 勾选即保存
            </span>
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  void updateSettings({ quickActionIds: [...DEFAULT_QUICK_ACTION_IDS] })
                    .then(() => toast.success('已恢复默认快捷入口'))
                    .catch(() => undefined);
                }}
                className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
              >
                <RotateCcw className="h-3 w-3" />
                恢复默认
              </button>
              <button
                type="button"
                onClick={() => setCustomizing(false)}
                className="rounded-md bg-brand px-2 py-0.5 text-[11px] text-white transition hover:opacity-90"
              >
                完成
              </button>
            </div>
          </div>
          <div className="scrollbar-thin max-h-[440px] space-y-3 overflow-y-auto p-3">
            {grouped.map(([groupName, list]) => (
              <div key={groupName}>
                <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">{groupName}</p>
                <div className="grid grid-cols-2 gap-1.5">
                  {list.map((action) => {
                    const on = selectedIds.includes(action.id);
                    const Icon = ACTION_ICONS[action.id] ?? Wrench;
                    return (
                      <button
                        key={action.id}
                        type="button"
                        onClick={() => toggle(action.id)}
                        title={action.description}
                        className={cn(
                          'flex min-w-0 items-center gap-1.5 rounded-lg border px-2 py-1.5 text-left transition',
                          on
                            ? 'border-brand/50 bg-brand-muted/60'
                            : 'border-border hover:border-brand/30 hover:bg-accent/50',
                        )}
                      >
                        <span
                          className={cn(
                            'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition',
                            on ? 'border-brand bg-brand text-white' : 'border-muted-foreground/40',
                          )}
                        >
                          {on ? <Check className="h-3 w-3" /> : null}
                        </span>
                        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">
                          {action.name}
                        </span>
                        {action.elevated ? (
                          <span className="shrink-0 rounded bg-amber-100 px-1 text-[9px] text-amber-800">
                            管理员
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </aside>
  );
}

export default QuickActionsRail;
