import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  FolderOpen,
  ExternalLink,
  History,
  Loader2,
  Square,
  Tags,
  Undo2,
  X,
  CheckSquare,
  FolderInput,
} from 'lucide-react';
import type { OrganizerApplyReport, OrganizerPlan, OrganizerRules } from '@/types/organizer';
import {
  PLAN_STATUS_LABELS,
  applyPlan,
  listPlans,
  planStatus,
  previewPlan,
  scanDesktop,
  undoPlan,
  updatePlanItems,
} from '@/core/data/organizerService';
import { ipc } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast';

/**
 * 桌面归类整理视图（V12；V25 成为模块首屏）。
 *
 * 流程：规则选择（by-type / by-date）→「生成预览」（只算不搬）→ 分组预览清单
 * （可勾选排除，回写计划）→「应用」（**二次确认弹层**，列明将移动 N 项及目标目录）
 * → 结果摘要（成功/失败）→「一键撤销」→ 历史计划列表（可撤销 applied 且未撤销的计划）。
 *
 * # V25：这是「真·操作系统桌面整理」
 *
 * 用户反馈「桌面整理还是在自己的框里面玩，没有真正操作系统桌面」。查证结果是：
 * **这套能力其实早就做到位了**（Rust `organizer.rs`：`dirs::desktop_dir()` 认
 * OneDrive 重定向后的真实桌面、按类型 / 日期分组、同名自动改名不覆盖、
 * 跳过隐藏与系统文件及快捷方式、计划落库、可逆序撤销）—— 问题出在**入口**：
 * 侧边栏模块首屏指向的是「桌面格子」（V33 前只登记引用、一个文件都不动），
 * 用户自然觉得在自娱自乐。
 *
 * 于是本视图被提到模块首屏，并在最上方常驻一行**作用目录**（就是真实桌面路径）
 * 与「打开桌面 / 打开整理目录」两个按钮 —— 让「它到底动了谁」无需猜测。
 *
 * 安全边界：
 *   - 预览/应用/撤销全部经 Rust（安全策略与冲突处理在 Rust 侧）；
 *   - apply 前置二次确认由本视图保证；单条失败不中断，失败明细在摘要中展示；
 *   - 本视图只操作桌面整理本身，绝不自动触发任何移动（全部由用户点击驱动）。
 */

/** 字节数展示 */
function formatSize(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 时间展示（MM-DD HH:mm） */
function formatTime(ms: number): string {
  const d = new Date(ms);
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 规则模式中文名 */
const MODE_LABELS: Record<OrganizerRules['mode'], string> = {
  'by-type': '按类型',
  'by-date': '按日期',
};

/** 目标路径末段展示（分组/文件名） */
function tailOf(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

export interface OrganizerViewProps {
  /** 兼容 CommandProps / ModuleProps（未使用） */
  initialInput?: string;
  source?: string;
  windowKind?: string;
}

/** 桌面整理视图（主面板模块内页 / 命令视图复用）。 */
export default function OrganizerView(_props: OrganizerViewProps = {}): React.JSX.Element {
  const [mode, setMode] = useState<OrganizerRules['mode']>('by-type');
  const [includeFolders, setIncludeFolders] = useState(false);
  const [plan, setPlan] = useState<OrganizerPlan | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'preview' | 'apply' | 'undo' | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [report, setReport] = useState<OrganizerApplyReport | null>(null);
  const [lastApplied, setLastApplied] = useState<OrganizerPlan | null>(null);
  const [plans, setPlans] = useState<OrganizerPlan[]>([]);
  const [loadedPlans, setLoadedPlans] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 真实桌面目录（Rust `dirs::desktop_dir()` 解析结果，含 OneDrive 重定向） */
  const [rootDir, setRootDir] = useState<string | null>(null);
  const [rootError, setRootError] = useState<string | null>(null);
  /** 桌面上当前可整理的条目数（证明「读的是真实桌面」） */
  const [desktopCount, setDesktopCount] = useState<number | null>(null);

  const refreshPlans = useCallback(async (): Promise<void> => {
    try {
      setPlans(await listPlans());
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadedPlans(true);
    }
  }, []);

  useEffect(() => {
    void refreshPlans();
  }, [refreshPlans]);

  // 定位真实桌面目录：只读扫描，用于把「作用对象」摆在界面上（不触发任何移动）
  useEffect(() => {
    let alive = true;
    void scanDesktop()
      .then((result) => {
        if (!alive) {
          return;
        }
        setRootDir(result.dir);
        setDesktopCount(result.items.length);
        setRootError(null);
      })
      .catch((err: unknown) => {
        if (alive) {
          setRootError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  /** 用系统默认程序打开目录（走 Rust `grid_open_path`，不受 shell 作用域限制） */
  const openDir = useCallback((dir: string): void => {
    void ipc.gridOpenPath(dir).catch((err: unknown) => {
      toast.error('打开目录失败', {
        description: err instanceof Error ? err.message : String(err),
      });
    });
  }, []);

  /** 整理目标根目录：已生成计划时用计划锁定的那个，否则按约定推出来 */
  const targetDir = useMemo<string | null>(() => {
    if (plan !== null) {
      return plan.payload.targetDir;
    }
    if (rootDir === null) {
      return null;
    }
    const sep = rootDir.includes('\\') ? '\\' : '/';
    return `${rootDir.replace(/[\\/]+$/, '')}${sep}Handy整理`;
  }, [plan, rootDir]);

  /** 生成预览（只算不搬；计划已落库 applied=0） */
  const handlePreview = async (): Promise<void> => {
    setBusy('preview');
    setError(null);
    setReport(null);
    setLastApplied(null);
    try {
      const p = await previewPlan({ mode, includeFolders });
      setPlan(p);
      setExcluded(new Set());
      await refreshPlans();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  /** 分组预览（排除项不渲染计数，但仍保留在 plan 中，应用时回写过滤） */
  const groups = useMemo(() => {
    if (!plan) {
      return [];
    }
    const map = new Map<string, typeof plan.payload.items>();
    for (const item of plan.payload.items) {
      if (excluded.has(item.source)) {
        continue;
      }
      const list = map.get(item.kind) ?? [];
      list.push(item);
      map.set(item.kind, list);
    }
    return [...map.entries()].map(([kind, items]) => ({ kind, items }));
  }, [plan, excluded]);

  const checkedCount = plan ? plan.payload.items.length - excluded.size : 0;

  /** 切换单条排除 */
  const toggleItem = (source: string): void => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(source)) {
        next.delete(source);
      } else {
        next.add(source);
      }
      return next;
    });
  };

  /** 应用（已过二次确认）：回写排除结果 → 执行 → 摘要 */
  const handleApply = async (): Promise<void> => {
    if (!plan) {
      return;
    }
    setConfirmOpen(false);
    setBusy('apply');
    setError(null);
    try {
      const checkedItems = plan.payload.items.filter((i) => !excluded.has(i.source));
      let current = plan;
      if (checkedItems.length !== plan.payload.items.length) {
        current = await updatePlanItems(plan.id, checkedItems);
      }
      const rep = await applyPlan(current.id);
      setReport(rep);
      setLastApplied(current);
      setPlan(null);
      setExcluded(new Set());
      await refreshPlans();
      if (rep.failed.length === 0) {
        toast.success(`已移动 ${rep.moved} 项到 ${tailOf(current.payload.targetDir)}`);
      } else {
        toast.error(`已移动 ${rep.moved} 项，${rep.failed.length} 项失败（详见摘要）`);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  /** 撤销（历史计划与刚应用的计划共用） */
  const handleUndo = async (planId: string): Promise<void> => {
    setBusy('undo');
    setError(null);
    try {
      const rep = await undoPlan(planId);
      await refreshPlans();
      if (lastApplied?.id === planId) {
        setLastApplied(null);
        setReport(null);
      }
      if (rep.skipped.length === 0) {
        toast.success(`已撤销：恢复 ${rep.restored} 项到原位置`);
      } else {
        toast.error(`已恢复 ${rep.restored} 项，${rep.skipped.length} 项跳过（详见历史计划）`);
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* 作用目录（V25）：把「动的是真实操作系统桌面」摆在最上面，不用猜 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-4 py-2">
        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-brand" />
        <span className="shrink-0 text-[11px] text-muted-foreground">作用目录</span>
        <code
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground"
          title={rootDir ?? undefined}
        >
          {rootDir ?? (rootError !== null ? `读取失败：${rootError}` : '正在定位桌面目录…')}
        </code>
        {desktopCount !== null ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            扫描到 {desktopCount} 个条目
          </span>
        ) : null}
        {rootDir !== null ? (
          <button
            type="button"
            onClick={() => openDir(rootDir)}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3" />
            打开桌面
          </button>
        ) : null}
        {targetDir !== null ? (
          <button
            type="button"
            onClick={() => openDir(targetDir)}
            title="整理后会移动到这里（不存在时由程序创建）"
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3" />
            打开整理目录
          </button>
        ) : null}
      </div>

      {/* 工具栏：规则选择 + 生成预览 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-1">
          {(['by-type', 'by-date'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                'inline-flex h-8 items-center gap-1 rounded-md px-3 text-xs transition',
                mode === m
                  ? 'bg-brand text-white'
                  : 'border text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {m === 'by-type' ? <Tags className="h-3.5 w-3.5" /> : <CalendarDays className="h-3.5 w-3.5" />}
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>
        {mode === 'by-date' && (
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={includeFolders}
              onChange={(event) => setIncludeFolders(event.target.checked)}
              className="h-3.5 w-3.5 accent-brand"
            />
            整理文件夹
          </label>
        )}
        <button
          type="button"
          onClick={() => void handlePreview()}
          disabled={busy !== null}
          className="ml-auto inline-flex h-8 shrink-0 items-center gap-1 rounded-md bg-brand px-3 text-xs font-medium text-white transition hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === 'preview' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderInput className="h-3.5 w-3.5" />}
          生成预览
        </button>
      </div>

      {/* 错误态 */}
      {error && (
        <div className="mx-4 mb-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 scrollbar-thin overflow-auto px-4 pb-4">
        {/* 应用结果摘要 */}
        {report && (
          <div className="mb-3 rounded-lg border border-border bg-muted/30 p-3">
            <div className="flex items-center gap-2">
              <FolderOpen className="h-4 w-4 text-brand" />
              <p className="flex-1 text-sm font-medium text-foreground">
                已移动 {report.moved} 项
                {lastApplied && (
                  <span className="ml-1 font-normal text-muted-foreground">
                    → {lastApplied.payload.targetDir}
                  </span>
                )}
              </p>
              {lastApplied && planStatus(lastApplied) === 'applied' && (
                <button
                  type="button"
                  onClick={() => void handleUndo(lastApplied.id)}
                  disabled={busy !== null}
                  className="inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-50"
                >
                  <Undo2 className="h-3.5 w-3.5" />
                  一键撤销
                </button>
              )}
            </div>
            {report.failed.length > 0 && (
              <div className="mt-2 flex flex-col gap-1">
                {report.failed.map((f) => (
                  <p key={`${f.source}-${f.dest}`} className="flex items-start gap-1.5 text-[11px] text-destructive">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>
                      {f.name}：{f.reason}
                    </span>
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 预览清单（分组 + 勾选排除） */}
        {plan && (
          <div className="mb-3 rounded-lg border border-border">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                预览：将移动 <span className="font-medium text-foreground">{checkedCount}</span> 项到{' '}
                <span className="font-medium text-foreground">{plan.payload.targetDir}</span>
                {excluded.size > 0 && `（已排除 ${excluded.size} 项）`}
              </p>
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                disabled={checkedCount === 0 || busy !== null}
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-brand px-3 text-xs font-medium text-white transition hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === 'apply' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderInput className="h-3.5 w-3.5" />}
                应用
              </button>
            </div>
            {groups.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                没有匹配的条目（桌面很干净，或全部被排除）
              </p>
            ) : (
              <div className="flex flex-col divide-y divide-border/60">
                {groups.map(({ kind, items }) => (
                  <div key={kind}>
                    <p className="bg-muted/40 px-3 py-1 text-[11px] font-medium text-muted-foreground">
                      {kind} · {items.length} 项
                    </p>
                    {items.map((item) => (
                      <label
                        key={item.source}
                        className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs transition hover:bg-accent/50"
                      >
                        {excluded.has(item.source) ? (
                          <Square className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <CheckSquare className="h-3.5 w-3.5 shrink-0 text-brand" />
                        )}
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={!excluded.has(item.source)}
                          onChange={() => toggleItem(item.source)}
                        />
                        <span className="min-w-0 flex-1 truncate text-foreground">{item.name}</span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">{formatSize(item.size)}</span>
                        <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                        <span className="max-w-[40%] truncate text-[10px] text-muted-foreground">
                          {kind}/{tailOf(item.dest)}
                        </span>
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 历史计划 */}
        <div>
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <History className="h-3.5 w-3.5" />
            历史计划
          </p>
          {!loadedPlans ? (
            <p className="py-3 text-center text-xs text-muted-foreground">正在加载…</p>
          ) : plans.length === 0 ? (
            <p className="py-3 text-center text-xs text-muted-foreground">还没有整理计划</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {plans.map((p) => {
                const status = planStatus(p);
                return (
                  <div
                    key={p.id}
                    className="group flex items-center gap-2 rounded-lg border border-transparent px-2.5 py-2 text-xs transition hover:border-border hover:bg-accent/50"
                  >
                    <span
                      className={cn(
                        'shrink-0 rounded px-1.5 py-0.5 text-[10px]',
                        status === 'pending'
                          ? 'bg-muted text-muted-foreground'
                          : status === 'applied'
                            ? 'bg-brand-muted text-brand'
                            : 'bg-muted text-muted-foreground line-through',
                      )}
                    >
                      {PLAN_STATUS_LABELS[status]}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {MODE_LABELS[p.payload.rules.mode] ?? p.payload.rules.mode} · {p.payload.items.length} 项
                      {p.payload.failed.length > 0 && (
                        <span className="text-destructive"> · {p.payload.failed.length} 项失败</span>
                      )}
                      {p.payload.undoSkipped.length > 0 && (
                        <span> · {p.payload.undoSkipped.length} 项未回滚</span>
                      )}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">{formatTime(p.createdAt * 1000)}</span>
                    {status === 'applied' && (
                      <button
                        type="button"
                        title="逆序回滚该计划的全部移动"
                        onClick={() => void handleUndo(p.id)}
                        disabled={busy !== null}
                        className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground group-hover:opacity-100 disabled:opacity-50"
                      >
                        <Undo2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* 二次确认弹层（应用前置确认，列明移动数量与目标目录） */}
      {confirmOpen && plan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-xl border border-border bg-background p-4 shadow-lg">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
              <p className="flex-1 text-sm font-semibold text-foreground">确认移动文件？</p>
              <button
                type="button"
                aria-label="取消"
                onClick={() => setConfirmOpen(false)}
                className="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              将把 <span className="font-medium text-foreground">{checkedCount}</span>{' '}
              个条目移动到{' '}
              <span className="break-all font-medium text-foreground">{plan.payload.targetDir}</span>
              （{MODE_LABELS[plan.payload.rules.mode]}规则）。同名文件自动改名不覆盖；隐藏/系统文件、
              快捷方式不会被移动。完成后可一键撤销。
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="h-8 rounded-md border px-3 text-xs text-muted-foreground transition hover:bg-accent"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void handleApply()}
                disabled={busy !== null}
                className="inline-flex h-8 items-center gap-1 rounded-md bg-brand px-3 text-xs font-medium text-white transition hover:bg-brand/90 disabled:opacity-50"
              >
                {busy === 'apply' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderInput className="h-3.5 w-3.5" />}
                确认移动
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
