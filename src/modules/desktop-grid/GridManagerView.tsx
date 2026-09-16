import React, { useCallback, useEffect, useState } from 'react';
import {
  CalendarDays,
  Eye,
  EyeOff,
  History,
  Info,
  LayoutGrid,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  StickyNote,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { ipc } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import type { GridBox, LayoutSnapshotMeta } from '@/types/grid';

/**
 * 桌面格子（原「桌面整理」内页）。
 *
 * # 它到底是什么（V33 改的真收纳，别再按旧模型理解）
 *
 * 历史包袱：V25–V32 的格子是**文件引用型** —— 格子里只登记桌面原文件的路径，
 * 文件本身不动。用户看到的是「桌面有一份、格子里还有一份」，观感就是
 * 「并不是整理收纳，而是复制了一份而已」。V33 把模型推倒重来：
 *
 *   - 每个「收纳格」= 磁盘上一个**真实目录** `桌面/Handy整理/<格名>/`；
 *   - 拖文件进格子 = 真 `fs::rename` **移动**（同名冲突自动改名，绝不覆盖）；
 *   - 格子右上角 × = 把文件**移回桌面根**（不是删除）；
 *   - **默认不自动收纳**：只在用户主动点「一键收纳桌面」时才动文件，
 *     且只动**普通文件**，`.lnk` 快捷方式与文件夹原地不动（用户明确要求）。
 *
 * 所以「桌面看到的东西」和「格子里看到的东西」是同一份文件的两个位置，
 * 不会再出现复制观感。磁盘目录是唯一事实源，`grid_items` 表只作登记缓存，
 * 每次列出都会 `reconcile` 对齐。
 *
 * # 本视图保留的能力
 *
 *   - **一键收纳桌面**：扫描 → 按类型分组 → 真移动到对应格目录（普通文件）；
 *   - **格子 / 挂件**：收纳格、便签、日历计划三种，日历复用 `todos` 表；
 *   - **备份 / 还原布局**：把当前摆法存成本机快照，随时切回来；
 *   - **格子重命名 / 删除**、**显示 / 隐藏格子层**（浮在桌面之上、普通窗口之下）。
 */
export interface GridManagerViewProps {
  /**
   * 嵌入控制台时用紧凑工具条替代自带头部。
   *
   * 控制台已经有模块标题（`ModuleView` 的 header）与页签栏，这里再来一个
   * 「桌面整理」大标题就是同一件事的两种排版（V23 删「字段拆解」时定下的判据）。
   */
  embedded?: boolean;
}

export function GridManagerView({ embedded = false }: GridManagerViewProps = {}): React.JSX.Element {
  const [boxes, setBoxes] = useState<GridBox[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [overlayVisible, setOverlayVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [arranging, setArranging] = useState(false);

  /** 布局快照列表 + 是否展开该面板 */
  const [snapshots, setSnapshots] = useState<LayoutSnapshotMeta[]>([]);
  const [showSnapshots, setShowSnapshots] = useState(false);

  /** 行内重命名：正在编辑的格子 id + 草稿 */
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  /** 挂件前端最近一次故障（白屏/JS 崩溃取证；无记录为 null） */
  const [fault, setFault] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setBoxes(await ipc.gridBoxList());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshSnapshots = useCallback(async (): Promise<void> => {
    try {
      setSnapshots(await ipc.gridLayoutList());
    } catch {
      // 快照列表只作辅助展示，读失败不打断主流程
      setSnapshots([]);
    }
  }, []);

  /**
   * 同步挂件层的**真实状态**。
   *
   * V33 修的关键 bug：以前 `overlayVisible` 只是本组件的局部 state（初值 false），
   * 从不与服务端对齐 —— 于是「一键收纳 / 新建格子」会顺手把格子层弹出来（用户没点
   * 显示，格子却自己冒出来 = 「莫名其妙又出来了」），而按钮文案又和真实状态相反
   * （点「隐藏格子」实际在重复显示）。现在以窗口本身为唯一真相来源。
   */
  const syncOverlayStatus = useCallback(async (): Promise<void> => {
    try {
      const status = await ipc.gridOverlayStatus();
      setOverlayVisible(status.visible);
    } catch {
      // 查询失败保持上次状态，不误报
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshSnapshots();
    void syncOverlayStatus();
    void ipc
      .gridOverlayFaultGet()
      .then(setFault)
      .catch(() => undefined);
    // 状态轮询：格子层可能被挂件自身（收起按钮 / 托盘 / 崩溃自愈）改变，
    // 这里对齐开关，保证按钮文案永远与实际状态一致
    const timer = window.setInterval(() => void syncOverlayStatus(), 2000);
    return () => window.clearInterval(timer);
  }, [refresh, refreshSnapshots, syncOverlayStatus]);

  const toggleOverlay = useCallback((): void => {
    setBusy(true);
    const next = !overlayVisible;
    const action = next ? ipc.gridOverlayShow() : ipc.gridOverlayHide();
    void action
      .then(() => syncOverlayStatus())
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusy(false));
  }, [overlayVisible, syncOverlayStatus]);

  const addBox = useCallback((): void => {
    setBusy(true);
    void ipc
      // 显式给出级联位置：多个新格子依次错开，不会叠在同一处
      .gridBoxUpsert({
        name: `新格子 ${boxes.length + 1}`,
        kind: 'folder',
        posX: 40 + (boxes.length % 3) * 344,
        posY: 40 + Math.floor(boxes.length / 3) * 268,
        width: 320,
        height: 244,
      })
      .then(async () => {
        await refresh();
        toast.success('已新建收纳格', {
          description: overlayVisible ? undefined : '格子层当前是收起的，点「显示格子」即可看到',
        });
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusy(false));
  }, [refresh, boxes.length, overlayVisible]);

  /** 新建挂件（便签 / 日历 + 今日计划） */
  const addWidget = useCallback(
    (kind: 'note' | 'calendar'): void => {
      setBusy(true);
      const preset =
        kind === 'note'
          ? { name: '便签', width: 260, height: 220 }
          : { name: '日历 · 今日计划', width: 320, height: 300 };
      void ipc
        .gridBoxUpsert({
          name: preset.name,
          kind,
          posX: 40 + (boxes.length % 3) * 344,
          posY: 40 + Math.floor(boxes.length / 3) * 268,
          width: preset.width,
          height: preset.height,
        })
        .then(async () => {
          await refresh();
          toast.success(kind === 'note' ? '已新建便签挂件' : '已新建日历挂件', {
            description: overlayVisible ? undefined : '格子层当前是收起的，点「显示格子」即可看到',
          });
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => setBusy(false));
    },
    [refresh, boxes.length, overlayVisible],
  );

  /**
   * 一键收纳：扫描桌面 → 普通文件按类型**移动**进 `桌面/Handy整理/<类别>/`。
   *
   * 这是**真的移动文件**（V33 起），所以必须先二次确认；快捷方式与文件夹不动。
   */
  const autoArrange = useCallback((): void => {
    const ok = window.confirm(
      '一键收纳桌面？\n\n' +
        '会把桌面上的普通文件按类型移动到「桌面/Handy整理/<类别>/」，' +
        '每个类别对应一个收纳格。\n\n' +
        '· 快捷方式（.lnk）与文件夹保持不动，留在桌面原位；\n' +
        '· 同名文件绝不覆盖（自动改名为 name (2).ext）；\n' +
        '· 收纳后桌面图标不再重复显示这些文件；\n' +
        '· 想还原：在格子里点条目右上角的 × 即可把文件移回桌面。\n\n' +
        '确定继续？',
    );
    if (!ok) {
      return;
    }
    setArranging(true);
    void ipc
      .gridAutoArrange()
      .then(async (report) => {
        await refresh();
        await syncOverlayStatus();
        if (report.scanned === 0) {
          toast.warning('桌面已经很干净了', { description: '没有扫描到可整理的条目' });
          return;
        }
        if (report.itemsAdded === 0) {
          toast.info('没有需要收纳的文件', {
            description: `扫描到 ${report.scanned} 项，其中快捷方式 / 文件夹 ${report.skipped} 项按设计不动`,
          });
          return;
        }
        const created = report.boxesCreated > 0 ? `新建 ${report.boxesCreated} 个收纳格、` : '';
        toast.success(`已收纳 ${report.itemsAdded} 个文件`, {
          description: `${created}移动进 桌面/Handy整理/ 下；快捷方式与文件夹保持原位`,
        });
        if (report.failures.length > 0) {
          toast.warning(`${report.failures.length} 个文件没能收纳`, {
            description: report.failures.slice(0, 3).join('；'),
          });
        }
      })
      .catch((err: unknown) => {
        toast.error('一键收纳失败', {
          description: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => setArranging(false));
  }, [refresh, syncOverlayStatus]);

  const saveLayout = useCallback((): void => {
    setBusy(true);
    void ipc
      .gridLayoutSave()
      .then(async (meta) => {
        await refreshSnapshots();
        setShowSnapshots(true);
        toast.success(`已备份布局：${meta.name}`, {
          description: `${meta.boxCount} 个格子 · ${meta.itemCount} 个图标`,
        });
      })
      .catch((err: unknown) => {
        toast.error('备份布局失败', {
          description: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => setBusy(false));
  }, [refreshSnapshots]);

  const restoreLayout = useCallback(
    (snapshot: LayoutSnapshotMeta): void => {
      const ok = window.confirm(
        `还原布局「${snapshot.name}」？\n\n` +
          `当前布局会先自动备份为「还原前自动备份」，因此随时可以再换回来。\n` +
          `文件本体不会被移动或删除。`,
      );
      if (!ok) {
        return;
      }
      setBusy(true);
      void ipc
        .gridLayoutRestore(snapshot.id)
        .then(async (report) => {
          await refresh();
          await refreshSnapshots();
          const extra =
            report.missingFiles > 0 ? `（其中 ${report.missingFiles} 个文件已不在原位置）` : '';
          toast.success(`已还原：${report.boxes} 个格子 · ${report.items} 个图标${extra}`);
        })
        .catch((err: unknown) => {
          toast.error('还原布局失败', {
            description: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => setBusy(false));
    },
    [refresh, refreshSnapshots],
  );

  const deleteSnapshot = useCallback(
    (snapshot: LayoutSnapshotMeta): void => {
      if (!window.confirm(`删除备份「${snapshot.name}」？此操作不可撤销。`)) {
        return;
      }
      void ipc
        .gridLayoutDelete(snapshot.id)
        .then(() => refreshSnapshots())
        .catch((err: unknown) => {
          toast.error('删除备份失败', {
            description: err instanceof Error ? err.message : String(err),
          });
        });
    },
    [refreshSnapshots],
  );

  const deleteBox = useCallback(
    (box: GridBox): void => {
      const message = `删除格子「${box.name}」？\n\n将同时移除其中 ${box.itemCount} 个图标引用（不影响任何文件本体）。`;
      if (!window.confirm(message)) {
        return;
      }
      setBusy(true);
      void ipc
        .gridBoxDelete(box.id)
        .then(() => refresh())
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => setBusy(false));
    },
    [refresh],
  );

  const commitRename = useCallback(
    (box: GridBox): void => {
      const name = renameDraft.trim();
      setRenamingId(null);
      if (name === '' || name === box.name) {
        return;
      }
      void ipc
        .gridBoxUpsert({ boxId: box.id, name })
        .then(() => refresh())
        .catch((err: unknown) => {
          toast.error('重命名失败', {
            description: err instanceof Error ? err.message : String(err),
          });
        });
    },
    [refresh, renameDraft],
  );

  const totalItems = boxes.reduce((sum, box) => sum + box.itemCount, 0);

  /** 工具条按钮（自带头部与嵌入模式共用，避免两处抄一遍） */
  const toolbarActions = (
    <>
      <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
        <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        刷新
      </Button>
      <Button variant="outline" size="sm" onClick={addBox} disabled={busy}>
        <Plus className="h-3.5 w-3.5" />
        新建格子
      </Button>
      <Button variant="secondary" size="sm" onClick={() => addWidget('note')} disabled={busy}>
        <StickyNote className="h-3.5 w-3.5" />
        便签挂件
      </Button>
      <Button variant="secondary" size="sm" onClick={() => addWidget('calendar')} disabled={busy}>
        <CalendarDays className="h-3.5 w-3.5" />
        日历挂件
      </Button>
      <Button size="sm" onClick={autoArrange} disabled={arranging}>
        {arranging ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Sparkles className="h-3.5 w-3.5" />
        )}
        一键收纳桌面
      </Button>
      <Button variant="secondary" size="sm" onClick={toggleOverlay} disabled={busy}>
        {overlayVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        {overlayVisible ? '隐藏格子' : '显示格子'}
      </Button>
    </>
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {embedded ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
          <span className="text-[11px] leading-relaxed text-muted-foreground">
            格子是
            <span className="font-medium text-foreground">真实收纳格</span>
            ：拖进去 = 文件真的移到 桌面/Handy整理/格子名/；桌面图标与快捷方式不动
          </span>
          <div className="ml-auto flex items-center gap-2">{toolbarActions}</div>
        </div>
      ) : (
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-6 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 text-brand">
            <LayoutGrid className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-semibold text-foreground">桌面格子</h1>
            <p className="truncate text-xs text-muted-foreground">
              真实收纳 · 拖进去文件真的移进 Handy整理/格子名 · 桌面不再重复显示
            </p>
          </div>
          {toolbarActions}
        </header>
      )}

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {/* 语义说明卡 */}
        <div className="mb-5 flex gap-3 rounded-xl border border-border bg-muted/40 px-4 py-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
          <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">真实收纳</span>
              ：每个格子对应一个真实目录（桌面/Handy整理/格子名/）。把文件拖进格子 =
              文件<span className="font-medium text-foreground">真的移动</span>
              进该目录，桌面图标随之消失 —— 所以桌面不会出现「格子与原图标各一份」的重复。
              同名文件绝不覆盖（自动改名）。
            </p>
            <p>
              <span className="font-medium text-foreground">默认不动你的桌面</span>
              ：不自动收录、不隐藏图标，快捷方式一律留在原位。只有你点「一键收纳桌面」
              或主动把文件拖进格子，文件才会被移动。
            </p>
            <p>
              格子条目：双击打开、拖到其他格子即移动、右上角 × 把文件
              <span className="font-medium text-foreground">移回桌面</span>
              （不是删除）。标题栏随时可拖动移位、双击重命名。
              「备份布局」记下当前摆法，随时能「还原」回来。
            </p>
            <p className="text-foreground">
              桌面挂件：便签随手记（自动保存）、日历挂件带今日计划（与工作台共用同一份
              待办数据，桌面勾完工作台同步）。
            </p>
            {fault && (
              <p className="rounded bg-red-500/10 px-2 py-1 text-[11px] text-red-600 dark:text-red-400">
                挂件最近一次故障（已自动恢复过）：{fault}
              </p>
            )}
          </div>
        </div>

        {/* 布局备份区 */}
        <div className="mb-5 rounded-xl border border-border">
          <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
            <History className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-medium text-foreground">布局备份</span>
            <span className="text-xs text-muted-foreground">
              {snapshots.length > 0 ? `共 ${snapshots.length} 份` : '还没有备份'}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs" onClick={saveLayout} disabled={busy}>
                备份当前布局
              </Button>
              <button
                type="button"
                onClick={() => setShowSnapshots((prev) => !prev)}
                className="rounded-md px-2 py-1 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-accent-foreground"
              >
                {showSnapshots ? '收起' : '展开'}
              </button>
            </div>
          </div>

          {showSnapshots ? (
            snapshots.length === 0 ? (
              <p className="border-t border-border px-4 py-4 text-xs text-muted-foreground">
                点「备份当前布局」把现在这套摆法存下来；以后调整乱了可以一键还原。
              </p>
            ) : (
              <ul className="divide-y divide-border border-t border-border">
                {snapshots.map((snapshot) => (
                  <li
                    key={snapshot.id}
                    className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs"
                  >
                    <span className="font-medium text-foreground">{snapshot.name}</span>
                    <span className="text-muted-foreground">
                      {snapshot.boxCount} 格 · {snapshot.itemCount} 项
                    </span>
                    <span className="tabular-nums text-muted-foreground/70">{snapshot.savedAt}</span>
                    <div className="ml-auto flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => restoreLayout(snapshot)}
                        disabled={busy}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        还原
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => deleteSnapshot(snapshot)}
                        disabled={busy}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </div>

        {error !== null ? (
          <p className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}

        {/* 格子列表 */}
        {loading ? (
          <p className="py-10 text-center text-sm text-muted-foreground">加载中…</p>
        ) : boxes.length === 0 ? (
          <div className="py-14 text-center">
            <p className="text-sm font-medium text-foreground">还没有格子</p>
              <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
                点「一键收纳桌面」把桌面上的普通文件按类型移动进 桌面/Handy整理/ 并各建一个格子
                （快捷方式与文件夹不动）；也可以点「新建格子」自己摆，
                或加一个便签 / 日历挂件。显示格子后把文件拖进格子即收纳。
              </p>
              <div className="mt-4 flex justify-center gap-2">
                <Button size="sm" onClick={autoArrange} disabled={arranging}>
                  <Sparkles className="h-3.5 w-3.5" />
                  一键收纳桌面
                </Button>
              <Button variant="outline" size="sm" onClick={addBox} disabled={busy}>
                <Plus className="h-3.5 w-3.5" />
                手动新建格子
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="mb-2 text-xs text-muted-foreground">
              共 {boxes.length} 个格子 · {totalItems} 个图标引用
            </p>
            <div className="overflow-hidden rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">格子</th>
                    <th className="px-4 py-2.5 font-medium">内容</th>
                    <th className="px-4 py-2.5 font-medium">位置 / 尺寸</th>
                    <th className="px-4 py-2.5 font-medium">更新时间</th>
                    <th className="px-4 py-2.5 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {boxes.map((box) => (
                    <tr key={box.id} className="border-b border-border/60 last:border-b-0">
                      <td className="px-4 py-2.5">
                        {renamingId === box.id ? (
                          <input
                            // 自动聚焦：进入重命名即可直接打字
                            autoFocus
                            value={renameDraft}
                            onChange={(event) => setRenameDraft(event.target.value)}
                            onBlur={() => commitRename(box)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                commitRename(box);
                              }
                              if (event.key === 'Escape') {
                                setRenamingId(null);
                              }
                            }}
                            className="h-7 w-full rounded-md border border-brand/50 bg-background px-2 text-sm outline-none"
                            aria-label="格子名称"
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setRenamingId(box.id);
                              setRenameDraft(box.name);
                            }}
                            className="rounded px-1 py-0.5 font-medium text-foreground transition hover:bg-accent"
                            title="点击重命名"
                          >
                            {box.name}
                          </button>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {box.kind === 'note'
                          ? '便签挂件'
                          : box.kind === 'calendar'
                            ? '日历挂件'
                            : `${box.itemCount} 个文件`}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">
                        ({box.posX}, {box.posY}) · {box.width}×{box.height}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">{box.updatedAt}</td>
                      <td className="px-4 py-2.5 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => {
                            setRenamingId(box.id);
                            setRenameDraft(box.name);
                          }}
                          disabled={busy}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          重命名
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => deleteBox(box)}
                          disabled={busy}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          删除
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** 供模块注册表 `loadView` 动态导入（与其它模块视图的 default 导出约定一致） */
export default GridManagerView;
