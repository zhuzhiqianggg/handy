import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  FolderOpen,
  ExternalLink,
  History,
  LayoutGrid,
  Loader2,
  Square,
  Tags,
  Undo2,
  X,
  CheckSquare,
  FolderInput,
} from 'lucide-react';
import type { AutoArrangeReport } from '@/types/grid';
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
import { reportOperation } from '@/lib/errorSink';
import { ipc } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast';

/**
 * 桌面归类整理视图（V12；V25 成为模块首屏）。
 *
 * # V37：两种「处理方式」，默认那一种一个文件都不动
 *
 * 用户装机实测后否掉了「把桌面东西搬进一个目录」这件事——原话是「是桌面整理，
 * 不是让你把桌面上的东西都给我移动到一个目录下面去，这个完全是错误的」。
 * 于是本视图顶上多了一行**处理方式**开关：
 *
 *   | 处理方式 | 做什么 | 动文件吗 |
 *   | --- | --- | --- |
 *   | **归拢到桌面格子**（默认） | 按类型/日期分组，把条目**登记**进桌面格子 | **不动**，文件留在桌面原位 |
 *   | 移动到整理目录 | 真 `fs::rename` 进 `桌面/Handy整理/<组名>/`，可一键撤销 | 动 |
 *
 * 默认走「归拢」，是因为它才是「桌面整理」的常识含义（腾讯桌面整理就是这个行为）；
 * 「移动到整理目录」保留下来，给确实想归档的用户，但它现在**必须被显式选中**，
 * 而且按钮文案会直说「移动」，不会再有「点了整理结果文件被搬走」的意外。
 *
 * 移动模式流程（选中后才出现）：规则选择（by-type / by-date）→「生成预览」（只算不搬）
 * → 分组预览清单（可勾选排除，回写计划）→「应用」（**二次确认弹层**，列明将移动 N 项
 * 及目标目录）→ 结果摘要（成功/失败）→「一键撤销」→ 历史计划列表。
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
 *   - 本视图只操作桌面整理本身，绝不自动触发任何移动（全部由用户点击驱动）；
 *   - 「归拢」模式走的是 Rust `grid_auto_arrange`（V37 起只登记、不移动），
 *     与桌面格子管理页的「一键归类桌面」是同一个实现，不存在两套语义。
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
  /**
   * 处理方式（V37）：
   *  - `group`：归拢到桌面格子（默认）—— 只登记引用，**文件一个字节都不动**；
   *  - `move`：移动到整理目录 —— 真搬文件，可一键撤销。
   */
  const [processMode, setProcessMode] = useState<'group' | 'move'>('group');
  /** 归拢模式的结果摘要 */
  const [groupReport, setGroupReport] = useState<AutoArrangeReport | null>(null);
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

  /**
   * 归拢到桌面格子：按类型把桌面条目登记进格子，**不动任何文件**（V37 默认路径）。
   *
   * 与「桌面格子」管理页的「一键归类桌面」共用同一个 Rust 命令，所以两处行为天然一致；
   * 分类名（文件夹 / 图片 / 文档 / 压缩包 / 安装包 / 其他）也来自同一套映射。
   */
  const handleGroup = async (): Promise<void> => {
    setBusy('preview');
    setError(null);
    setGroupReport(null);
    try {
      const rep = await ipc.gridAutoArrange();
      setGroupReport(rep);
      await refreshPlans();
      if (rep.scanned === 0) {
        toast.warning('桌面已经很干净了', { description: '没有扫描到可归拢的条目' });
      } else if (rep.itemsAdded === 0) {
        toast.info('没有需要归拢的条目', {
          description: `扫描到 ${rep.scanned} 项（含公共桌面），格子布局已按内容重排`,
        });
      } else {
        toast.success(`已归拢 ${rep.itemsAdded} 个条目到桌面格子`, {
          description: '文件全部留在桌面原位，没有移动',
        });
      }
      if (rep.failures.length > 0) {
        toast.warning(`${rep.failures.length} 个条目没能归拢`, {
          description: rep.failures.slice(0, 3).join('；'),
        });
      }
    } catch (err: unknown) {
      reportOperation('归拢到桌面格子', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

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
      reportOperation('生成归类预览', err);
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
      reportOperation('应用归类计划', err);
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
        {targetDir !== null && processMode === 'move' ? (
          <button
            type="button"
            onClick={() => openDir(targetDir)}
            title="移动模式下会移到这里（不存在时由程序创建）"
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3" />
            打开整理目录
          </button>
        ) : null}
      </div>

      {/* 工具栏：处理方式（V37） + 规则选择 + 生成预览 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        {/* 处理方式：默认「归拢」不动文件；「移动」必须被显式选中 */}
        <div className="flex items-center gap-1" role="group" aria-label="处理方式">
          <button
            type="button"
            onClick={() => setProcessMode('group')}
            title="把桌面条目归拢进桌面格子，文件留在原位不动"
            className={cn(
              'inline-flex h-8 items-center gap-1 rounded-md px-3 text-xs transition',
              processMode === 'group'
                ? 'bg-brand text-white'
                : 'border text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <LayoutGrid className="h-3.5 w-3.5" />
            归拢到桌面格子
          </button>
          <button
            type="button"
            onClick={() => setProcessMode('move')}
            title="真的把文件移动到 桌面/Handy整理/ 下，可一键撤销"
            className={cn(
              'inline-flex h-8 items-center gap-1 rounded-md px-3 text-xs transition',
              processMode === 'move'
                ? 'bg-brand text-white'
                : 'border text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <FolderInput className="h-3.5 w-3.5" />
            移动到整理目录
          </button>
        </div>

        {processMode === 'move' ? (
          <>
            <span className="mx-1 h-5 w-px shrink-0 bg-border" />
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
          </>
        ) : null}

        <button
          type="button"
          onClick={() => void (processMode === 'group' ? handleGroup() : handlePreview())}
          disabled={busy !== null}
          className="ml-auto inline-flex h-8 shrink-0 items-center gap-1 rounded-md bg-brand px-3 text-xs font-medium text-white transition hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === 'preview' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : processMode === 'group' ? (
            <LayoutGrid className="h-3.5 w-3.5" />
          ) : (
            <FolderInput className="h-3.5 w-3.5" />
          )}
          {processMode === 'group' ? '归拢到桌面格子' : '生成预览'}
        </button>
      </div>

      {/* 处理方式说明（V37）：把「会不会动我的文件」说在明面上 */}
      <div
        className={cn(
          'flex items-start gap-2 border-b border-border px-4 py-2 text-[11px]',
          processMode === 'group' ? 'bg-muted/20 text-muted-foreground' : 'bg-destructive/5 text-destructive',
        )}
      >
        {processMode === 'group' ? (
          <>
            <LayoutGrid className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" />
            <span>
              按类型把桌面条目
              <span className="font-medium text-foreground">登记</span>
              进桌面格子（文件夹 / 图片 / 文档 / 压缩包 / 安装包 / 其他），
              文件本体一个字节都不动。快捷方式（.lnk）按设计留在桌面不动。
            </span>
          </>
        ) : (
          <>
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              这一种会
              <span className="font-medium">真的移动文件</span>
              到 <code className="font-mono">桌面/Handy整理/&lt;组名&gt;/</code>
              ，桌面上的原位置会空出来。移动后可以在下方历史计划里一键撤销恢复。
            </span>
          </>
        )}
      </div>

      {/* 错误态 */}
      {error && (
        <div className="mx-4 mb-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 scrollbar-thin overflow-auto px-4 pb-4">
        {/* 归拢结果摘要（V37 默认路径；一个文件都没动） */}
        {groupReport && processMode === 'group' && (
          <div className="mt-3 mb-3 rounded-lg border border-border bg-muted/30 p-3">
            <div className="flex items-center gap-2">
              <LayoutGrid className="h-4 w-4 text-brand" />
              <p className="flex-1 text-sm font-medium text-foreground">
                已归拢 {groupReport.itemsAdded} 个条目到桌面格子
                <span className="ml-1 font-normal text-muted-foreground">
                  （扫描 {groupReport.scanned} 项，文件全部原地未动）
                </span>
              </p>
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              新建格子 {groupReport.boxesCreated} 个 · 复用 {groupReport.boxesReused} 个 ·
              含文件夹 {groupReport.foldersMoved} 个 · 重排 {groupReport.boxesLaidOut} 格 ·
              按内容调尺寸 {groupReport.boxesResized} 格
            </p>
            {groupReport.failures.length > 0 && (
              <div className="mt-2 flex flex-col gap-1">
                {groupReport.failures.map((f) => (
                  <p key={f} className="flex items-start gap-1.5 text-[11px] text-destructive">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>{f}</span>
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 应用结果摘要（移动模式） */}
        {report && processMode === 'move' && (
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

        {/* 归拢模式空态：说清点一下会发生什么，别让用户不敢点 */}
        {processMode === 'group' && groupReport === null && (
          <div className="mt-3 rounded-lg border border-dashed border-border px-4 py-6 text-center">
            <LayoutGrid className="mx-auto h-6 w-6 text-muted-foreground/60" />
            <p className="mt-2 text-sm text-foreground">点右上角「归拢到桌面格子」</p>
            <p className="mt-1 text-xs text-muted-foreground">
              桌面上的文件会按类型分到几个格子里显示，
              <span className="font-medium text-foreground">文件本身留在桌面原位，一个都不会被移动或删除</span>。
            </p>
          </div>
        )}

        {/* 预览清单（分组 + 勾选排除；移动模式专属） */}
        {plan && processMode === 'move' && (
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

        {/* 历史计划（移动模式专属——归拢模式不产生计划，留着只会让人以为动过文件） */}
        <div className={cn(processMode !== 'move' && 'hidden')}>
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
