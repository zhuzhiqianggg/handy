import React, { useCallback, useEffect, useState } from 'react';
import {
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
 * # 它到底是什么（V25 说清楚，别再让人误会）
 *
 * 用户反馈原话：「桌面整理还是在自己的框里面玩，没有真正操作系统桌面」。
 * 这话是对的 —— 本视图**不移动任何文件**：格子里的条目只是原文件路径的
 * **引用**，双击用系统默认程序打开原文件。真正会去动操作系统桌面的那套
 * （扫描 → 预览 → 移动 → 可撤销）在 `../desktop-organizer/OrganizerView.tsx`。
 *
 * 所以 V25 把两者的关系摆正：
 *   - 模块首页改成 `DesktopOrganizerConsole`，**首屏就是「归类文件」**（真整理）；
 *   - 本视图降为该控制台的第二个页签「桌面格子」，并在顶部明说它不动文件。
 *
 * # 本视图保留的能力
 *
 *   - **一键整理成格子**：扫描桌面 → 按类型分组 → 每组一个格子 + 登记引用；
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

  useEffect(() => {
    void refresh();
    void refreshSnapshots();
  }, [refresh, refreshSnapshots]);

  const toggleOverlay = useCallback((): void => {
    setBusy(true);
    const next = !overlayVisible;
    const action = next ? ipc.gridOverlayShow() : ipc.gridOverlayHide();
    void action
      .then(() => setOverlayVisible(next))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusy(false));
  }, [overlayVisible]);

  const addBox = useCallback((): void => {
    setBusy(true);
    void ipc
      // 显式给出级联位置：多个新格子依次错开，不会叠在同一处
      .gridBoxUpsert({
        name: `新格子 ${boxes.length + 1}`,
        posX: 40 + (boxes.length % 3) * 344,
        posY: 40 + Math.floor(boxes.length / 3) * 268,
        width: 320,
        height: 244,
      })
      .then(async () => {
        await refresh();
        // 新建后立刻把格子层显示出来：让「添加格子」有马上看得见的结果
        if (!overlayVisible) {
          await ipc.gridOverlayShow();
          setOverlayVisible(true);
        }
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusy(false));
  }, [refresh, boxes.length, overlayVisible]);

  /** 一键整理：扫描桌面 → 分组建格子 → 登记引用（不移动任何文件） */
  const autoArrange = useCallback((): void => {
    setArranging(true);
    void ipc
      .gridAutoArrange()
      .then(async (report) => {
        await refresh();
        if (!overlayVisible) {
          await ipc.gridOverlayShow();
          setOverlayVisible(true);
        }
        if (report.scanned === 0) {
          toast.warning('桌面已经很干净了', { description: '没有扫描到可整理的图标' });
          return;
        }
        const created = report.boxesCreated > 0 ? `新建 ${report.boxesCreated} 个格子、` : '';
        toast.success(`已收成格子：${created}收进 ${report.itemsAdded} 个图标`, {
          description:
            report.itemsAdded === 0
              ? '桌面上的图标都已经在格子里了，没有重复收纳'
              : '文件本体没有被移动，格子只是桌面图标的归置方式',
        });
      })
      .catch((err: unknown) => {
        toast.error('一键整理失败', {
          description: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => setArranging(false));
  }, [refresh, overlayVisible]);

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
      <Button size="sm" onClick={autoArrange} disabled={arranging}>
        {arranging ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Sparkles className="h-3.5 w-3.5" />
        )}
        一键收成格子
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
            格子只登记
            <span className="font-medium text-foreground">文件引用</span>
            ，不移动文件 —— 要真把桌面文件归类，用另一个页签
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
              把桌面图标归置成格子 · 布局可备份可还原 · 文件本体不动（只登记引用）
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
              <span className="font-medium text-foreground">接管桌面显示</span>
              ：显示格子层时系统桌面图标自动隐藏、由格子接管（收起即恢复）；
              桌面文件每 5 秒自动同步 —— 新文件按类型归入对应格子，删掉的自动消失，
              文件本体<span className="font-medium text-foreground">不会被移动</span>。
            </p>
            <p>
              格子条目上的「×」= 从桌面视图移除且不再自动收录；把文件再拖回格子即解除。
              「备份布局」记下当前摆法，随时能「还原」回来。
            </p>
            <p className="text-foreground">
              想让桌面文件夹真归位（移动文件到 Handy整理/类别/ 并可撤销），
              请切到「归类文件」页签。接管期间建议先退出腾讯桌面整理等第三方桌面工具。
            </p>
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
                点「一键收成格子」让程序扫描桌面、按类型分好格子；也可以点「新建格子」自己摆。
                格子层会浮在桌面之上，把图标拖进去即登记引用（文件本体不会被移动）。
              </p>
              <div className="mt-4 flex justify-center gap-2">
                <Button size="sm" onClick={autoArrange} disabled={arranging}>
                  <Sparkles className="h-3.5 w-3.5" />
                  一键收成格子
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
                    <th className="px-4 py-2.5 font-medium">图标数</th>
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
                      <td className="px-4 py-2.5 text-muted-foreground">{box.itemCount}</td>
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
