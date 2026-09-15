import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AppWindow,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { toast } from '@/components/ui/toast';
import { ipc } from '@/lib/ipc';
import { isTauri } from '@/platform/detect';
import { cn } from '@/lib/utils';
import type { SysAction } from '@/types/sys';

/**
 * 工作台「快捷入口」面板 —— 系统级动作白名单。
 *
 * 取代原先的「网址收藏」（浏览器已足够强，收藏夹在桌面工具里没有价值），
 * 改为真正高频、且**浏览器做不到**的系统动作用：
 * 管理员终端、网络 / DNS / hosts、任务管理器、服务、设备管理器、系统设置页…
 *
 * 安全边界：前端只把动作 **id** 传给后端，可执行目标与参数由 Rust 侧白名单表硬编码
 * （`src-tauri/src/commands/sys.rs`），因此不存在「任意命令执行」的注入面。
 * 需要提权的动作会经 UAC 弹窗确认，标题上带「管理员」角标。
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
  const [group, setGroup] = useState<string>('全部');
  const [runningId, setRunningId] = useState<string | null>(null);

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

  const groups = useMemo(() => {
    const seen: string[] = [];
    for (const action of actions) {
      if (!seen.includes(action.group)) {
        seen.push(action.group);
      }
    }
    return seen;
  }, [actions]);

  const visible = useMemo(
    () => (group === '全部' ? actions : actions.filter((action) => action.group === group)),
    [actions, group],
  );

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
    <section className="flex max-h-[480px] min-h-[260px] flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-panel">
      <header className="flex items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-violet-700">
          <AppWindow className="h-4 w-4" />
        </span>
        <h3 className="text-sm font-semibold text-foreground">快捷入口</h3>
        <span className="text-xs text-muted-foreground">系统动作 · 只传动作 id</span>
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

      {groups.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          {['全部', ...groups].map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setGroup(item)}
              className={cn(
                'rounded-md px-2 py-1 text-xs transition',
                group === item
                  ? 'bg-brand-muted font-medium text-brand'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )}
            >
              {item}
            </button>
          ))}
        </div>
      ) : null}

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <p className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            加载动作清单…
          </p>
        ) : visible.length === 0 ? (
          // 已有提示文案时不再叠加「没有可用动作」，避免同一件事说两遍
          notice === null ? (
            <p className="py-8 text-center text-sm text-muted-foreground">没有可用动作</p>
          ) : null
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {visible.map((action) => {
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
                    'group flex min-w-0 items-start gap-2 rounded-lg border border-border px-2.5 py-2 text-left transition',
                    'hover:border-brand/40 hover:bg-brand-muted/50 disabled:opacity-60',
                  )}
                >
                  <span className="mt-0.5 shrink-0 text-muted-foreground transition group-hover:text-brand">
                    {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
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
      </div>
    </section>
  );
}

export default QuickActionsPanel;
