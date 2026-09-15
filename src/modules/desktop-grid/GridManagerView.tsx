import React, { useCallback, useEffect, useState } from 'react';
import { Eye, EyeOff, Info, LayoutGrid, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ipc } from '@/lib/ipc';
import type { GridBox } from '@/types/grid';

/**
 * 桌面挂件管理视图（主面板内页，模块 `desktop-organizer` 原地重定向至此）。
 *
 * 职责：
 *   - 说明新语义：**文件不会被移动，仅创建引用**；双击挂件条目即打开原文件；
 *   - 挂件显隐开关（`gridOverlayShow / gridOverlayHide`，幂等）；
 *   - 盒子列表（名称 / 条目数 / 几何 / 更新时间）+ 删除盒子（级联移除引用）。
 *
 * 盒子的增删改与条目管理主要在挂件窗内完成（拖放 / 右键 / 工具栏），本视图
 * 提供应用内的盘点与清理入口。
 */
export function GridManagerView(): React.JSX.Element {
  const [boxes, setBoxes] = useState<GridBox[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [overlayVisible, setOverlayVisible] = useState(false);
  const [busy, setBusy] = useState(false);

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

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      // 显式给出级联位置：多个新盒子依次错开，不会叠在同一处
      .gridBoxUpsert({
        name: `新盒子 ${boxes.length + 1}`,
        posX: 60 + (boxes.length % 6) * 340,
        posY: 60 + (boxes.length % 4) * 250,
        width: 320,
        height: 220,
      })
      .then(async () => {
        await refresh();
        // 新建后立刻把挂件窗显示出来：让「添加盒子」有立刻可见的结果
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

  const deleteBox = useCallback(
    (box: GridBox): void => {
      const message = `删除盒子「${box.name}」？\n\n将同时移除其中 ${box.itemCount} 个条目引用（不影响任何文件本体）。`;
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

  const totalItems = boxes.reduce((sum, box) => sum + box.itemCount, 0);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* 头部 */}
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-6 py-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 text-brand">
          <LayoutGrid className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold text-foreground">桌面挂件</h1>
          <p className="truncate text-xs text-muted-foreground">
            桌面网格挂件：把文件拖进盒子建立引用，双击打开原文件
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </Button>
        <Button variant="outline" size="sm" onClick={addBox} disabled={busy}>
          <Plus className="h-3.5 w-3.5" />
          添加盒子
        </Button>
        <Button size="sm" onClick={toggleOverlay} disabled={busy}>
          {overlayVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          {overlayVisible ? '隐藏挂件' : '显示挂件'}
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 scrollbar-thin">
        {/* 语义说明卡 */}
        <div className="mb-5 flex gap-3 rounded-xl border border-border bg-muted/40 px-4 py-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
          <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">文件不会被移动</span>
              ：与旧版「按类型归类」不同，挂件盒子里的条目只是原文件路径的
              <span className="font-medium text-foreground">引用</span>
              ，桌面文件保持原位，零磁盘副作用。
            </p>
            <p>
              双击挂件条目即用系统默认程序打开原文件；把文件拖到盒子上即可登记引用；
              悬停条目点「×」仅移除引用，不删文件。锁定布局后挂件自动让出点击
              （穿透到桌面），光标移到盒子 / 工具栏上才恢复交互。
            </p>
          </div>
        </div>

        {error && (
          <p className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}

        {/* 盒子列表 */}
        {loading ? (
          <p className="py-10 text-center text-sm text-muted-foreground">加载中…</p>
        ) : boxes.length === 0 ? (
          <div className="py-14 text-center">
            <p className="text-sm font-medium text-foreground">还没有盒子</p>
            <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
              盒子是桌面上的半透明收纳格。点下面的按钮即可创建第一个盒子 ——
              挂件窗会自动出现，把桌面文件拖进盒子就建立引用（文件本体不会被移动）。
            </p>
            <Button className="mt-4" size="sm" onClick={addBox} disabled={busy}>
              <Plus className="h-3.5 w-3.5" />
              创建第一个盒子并显示挂件
            </Button>
          </div>
        ) : (
          <>
            <p className="mb-2 text-xs text-muted-foreground">
              共 {boxes.length} 个盒子 · {totalItems} 个条目引用
            </p>
            <div className="overflow-hidden rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">盒子</th>
                    <th className="px-4 py-2.5 font-medium">条目数</th>
                    <th className="px-4 py-2.5 font-medium">位置 / 尺寸</th>
                    <th className="px-4 py-2.5 font-medium">更新时间</th>
                    <th className="px-4 py-2.5 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {boxes.map((box) => (
                    <tr key={box.id} className="border-b border-border/60 last:border-b-0">
                      <td className="px-4 py-2.5 font-medium text-foreground">{box.name}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{box.itemCount}</td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">
                        ({box.posX}, {box.posY}) · {box.width}×{box.height}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">
                        {box.updatedAt}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
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
