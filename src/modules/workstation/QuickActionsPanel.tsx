import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AppWindow,
  Check,
  Loader2,
  RotateCcw,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { toast } from '@/components/ui/toast';
import { ipc } from '@/lib/ipc';
import { isTauri } from '@/platform/detect';
import { DEFAULT_QUICK_ACTION_IDS } from '@/core/settings';
import { useAppStore } from '@/stores/useAppStore';
import { cn } from '@/lib/utils';
import type { SysAction } from '@/types/sys';

/**
 * 工作台「快捷入口」面板 —— 系统级动作白名单。
 *
 * 取代原先的「网址收藏」（浏览器已足够强，收藏夹在桌面工具里没有价值），
 * 改为真正高频、且**浏览器做不到**的系统动作用。
 *
 * # V19 改版（用户反馈：「很多功能没有啊，就常用的即可 / 让用户可以自己选择添加更好」）
 *
 * 白名单表一共 30+ 个系统面板，全铺出来只会变成一面墙，常用的反而找不着。于是：
 *   - **默认只放常用项**（`DEFAULT_QUICK_ACTION_IDS`：管理员终端、网络三件套、
 *     任务管理器、服务、临时目录），一眼就是自己天天要点的；
 *   - **「自定义」可自由勾选**，选择存进 `settings.quickActionIds`，重启后保持；
 *   - 勾了但服务端已不存在的 id 会被静默忽略，不做破坏性清理（跨版本升级不炸）。
 *
 * 安全边界：前端只把动作 **id** 传给后端，可执行目标与参数由 Rust 侧白名单表硬编码
 * （`src-tauri/src/commands/sys.rs`），因此不存在「任意命令执行」的注入面。
 */

/** 分组图标（未知分组回退通用图标） */
const GROUP_ICONS: Record<string, LucideIcon> = {
  终端: Terminal,
  网络: ShieldCheck,
  系统管理: Wrench,
};

export function QuickActionsPanel(): React.JSX.Element {
  const [actions, setActions] = useState<SysAction[]>([]);
  const [loading, setLoading] = useState(true);
  /** 展示用提示文案（环境受限 = 提示态，真失败 = 错误态） */
  const [notice, setNotice] = useState<{ text: string; kind: 'info' | 'error' } | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  /** 自定义模式：展开全量清单让用户勾选 */
  const [customizing, setCustomizing] = useState(false);

  const selectedIds = useAppStore((state) => state.settings.quickActionIds);
  const updateSettings = useAppStore((state) => state.updateSettings);

  const load = useCallback((): void => {
    // 浏览器预览 / `npm run dev` 下没有 Tauri IPC，直接给一句人话，别把
    // 「Cannot read properties of undefined」这类内部报错糊到界面上。
    if (!isTauri()) {
      setLoading(false);
      setNotice({
        text: '系统快捷入口需要在 Handy 桌面应用内运行（当前为浏览器预览环境）',
        kind: 'info',
      });
      return;
    }
    setLoading(true);
    void ipc
      .sysActionList()
      .then((list) => {
        setActions(list);
        setNotice(null);
      })
      .catch((err: unknown) => {
        setNotice({
          text: `加载失败：${err instanceof Error ? err.message : String(err)}`,
          kind: 'error',
        });
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** 全量清单按分组归拢（自定义面板按组渲染） */
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

  /** 当前展示的常用项：按用户选择顺序，忽略已不存在的 id */
  const pinned = useMemo(() => {
    const byId = new Map(actions.map((action) => [action.id, action]));
    return selectedIds
      .map((id) => byId.get(id))
      .filter((action): action is SysAction => action !== undefined);
  }, [actions, selectedIds]);

  /** 勾选 / 取消勾选一个动作（选择即保存，无需「确定」按钮） */
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

  const restoreDefault = (): void => {
    void updateSettings({ quickActionIds: [...DEFAULT_QUICK_ACTION_IDS] })
      .then(() => toast.success('已恢复默认快捷入口'))
      .catch((error: unknown) => {
        toast.error('恢复默认失败', {
          description: error instanceof Error ? error.message : String(error),
        });
      });
  };

  const run = (action: SysAction): void => {
    setRunningId(action.id);
    void ipc
      .sysActionRun(action.id)
      .then(() => {
        toast.success(
          action.elevated ? `已请求管理员权限：${action.name}` : `已打开：${action.name}`,
          { description: action.elevated ? '请在系统弹窗中点「是」以继续' : undefined },
        );
      })
      .catch((err: unknown) => {
        toast.error(`执行失败：${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => setRunningId(null));
  };

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-panel">
      <header className="flex items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-violet-700">
          <AppWindow className="h-4 w-4" />
        </span>
        <h3 className="text-sm font-semibold text-foreground">快捷入口</h3>
        <span className="text-xs text-muted-foreground">
          直达要点好几层才到的系统面板
        </span>
        <div className="ml-auto flex items-center gap-1">
          {customizing ? (
            <button
              type="button"
              onClick={restoreDefault}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-accent-foreground"
            >
              <RotateCcw className="h-3 w-3" />
              恢复默认
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setCustomizing((prev) => !prev)}
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition',
              customizing
                ? 'bg-brand-muted font-medium text-brand'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            <Settings2 className="h-3 w-3" />
            {customizing ? '完成' : '自定义'}
          </button>
        </div>
      </header>

      {notice !== null ? (
        <div
          className={cn(
            'flex items-start gap-2 rounded-lg border px-3 py-2 text-xs',
            notice.kind === 'info'
              ? 'border-amber-300/60 bg-amber-50 text-amber-800'
              : 'border-destructive/30 bg-destructive/5 text-destructive',
          )}
        >
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">{notice.text}</span>
        </div>
      ) : null}

      {loading ? (
        <p className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          加载动作清单…
        </p>
      ) : customizing ? (
        /* —— 自定义：全量清单按组勾选 —— */
        <div className="scrollbar-thin max-h-[320px] space-y-3 overflow-y-auto">
          {grouped.map(([groupName, list]) => {
            const Icon = GROUP_ICONS[groupName] ?? Wrench;
            return (
              <div key={groupName}>
                <p className="mb-1.5 inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                  <Icon className="h-3 w-3" />
                  {groupName}
                </p>
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
                  {list.map((action) => {
                    const on = selectedIds.includes(action.id);
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
                            'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border transition',
                            on ? 'border-brand bg-brand text-white' : 'border-muted-foreground/40',
                          )}
                        >
                          {on ? <Check className="h-2.5 w-2.5" /> : null}
                        </span>
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
            );
          })}
        </div>
      ) : pinned.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border py-6 text-center">
          <p className="text-sm text-muted-foreground">还没选快捷入口</p>
          <button
            type="button"
            onClick={() => setCustomizing(true)}
            className="rounded-md bg-brand px-3 py-1 text-xs text-white transition hover:opacity-90"
          >
            去挑几个
          </button>
        </div>
      ) : (
        /* —— 常用：只铺用户选中的那几项 —— */
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {pinned.map((action) => {
            const Icon = GROUP_ICONS[action.group] ?? Wrench;
            const running = runningId === action.id;
            return (
              <button
                key={action.id}
                type="button"
                onClick={() => run(action)}
                disabled={running}
                title={action.description}
                className={cn(
                  'group flex min-w-0 items-start gap-2 rounded-xl border border-border px-2.5 py-2 text-left transition',
                  'hover:border-brand/40 hover:bg-brand-muted/50 disabled:opacity-60',
                )}
              >
                <span className="mt-0.5 shrink-0 text-muted-foreground transition group-hover:text-brand">
                  {running ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Icon className="h-3.5 w-3.5" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1">
                    <span className="truncate text-xs font-medium text-foreground">
                      {action.name}
                    </span>
                    {action.elevated ? (
                      <span className="shrink-0 rounded bg-amber-100 px-1 text-[9px] text-amber-800">
                        管理员
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                    {action.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default QuickActionsPanel;
