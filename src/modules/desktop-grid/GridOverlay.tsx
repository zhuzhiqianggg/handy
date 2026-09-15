import React, { useCallback, useEffect, useRef, useState } from 'react';
import { EyeOff, File, FolderClosed, Lock, LockOpen, Plus, X } from 'lucide-react';
import { ipc } from '@/lib/ipc';
import { isTauri } from '@/platform/detect';
import type { GridBox, GridItem, GridRegion } from '@/types/grid';

/**
 * 桌面网格挂件 · 透明覆盖窗（`grid-overlay`）。
 *
 * 窗口形态：Rust 侧无边框透明窗（见 `commands/grid.rs`），占满主显示器工作区；
 * 本组件承担：
 *   - **盒子画布**：绝对定位的盒子（标题栏 + 条目网格），编辑模式可拖拽移动
 *     （标题栏）、右下角拖拽缩放、双击标题重命名；落库经 `gridBoxUpsert`；
 *   - **文件拖放**：`getCurrentWebview().onDragDropEvent`，drop 落点命中哪个盒子
 *     就把拖入文件登记为该盒子的**引用**（`gridItemAdd`，绝不移动文件）；
 *   - **点击穿透协同**：透明区域默认穿透（Rust 侧 `set_ignore_cursor_events`），
 *     本组件把盒子 / 工具栏矩形按 `scaleFactor` 换算为物理像素上报
 *     （`gridOverlayUpdateRegions`），Rust 光标轮询命中后才开放交互；拖拽期间
 *     经 `gridSetInteractive(true)` 显式申请保持可交互，避免拖快了被切回穿透；
 *   - **窗口几何持久化**：moved / resized 停稳 500ms 后写 `grid_geometry_set`；
 *   - **浮动工具栏**（常驻，右下角）：锁定/解锁布局、添加盒子、隐藏挂件。
 *
 * 交互约定：锁定态 = 只能双击打开条目 / 悬停移除引用；编辑态 = 布局操作全开放。
 */

/** 盒子最小尺寸（与 Rust 侧 grid_box_upsert 的下限一致） */
const MIN_BOX_W = 160;
const MIN_BOX_H = 120;
/** 窗口几何落库防抖（拖动/缩放停稳后写入） */
const GEOMETRY_SAVE_DEBOUNCE_MS = 500;
/** 提示条显示时长 */
const HINT_DURATION_MS = 2600;

/** 一次布局交互（移动 / 缩放）的会话状态 */
interface Interaction {
  kind: 'move' | 'resize';
  boxId: number;
  startX: number;
  startY: number;
  origX: number;
  origY: number;
  origW: number;
  origH: number;
}

/** 按扩展名粗判是否目录（无扩展名 → 视为文件夹；仅影响展示图标，不影响打开） */
function isDirectoryPath(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? '';
  return !/\.[^./\\]+$/.test(name);
}

export function GridOverlay(): React.JSX.Element {
  // —— 数据态 ——
  const [boxes, setBoxes] = useState<GridBox[]>([]);
  const [items, setItems] = useState<Record<number, GridItem[]>>({});
  const [hint, setHint] = useState<string | null>(null);

  // —— 布局交互态 ——
  const [editMode, setEditMode] = useState(false);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  /** 正在用「填路径」方式添加条目的盒子 id（拖放之外的第二条入口） */
  const [addingBoxId, setAddingBoxId] = useState<number | null>(null);
  const [addPathDraft, setAddPathDraft] = useState('');
  const [dropTargetId, setDropTargetId] = useState<number | null>(null);
  const [scaleFactor, setScaleFactor] = useState(1);

  /** 渲染无关的可变状态（事件回调内读取，避免闭包过期） */
  const boxesRef = useRef<GridBox[]>([]);
  const scaleRef = useRef(1);
  const interactionRef = useRef<Interaction | null>(null);
  const hintTimerRef = useRef<number | undefined>(undefined);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  /** 空态卡片的 DOM 引用：它也要纳入命中区域，否则「创建第一个盒子」按钮点不到 */
  const emptyRef = useRef<HTMLDivElement | null>(null);

  // boxesRef 镜像：拖放命中测试 / mouseup 落库时读取最新布局
  useEffect(() => {
    boxesRef.current = boxes;
  }, [boxes]);

  /** 短暂提示（挂件窗没有 toast 体系，用顶部悬浮文字） */
  const showHint = useCallback((message: string): void => {
    setHint(message);
    if (hintTimerRef.current !== undefined) {
      window.clearTimeout(hintTimerRef.current);
    }
    hintTimerRef.current = window.setTimeout(() => setHint(null), HINT_DURATION_MS);
  }, []);

  // —— 首次装配 ——

  /** 拉取盒子与条目（挂件窗独立 JS 环境，不与主窗口共享 store） */
  const refresh = useCallback(async (): Promise<void> => {
    const list = await ipc.gridBoxList();
    setBoxes(list);
    const entries = await Promise.all(
      list.map(async (box) => [box.id, await ipc.gridItemList(box.id)] as const),
    );
    setItems(Object.fromEntries(entries));
  }, []);

  useEffect(() => {
    void refresh().catch((error: Error) => showHint(error.message));
  }, [refresh, showHint]);

  // 透明窗：html/body 的白底会破坏透明（index.css 的 bg-background / index.html 内联底色）
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const prevHtml = html.style.background;
    const prevBody = body.style.background;
    html.style.background = 'transparent';
    body.style.background = 'transparent';
    return () => {
      html.style.background = prevHtml;
      body.style.background = prevBody;
    };
  }, []);

  // 缩放系数（逻辑 ↔ 物理换算基准）
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    let cancelled = false;
    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().scaleFactor())
      .then((sf) => {
        if (!cancelled && sf > 0) {
          scaleRef.current = sf;
          setScaleFactor(sf);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // —— 命中区域上报：Rust 光标轮询据此切换「穿透 ↔ 可交互」 ——

  /** 区域键（几何或缩放变化才重新上报，避免 mousemove 高频 invoke） */
  const regionsKey = `${boxes
    .map((b) => `${b.id}:${b.posX},${b.posY},${b.width},${b.height}`)
    .join('|')}|sf=${scaleFactor}`;

  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    const regions: GridRegion[] = boxes.map((box) => ({
      x: box.posX * scaleFactor,
      y: box.posY * scaleFactor,
      width: box.width * scaleFactor,
      height: box.height * scaleFactor,
    }));
    // 工具栏与空态卡片常驻可交互（锁定态也要能点「隐藏挂件 / 解锁」，空态要能直接建盒子）
    for (const node of [toolbarRef.current, emptyRef.current]) {
      if (!node) {
        continue;
      }
      const rect = node.getBoundingClientRect();
      regions.push({
        x: rect.left * scaleFactor,
        y: rect.top * scaleFactor,
        width: rect.width * scaleFactor,
        height: rect.height * scaleFactor,
      });
    }
    void ipc.gridOverlayUpdateRegions(regions).catch(() => undefined);
    // regionsKey 已覆盖 boxes 几何变化；eslint-disable 因键值派生依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionsKey, scaleFactor]);

  // —— 布局交互（mousemove 全局监听 + mouseup 落库） ——

  const persistBoxGeometry = useCallback(
    (boxId: number): void => {
      const box = boxesRef.current.find((b) => b.id === boxId);
      if (!box) {
        return;
      }
      void ipc
        .gridBoxUpsert({
          boxId: box.id,
          posX: box.posX,
          posY: box.posY,
          width: box.width,
          height: box.height,
        })
        .catch((error: Error) => showHint(error.message));
    },
    [showHint],
  );

  useEffect(() => {
    const onMove = (event: MouseEvent): void => {
      const interaction = interactionRef.current;
      if (!interaction) {
        return;
      }
      const dx = event.clientX - interaction.startX;
      const dy = event.clientY - interaction.startY;
      setBoxes((prev) =>
        prev.map((box) => {
          if (box.id !== interaction.boxId) {
            return box;
          }
          if (interaction.kind === 'move') {
            return {
              ...box,
              posX: Math.max(interaction.origX + dx, 0),
              posY: Math.max(interaction.origY + dy, 0),
            };
          }
          return {
            ...box,
            width: Math.max(interaction.origW + dx, MIN_BOX_W),
            height: Math.max(interaction.origH + dy, MIN_BOX_H),
          };
        }),
      );
    };
    const onUp = (): void => {
      const interaction = interactionRef.current;
      if (!interaction) {
        return;
      }
      interactionRef.current = null;
      // 交还穿透控制（光标若仍在盒子内，轮询线程会立即恢复可交互）
      void ipc.gridSetInteractive(false).catch(() => undefined);
      persistBoxGeometry(interaction.boxId);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [persistBoxGeometry]);

  const startMove = useCallback(
    (event: React.MouseEvent, box: GridBox): void => {
      if (!editMode) {
        return;
      }
      event.preventDefault();
      interactionRef.current = {
        kind: 'move',
        boxId: box.id,
        startX: event.clientX,
        startY: event.clientY,
        origX: box.posX,
        origY: box.posY,
        origW: box.width,
        origH: box.height,
      };
      // 拖拽期显式保持可交互（光标甩出盒子也不被切回穿透）
      void ipc.gridSetInteractive(true).catch(() => undefined);
    },
    [editMode],
  );

  const startResize = useCallback(
    (event: React.MouseEvent, box: GridBox): void => {
      if (!editMode) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      interactionRef.current = {
        kind: 'resize',
        boxId: box.id,
        startX: event.clientX,
        startY: event.clientY,
        origX: box.posX,
        origY: box.posY,
        origW: box.width,
        origH: box.height,
      };
      void ipc.gridSetInteractive(true).catch(() => undefined);
    },
    [editMode],
  );

  // —— 重命名（双击标题，编辑态） ——

  const beginRename = useCallback(
    (box: GridBox): void => {
      if (!editMode) {
        return;
      }
      setRenamingId(box.id);
      setRenameDraft(box.name);
    },
    [editMode],
  );

  const commitRename = useCallback((): void => {
    const id = renamingId;
    const name = renameDraft.trim();
    setRenamingId(null);
    if (id === null || name === '') {
      return;
    }
    void ipc
      .gridBoxUpsert({ boxId: id, name })
      .then((updated) => {
        setBoxes((prev) =>
          prev.map((box) => (box.id === updated.id ? { ...box, name: updated.name } : box)),
        );
      })
      .catch((error: Error) => showHint(error.message));
  }, [renamingId, renameDraft, showHint]);

  // —— 条目：打开（原文件）与移除（仅引用） ——

  const openItem = useCallback(
    (item: GridItem): void => {
      void ipc.gridOpenPath(item.filePath).catch((error: Error) => showHint(error.message));
    },
    [showHint],
  );

  const removeItem = useCallback(
    (item: GridItem): void => {
      void ipc
        .gridItemDelete(item.id)
        .then(() => {
          setItems((prev) => ({
            ...prev,
            [item.boxId]: (prev[item.boxId] ?? []).filter((i) => i.id !== item.id),
          }));
        })
        .catch((error: Error) => showHint(error.message));
    },
    [showHint],
  );

  const addItem = useCallback(
    (boxId: number, filePath: string): void => {
      void ipc
        .gridItemAdd(boxId, filePath)
        .then((item) => {
          setItems((prev) => ({ ...prev, [boxId]: [...(prev[boxId] ?? []), item] }));
        })
        .catch((error: Error) => showHint(error.message));
    },
    [showHint],
  );

  /**
   * 用输入框填写的路径添加条目（拖放之外的第二条入口）。
   * 便于键盘操作、沙箱环境，以及从资源管理器复制路径的场景。
   */
  const commitAddPath = useCallback(
    (boxId: number, rawPath: string): void => {
      // 兼容从资源管理器复制的带引号路径
      const path = rawPath.trim().replace(/^"(.*)"$/, '$1');
      setAddingBoxId(null);
      setAddPathDraft('');
      if (path.length === 0) {
        return;
      }
      addItem(boxId, path);
    },
    [addItem],
  );

  /** 打开「填路径」输入框 */
  const beginAddPath = useCallback((boxId: number): void => {
    setAddingBoxId(boxId);
  }, []);

  // —— 文件拖放：drop 落点命中哪个盒子，就把文件登记为该盒子的引用 ——

  /** 逻辑坐标 → 命中的盒子 id（后渲染的盒子优先，即数组尾部在上层） */
  const hitBoxId = useCallback((logicalX: number, logicalY: number): number | null => {
    const list = boxesRef.current;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const box = list[i];
      if (!box) {
        continue;
      }
      if (
        logicalX >= box.posX &&
        logicalX <= box.posX + box.width &&
        logicalY >= box.posY &&
        logicalY <= box.posY + box.height
      ) {
        return box.id;
      }
    }
    return null;
  }, []);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void (async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        const fn = await getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;
          const sf = scaleRef.current || 1;
          if (payload.type === 'over') {
            // 物理像素（相对窗口）→ 逻辑像素后命中测试
            setDropTargetId(hitBoxId(payload.position.x / sf, payload.position.y / sf));
          } else if (payload.type === 'drop') {
            const boxId = hitBoxId(payload.position.x / sf, payload.position.y / sf);
            setDropTargetId(null);
            if (boxId === null) {
              showHint('请把文件拖到挂件盒子上');
              return;
            }
            for (const path of payload.paths) {
              addItem(boxId, path);
            }
          } else {
            setDropTargetId(null);
          }
        });
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      } catch {
        /* 非 Tauri 环境（浏览器调试）：静默忽略 */
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [hitBoxId, addItem, showHint]);

  // —— 挂件窗几何持久化（moved / resized 停稳 500ms 后写库；同 NoteWindow 方案） ——

  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    let unlisteners: Array<() => void> = [];
    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        const sf = await win.scaleFactor();
        const initialPos = (await win.outerPosition()).toLogical(sf);
        const initialSize = (await win.innerSize()).toLogical(sf);
        let geo = {
          x: initialPos.x,
          y: initialPos.y,
          width: initialSize.width,
          height: initialSize.height,
        };
        const scheduleSave = (): void => {
          if (timer !== undefined) {
            window.clearTimeout(timer);
          }
          timer = window.setTimeout(() => {
            if (!cancelled) {
              void ipc
                .gridGeometrySet({
                  x: Math.round(geo.x),
                  y: Math.round(geo.y),
                  width: Math.round(geo.width),
                  height: Math.round(geo.height),
                })
                .catch(() => undefined);
            }
          }, GEOMETRY_SAVE_DEBOUNCE_MS);
        };
        const onMoved = await win.onMoved(({ payload }) => {
          const pos = payload.toLogical(sf);
          geo = { ...geo, x: pos.x, y: pos.y };
          scheduleSave();
        });
        const onResized = await win.onResized(({ payload }) => {
          const size = payload.toLogical(sf);
          geo = { ...geo, width: size.width, height: size.height };
          scheduleSave();
        });
        if (cancelled) {
          onMoved();
          onResized();
          return;
        }
        unlisteners = [onMoved, onResized];
      } catch {
        /* 几何持久化失败不影响挂件使用 */
      }
    })();
    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };
  }, []);

  // —— 工具栏动作 ——

  const toggleEditMode = useCallback((): void => {
    setEditMode((prev) => !prev);
  }, []);

  const addBox = useCallback((): void => {
    const count = boxesRef.current.length;
    void ipc
      .gridBoxUpsert({
        name: '新盒子',
        posX: 80 + (count % 5) * 36,
        posY: 80 + (count % 7) * 30,
        width: 320,
        height: 220,
      })
      .then((created) => {
        setBoxes((prev) => [...prev, created]);
        setItems((prev) => ({ ...prev, [created.id]: [] }));
      })
      .catch((error: Error) => showHint(error.message));
  }, [showHint]);

  const hideOverlay = useCallback((): void => {
    void ipc.gridOverlayHide().catch(() => undefined);
  }, []);

  // —— 渲染 ——

  return (
    <div className="fixed inset-0 select-none overflow-hidden" style={{ pointerEvents: 'none' }}>
      {/* 盒子画布：每个盒子自身恢复指针事件（外层穿透不继承） */}
      {boxes.map((box) => {
        const boxItems = items[box.id] ?? [];
        const isDropTarget = dropTargetId === box.id;
        return (
          <section
            key={box.id}
            style={{
              left: box.posX,
              top: box.posY,
              width: box.width,
              height: box.height,
              pointerEvents: 'auto',
            }}
            className={`absolute flex flex-col overflow-hidden rounded-xl border border-white/10 bg-neutral-900/55 text-neutral-100 shadow-xl backdrop-blur-md transition-shadow ${
              editMode ? 'ring-1 ring-sky-400/60' : ''
            } ${isDropTarget ? 'ring-2 ring-sky-300' : ''}`}
          >
            {/* 标题栏：编辑态拖拽移动 + 双击重命名 */}
            <header
              onMouseDown={(event) => startMove(event, box)}
              onDoubleClick={() => beginRename(box)}
              className={`flex h-8 shrink-0 items-center gap-1 px-2 ${
                editMode ? 'cursor-move active:cursor-grabbing' : ''
              }`}
              title={editMode ? '拖拽移动 · 双击重命名' : box.name}
            >
              {renamingId === box.id ? (
                <input
                  autoFocus
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      commitRename();
                    } else if (event.key === 'Escape') {
                      setRenamingId(null);
                    }
                  }}
                  className="w-full rounded bg-neutral-800 px-1 text-xs text-neutral-100 outline-none ring-1 ring-sky-400"
                />
              ) : (
                <span className="min-w-0 flex-1 truncate text-xs font-medium opacity-80">
                  {box.name}
                </span>
              )}
              {editMode ? (
                <button
                  type="button"
                  title="填路径添加引用（也可直接把文件拖进盒子）"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={() => beginAddPath(box.id)}
                  className="shrink-0 rounded p-0.5 opacity-70 transition hover:bg-white/15 hover:opacity-100"
                >
                  <Plus className="h-3 w-3" />
                </button>
              ) : null}
              <span className="shrink-0 text-[10px] opacity-40">{boxItems.length}</span>
            </header>

            {/* 条目网格：双击打开原文件；悬停显示移除引用 */}
            <div
              className="grid min-h-0 flex-1 content-start gap-1 overflow-y-auto p-2"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))' }}
            >
              {addingBoxId === box.id ? (
                <div className="col-span-full flex items-center gap-1">
                  <input
                    autoFocus
                    value={addPathDraft}
                    onChange={(event) => setAddPathDraft(event.target.value)}
                    onMouseDown={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        commitAddPath(box.id, addPathDraft);
                      } else if (event.key === 'Escape') {
                        setAddingBoxId(null);
                        setAddPathDraft('');
                      }
                    }}
                    placeholder="粘贴文件/文件夹完整路径后回车"
                    className="min-w-0 flex-1 rounded bg-neutral-800 px-1.5 py-1 text-[11px] text-neutral-100 outline-none ring-1 ring-sky-400/60"
                  />
                </div>
              ) : null}
              {boxItems.map((item) => (
                <div
                  key={item.id}
                  title={`${item.displayName}\n${item.filePath}\n双击打开原文件`}
                  onDoubleClick={() => openItem(item)}
                  className="group relative flex cursor-pointer flex-col items-center gap-1 rounded-lg p-1.5 transition hover:bg-white/10"
                >
                  <button
                    type="button"
                    title="移除引用（不影响原文件）"
                    onClick={() => removeItem(item)}
                    className="absolute right-0.5 top-0.5 hidden rounded bg-black/50 p-0.5 text-neutral-200 hover:bg-red-500/80 group-hover:block"
                  >
                    <X className="h-3 w-3" />
                  </button>
                  {isDirectoryPath(item.filePath) ? (
                    <FolderClosed className="h-7 w-7 text-amber-300" />
                  ) : (
                    <File className="h-7 w-7 text-sky-300" />
                  )}
                  <span className="w-full truncate text-center text-[11px] leading-tight opacity-90">
                    {item.displayName}
                  </span>
                </div>
              ))}
              {boxItems.length === 0 && (
                <p className="col-span-full py-4 text-center text-[11px] opacity-40">
                  把文件拖到这里建立引用
                </p>
              )}
            </div>

            {/* 缩放手柄（仅编辑态） */}
            {editMode && (
              <div
                onMouseDown={(event) => startResize(event, box)}
                title="拖拽调整大小"
                className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
              >
                <svg viewBox="0 0 16 16" className="h-full w-full text-white/50">
                  <path
                    d="M14 14L7 14M14 14L14 7"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    fill="none"
                  />
                </svg>
              </div>
            )}
          </section>
        );
      })}

      {/* 空态引导：卡片自身可交互（已纳入命中区域），可直接创建第一个盒子 */}
      {boxes.length === 0 && (
        <div
          ref={emptyRef}
          style={{ pointerEvents: 'auto' }}
          className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-3 rounded-xl bg-neutral-900/75 px-6 py-5 text-center shadow-2xl backdrop-blur"
        >
          <p className="text-sm font-medium text-neutral-100">桌面挂件还没有盒子</p>
          <p className="max-w-xs text-xs leading-relaxed text-neutral-300">
            盒子是桌面上的收纳格：把文件拖进去即建立引用，双击图标用默认程序打开原文件，
            <span className="text-neutral-100">原文件不会被移动</span>。
          </p>
          <button
            type="button"
            onClick={addBox}
            className="rounded-lg bg-sky-500/90 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-sky-400"
          >
            ＋ 创建第一个盒子
          </button>
        </div>
      )}

      {/* 提示条（非交互文本） */}
      {hint && (
        <div className="absolute left-1/2 top-4 -translate-x-1/2 rounded-md bg-neutral-900/80 px-3 py-1.5 text-xs text-neutral-100 shadow-lg backdrop-blur">
          {hint}
        </div>
      )}

      {/* 浮动工具栏（常驻命中区域）：锁定/解锁布局 · 添加盒子 · 隐藏挂件 */}
      <div
        ref={toolbarRef}
        style={{ pointerEvents: 'auto' }}
        className="absolute bottom-5 right-5 flex items-center gap-0.5 rounded-full bg-neutral-900/70 px-2 py-1.5 shadow-lg ring-1 ring-white/10 backdrop-blur"
      >
        <button
          type="button"
          onClick={toggleEditMode}
          title={editMode ? '锁定布局' : '解锁布局（编辑模式）'}
          className={`rounded-full p-1.5 transition hover:bg-white/10 ${
            editMode ? 'text-sky-300' : 'text-neutral-200'
          }`}
        >
          {editMode ? <Lock className="h-4 w-4" /> : <LockOpen className="h-4 w-4" />}
        </button>
        <button
          type="button"
          onClick={addBox}
          title="添加盒子"
          className="rounded-full p-1.5 text-neutral-200 transition hover:bg-white/10"
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={hideOverlay}
          title="隐藏挂件（可在应用内重新打开）"
          className="rounded-full p-1.5 text-neutral-200 transition hover:bg-white/10"
        >
          <EyeOff className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
