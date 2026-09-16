import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  CalendarDays,
  EyeOff,
  File,
  FolderClosed,
  Lock,
  LockOpen,
  Plus,
  StickyNote,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import { ipc } from '@/lib/ipc';
import { isTauri } from '@/platform/detect';
import type { GridBox, GridItem, GridRegion } from '@/types/grid';
import { CalendarWidget, NoteWidget } from './DesktopWidgets';

/**
 * 桌面网格挂件 · 透明覆盖窗（`grid-overlay`）。
 *
 * 窗口形态：Rust 侧无边框透明窗（见 `commands/grid.rs`），占满主显示器工作区；
 * 本组件承担：
 *   - **盒子画布**：绝对定位的盒子（标题栏 + 条目网格），编辑模式可拖拽移动
 *     （标题栏）、右下角拖拽缩放、双击标题重命名；落库经 `gridBoxUpsert`；
 *   - **文件拖放**：`getCurrentWebview().onDragDropEvent`，drop 落点命中哪个盒子
 *     就把拖入文件**真的移动**进该盒子的目录（`gridItemAdd` → Rust `fs::rename`，
 *     同名冲突自动改名，绝不覆盖）；拖到别的盒子 = 再移动一次；
 *   - **点击穿透协同**：透明区域默认穿透（Rust 侧 `set_ignore_cursor_events`），
 *     本组件把盒子 / 工具栏矩形按 `scaleFactor` 换算为物理像素上报
 *     （`gridOverlayUpdateRegions`），Rust 光标轮询命中后才开放交互；拖拽期间
 *     经 `gridSetInteractive(true)` 显式申请保持可交互，避免拖快了被切回穿透；
 *   - **窗口几何持久化**：moved / resized 停稳 500ms 后写 `grid_geometry_set`；
 *   - **浮动工具栏**（常驻，右下角）：锁定/解锁布局、添加收纳格 / 便签 / 日历、隐藏挂件。
 *
 * 交互约定：锁定态 = 只能双击打开条目 / 悬停「×」把条目移回桌面；编辑态 = 布局操作全开放。
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

/** 一次「条目跨格子拖拽」的会话状态（HTML5 drag，仅挂件内部） */
interface ItemDrag {
  itemId: number;
  fromBoxId: number;
}

/** 按扩展名粗判是否目录（无扩展名 → 视为文件夹；仅影响展示图标，不影响打开） */
function isDirectoryPath(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? '';
  return !/\.[^./\\]+$/.test(name);
}

// —— 系统真实图标（接管桌面的观感关键：和资源管理器一致，一眼认出「这是我的文件」） ——

/** 一条图标缓存：dataURL + 原始像素尺寸（尺寸跟着系统图标走，不在前端硬编码缩放） */
interface IconEntry {
  url: string;
  size: number;
}

/** 图标缓存（路径 → 图标）：挂件窗独立 JS 环境，模块级即可 */
const iconCache = new Map<string, IconEntry>();
const iconPending = new Map<string, Promise<IconEntry | null>>();

/**
 * 取系统真实图标并转成 dataURL。
 *
 * V34（用户反馈「整理到格子里面的图标样式都变了」）：Rust 侧改为取**带快捷方式
 * 箭头叠层**的 48px 大图标（`SHGetImageList` 的 `SHIL_EXTRALARGE`）—— 之前取的是
 * 无箭头的 32px 基础图标，于是 `.lnk` 在格子里「长得不像快捷方式」，
 * 和桌面/资源管理器里的样子对不上。这里也不再写死 `h-8 w-8`，按真实尺寸渲染。
 */
async function loadIcon(path: string): Promise<IconEntry | null> {
  try {
    const data = await ipc.gridFileIcon(path);
    if (!data || data.width <= 0 || data.height <= 0) {
      return null;
    }
    const bytes = Uint8Array.from(atob(data.rgbaBase64), (char) => char.charCodeAt(0));
    const canvas = document.createElement('canvas');
    canvas.width = data.width;
    canvas.height = data.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return null;
    }
    ctx.putImageData(
      new ImageData(new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength), data.width, data.height),
      0,
      0,
    );
    return { url: canvas.toDataURL('image/png'), size: data.width };
  } catch {
    return null;
  }
}

/** 条目图标：优先系统真实图标，加载失败回退通用线条图标 */
function FileIcon({ path }: { path: string }): React.JSX.Element {
  const [icon, setIcon] = useState<IconEntry | null>(() => iconCache.get(path) ?? null);
  useEffect(() => {
    if (icon !== null) {
      return;
    }
    let cancelled = false;
    const pending = iconPending.get(path) ?? loadIcon(path);
    iconPending.set(path, pending);
    void pending
      .then((data) => {
        if (data !== null) {
          iconCache.set(path, data);
        }
        if (!cancelled && data !== null) {
          setIcon(data);
        }
      })
      .finally(() => {
        iconPending.delete(path);
      });
    return () => {
      cancelled = true;
    };
  }, [path, icon]);
  if (icon !== null) {
    return (
      <img
        src={icon.url}
        alt=""
        draggable={false}
        style={{ width: icon.size, height: icon.size }}
        className="shrink-0 object-contain [filter:drop-shadow(0_1px_2px_rgba(0,0,0,0.55))]"
      />
    );
  }
  return isDirectoryPath(path) ? (
    <FolderClosed className="h-7 w-7 text-amber-300" />
  ) : (
    <File className="h-7 w-7 text-sky-300" />
  );
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
  /** 进行中的条目内部拖拽（null = 没有正在拖的条目） */
  const itemDragRef = useRef<ItemDrag | null>(null);
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

  // —— 桌面对账（V33：只对账，不收录） ——
  //
  // 格子内容是「收纳目录的真实内容」：用户在资源管理器里直接往格子的目录里放文件、
  // 或把文件移走，这里对账后格子会跟着变。
  // **不再自动把桌面文件收进格子** —— 那正是用户抱怨「和桌面图标重复、像复制了
  // 一份」的来源；现在只有用户主动拖进格子才会收纳（真移动文件）。

  /** 对账一次并按需刷新（有变化才重渲染，避免无谓的 DOM 抖动） */
  const syncDesktop = useCallback(async (): Promise<void> => {
    const report = await ipc.gridDesktopSync();
    if (report.itemsAdded > 0 || report.pruned > 0) {
      await refresh();
    }
  }, [refresh]);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    const tick = (): void => {
      // 窗口隐藏（挂件收起）时 webview 仍在运行，别白白扫盘
      if (document.visibilityState !== 'visible') {
        return;
      }
      void syncDesktop().catch(() => undefined);
    };
    // V33：15 秒一次（原 5 秒过于频繁，且对账后新增条目会让格子内容频繁跳动）
    const timer = window.setInterval(tick, 15_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [syncDesktop]);

  // 挂件窗隐藏后再显示不会重新挂载，这里只在窗口创建时提示一次桌面图标状态。
  // V32 起格子层默认**不再隐藏**系统图标（原桌面 + 格子共存的形态），所以只有手动
  // 开过「隐藏系统图标」的用户才会看到这条提示 —— 顺带提醒他收起即恢复。
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    void ipc
      .gridDesktopIconsGet()
      .then((visible) => {
        if (!visible) {
          showHint('系统桌面图标处于隐藏状态（可在管理页恢复），收起挂件即恢复');
        }
      })
      .catch(() => undefined);
  }, [showHint]);

  // —— 健康监控（V32）：心跳 + 故障自捕获 ——

  // 心跳：每 10s 向 Rust 报一次「JS 还活着」。
  //
  // V33 修正：心跳**只作诊断记录**，不再触发窗口重建。旧策略是「90 秒没心跳就销毁
  // 重建」，但 WebView2 对贴桌面层的窗口会做后台定时器节流，心跳间隔很容易被拉到
  // 90 秒以上 → 被误判成白屏 → 周期性销毁重建，用户看到的就是「闪一下没了 / 又出来了」。
  // 现在只有「显示后一次心跳都没有」（真正的冷启动白屏）才会重建，见 Rust 轮询线程。
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    const beat = (): void => {
      void ipc.gridOverlayHeartbeat().catch(() => undefined);
    };
    beat();
    const timer = window.setInterval(beat, 10_000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  // 故障自捕获：白屏的根因（JS 异常把 React 树整棵卸掉）此前无据可查。
  // 这里把未捕获错误/Promise 拒绝上报落库，管理页展示、用户截图即可反馈。
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    const report = (kind: string, detail: unknown): void => {
      const message =
        detail instanceof Error
          ? `${detail.name}: ${detail.message}`
          : typeof detail === 'string'
            ? detail
            : String(detail);
      void ipc.gridOverlayFault(`[${kind}] ${message}`).catch(() => undefined);
    };
    const onError = (event: ErrorEvent): void => {
      report('error', event.error ?? event.message);
    };
    const onRejection = (event: PromiseRejectionEvent): void => {
      report('unhandled-rejection', event.reason);
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  // 透明窗：html/body/**#root** 的白底都会破坏透明（index.css 的 bg-background /
  // index.html 内联 #root{background:#fff} —— V30.1 前格子层白底盖壁纸的真凶）
  useEffect(() => {
    const nodes: HTMLElement[] = [document.documentElement, document.body];
    const root = document.getElementById('root');
    if (root) {
      nodes.push(root);
    }
    const prev = nodes.map((node) => node.style.background);
    for (const node of nodes) {
      node.style.background = 'transparent';
    }
    return () => {
      nodes.forEach((node, index) => {
        node.style.background = prev[index] ?? '';
      });
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

  /**
   * 桌面上真正要画的格子。
   *
   * V34（用户要求「整理的时候只展示分类下面有东西的格子」）：**空的收纳格不在桌面
   * 上占位** —— 一个空框浮在壁纸上只会挡视线、看着也乱。
   *
   * 但空格子并没有消失：解锁布局（编辑态）后它们全部显形，可以往里拖文件、重命名、
   * 删除；平时它们在管理页里照旧可管。一旦有内容就自动出现在桌面上。
   * 挂件（便签 / 日历）与内容无关，任何模式下都展示。
   */
  const visibleBoxes = boxes.filter(
    (box) => box.kind !== 'folder' || editMode || (items[box.id]?.length ?? 0) > 0,
  );

  /** 区域键（几何或缩放变化才重新上报，避免 mousemove 高频 invoke） */
  const regionsKey = `${visibleBoxes
    .map((b) => `${b.id}:${b.posX},${b.posY},${b.width},${b.height}`)
    .join('|')}|sf=${scaleFactor}`;

  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    const regions: GridRegion[] = visibleBoxes.map((box) => ({
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
    [],
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
      setRenamingId(box.id);
      setRenameDraft(box.name);
    },
    [],
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

  /** 把条目移出格子：文件**移回桌面根目录**（不是删除），桌面图标随之回来 */
  const removeItem = useCallback(
    (item: GridItem): void => {
      void ipc
        .gridItemDelete(item.id)
        .then(() => {
          setItems((prev) => ({
            ...prev,
            [item.boxId]: (prev[item.boxId] ?? []).filter((i) => i.id !== item.id),
          }));
          showHint(`已移出格子：${item.displayName}（回到桌面）`);
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
          showHint(`已收纳：${item.displayName}`);
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

  // —— 条目跨格子拖拽（对标腾讯桌面整理：图标拖着走，只改引用归属） ——

  /** 条目拖进目标格子：改引用归属，本地两格列表同步增删 */
  const moveItem = useCallback(
    (drag: ItemDrag, targetBoxId: number): void => {
      if (drag.fromBoxId === targetBoxId) {
        return; // 同格拖放 = 无操作
      }
      void ipc
        .gridItemMove(drag.itemId, targetBoxId)
        .then(() => {
          setItems((prev) => {
            const source = (prev[drag.fromBoxId] ?? []).filter((i) => i.id !== drag.itemId);
            const dragged = (prev[drag.fromBoxId] ?? []).find((i) => i.id === drag.itemId);
            if (!dragged) {
              return prev;
            }
            const target = [...(prev[targetBoxId] ?? []), { ...dragged, boxId: targetBoxId }];
            return { ...prev, [drag.fromBoxId]: source, [targetBoxId]: target };
          });
        })
        .catch((error: Error) => showHint(error.message));
    },
    [showHint],
  );

  const startItemDrag = useCallback((item: GridItem, event: React.DragEvent): void => {
    itemDragRef.current = { itemId: item.id, fromBoxId: item.boxId };
    event.dataTransfer.effectAllowed = 'move';
    // 同窗口 HTML5 拖拽也会走 WebView2 的系统拖放事件，标记一下供其忽略
    event.dataTransfer.setData('application/x-handy-item', String(item.id));
    // 拖拽期保持整窗可交互（光标会频繁跨越盒子边界）
    void ipc.gridSetInteractive(true).catch(() => undefined);
  }, []);

  const endItemDrag = useCallback((): void => {
    if (itemDragRef.current === null) {
      return;
    }
    itemDragRef.current = null;
    setDropTargetId(null);
    // 交还命中轮询控制（光标若仍在盒子内会立即恢复可交互）
    void ipc.gridSetInteractive(false).catch(() => undefined);
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
          // 挂件内部正在拖条目（HTML5 drag）：让路，避免系统拖放事件把状态搅乱
          if (itemDragRef.current !== null) {
            return;
          }
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
    setEditMode((prev) => {
      const next = !prev;
      // 编辑态 = 布局操作密集期：整窗保持可交互，退出后交还命中轮询控制
      void ipc.gridSetInteractive(next).catch(() => undefined);
      return next;
    });
  }, []);

  const addBox = useCallback((): void => {
    const count = boxesRef.current.length;
    void ipc
      .gridBoxUpsert({
        name: `新格子 ${count + 1}`,
        kind: 'folder',
        // 不指定落点 → 由 Rust 按「靠右自动流」算（与一键收纳共用同一套排布）：
        // 新格子永远出现在眼睛习惯的右侧，且不会叠在已有格子上
        width: 320,
        height: 220,
      })
      .then((created) => {
        setBoxes((prev) => [...prev, created]);
        setItems((prev) => ({ ...prev, [created.id]: [] }));
        showHint(`已新建收纳格：${created.name}（把文件拖进来即收纳）`);
      })
      .catch((error: Error) => showHint(error.message));
  }, [showHint]);

  /**
   * 新建挂件（便签 / 日历）—— 桌面上直接可用的轻量小组件。
   *
   * V34（用户要求「日历挂件只有一个，不要点一次就能无限加一堆个」「便签也一个吧」）：
   * 改为**同类型只允许一个**。再点就把用户引到已有的那一个上，不再新建。
   */
  const addWidget = useCallback(
    (kind: 'note' | 'calendar'): void => {
      const existing = boxesRef.current.find((box) => box.kind === kind);
      if (existing) {
        showHint(
          kind === 'note'
            ? '便签已经有一个了，直接用它就好'
            : '日历挂件已经有一个了，直接用它就好',
        );
        return;
      }
      const count = boxesRef.current.length;
      const preset =
        kind === 'note'
          ? { name: '便签', width: 260, height: 220, content: '' }
          : { name: '日历 · 今日计划', width: 320, height: 300, content: '' };
      void ipc
        .gridBoxUpsert({
          name: preset.name,
          kind,
          content: preset.content,
          posX: 120 + (count % 5) * 36,
          posY: 120 + (count % 7) * 30,
          width: preset.width,
          height: preset.height,
        })
        .then((created) => {
          setBoxes((prev) => [...prev, created]);
          setItems((prev) => ({ ...prev, [created.id]: [] }));
          showHint(kind === 'note' ? '已新建便签挂件' : '已新建日历挂件（含今日计划）');
        })
        .catch((error: Error) => showHint(error.message));
    },
    [showHint],
  );

  /** 保存挂件数据（便签正文 / 日历配置），失败不弹提示以免打断输入 */
  const saveBoxContent = useCallback((boxId: number, content: string): void => {
    setBoxes((prev) => prev.map((box) => (box.id === boxId ? { ...box, content } : box)));
    void ipc.gridBoxSetContent(boxId, content).catch(() => undefined);
  }, []);

  /** 删除格子（只删格子本身；收纳目录里还有文件则原样保留） */
  const deleteBox = useCallback(
    (boxId: number): void => {
      void ipc
        .gridBoxDelete(boxId)
        .then(() => {
          setBoxes((prev) => prev.filter((box) => box.id !== boxId));
          setItems((prev) => {
            const next = { ...prev };
            delete next[boxId];
            return next;
          });
        })
        .catch((error: Error) => showHint(error.message));
    },
    [showHint],
  );

  const hideOverlay = useCallback((): void => {
    void ipc.gridOverlayHide().catch(() => undefined);
  }, []);

  /** 手动对账一次（把格子里目录的真实内容刷新进来） */
  const syncNow = useCallback((): void => {
    void ipc
      .gridDesktopSync()
      .then(async (report) => {
        await refresh();
        showHint(`已对账 ${report.boxes} 个收纳格：新增 ${report.itemsAdded} · 清理 ${report.pruned}`);
      })
      .catch((error: Error) => showHint(error.message));
  }, [refresh, showHint]);

  // —— 渲染 ——

  /**
   * 挂件唯一性（用户要求「日历挂件只有一个」「便签也一个吧」）：
   * 已经有一个就把对应按钮置灰，而不是点了才弹提示。
   */
  const hasNote = boxes.some((box) => box.kind === 'note');
  const hasCalendar = boxes.some((box) => box.kind === 'calendar');

  return (
    <div className="fixed inset-0 select-none overflow-hidden" style={{ pointerEvents: 'none' }}>
      {/* 盒子画布：每个盒子自身恢复指针事件（外层穿透不继承） */}
      {visibleBoxes.map((box) => {
        const boxItems = items[box.id] ?? [];
        const isDropTarget = dropTargetId === box.id;
        const isWidget = box.kind === 'note' || box.kind === 'calendar';
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
            /* 观感目标（用户原话）：「桌面就是一个大容器，格子就是大容器里面的小容器，
               自然嵌入在桌面上」「像在壁纸上画了一张图」。
               手法 = 极低透明度的磨砂 + 淡淡的描边 + 大圆角 + 柔和外阴影，
               而不是实心深色卡片；只有解锁（编辑态）时描边才变明显，
               好让你找得到可拖拽的边界。 */
            className={`absolute flex flex-col overflow-hidden rounded-2xl text-neutral-100 ${
              editMode
                ? 'border border-dashed bg-white/[0.07] backdrop-blur-md'
                : 'border bg-white/[0.045] shadow-[0_2px_18px_rgba(0,0,0,0.16)] backdrop-blur-[3px]'
            } ${
              isDropTarget
                ? 'border-sky-300/80 bg-sky-400/10'
                : editMode
                  ? 'border-sky-300/40'
                  : 'border-white/10'
            }`}
            onDragOver={(event) => {
              // 内部条目拖拽：允许作为放点（系统文件拖放走 webview 级事件，不经过这里）
              if (itemDragRef.current !== null) {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setDropTargetId(box.id);
              }
            }}
            onDrop={(event) => {
              const drag = itemDragRef.current;
              if (drag !== null) {
                event.preventDefault();
                moveItem(drag, box.id);
                endItemDrag();
              }
            }}
          >
            {/* 标题栏：拖拽移动（随时可用）+ 双击重命名 */}
            <header
              onMouseDown={(event) => startMove(event, box)}
              onDoubleClick={() => beginRename(box)}
              className="flex h-8 shrink-0 cursor-move items-center gap-1 px-2 active:cursor-grabbing"
              title="拖拽移动 · 双击重命名"
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
                <span
                  className={`min-w-0 flex-1 truncate text-xs font-medium ${
                    editMode ? 'opacity-80' : 'opacity-40 [text-shadow:0_1px_2px_rgba(0,0,0,0.6)]'
                  }`}
                >
                  {box.name}
                </span>
              )}
              {editMode && !isWidget ? (
                <button
                  type="button"
                  title="填路径收纳（也会把文件移动进格子目录）"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={() => beginAddPath(box.id)}
                  className="shrink-0 rounded p-0.5 opacity-70 transition hover:bg-white/15 hover:opacity-100"
                >
                  <Plus className="h-3 w-3" />
                </button>
              ) : null}
              {editMode ? (
                <button
                  type="button"
                  title="删除格子（格子里的文件会留在收纳目录里，不会被删）"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={() => deleteBox(box.id)}
                  className="shrink-0 rounded p-0.5 opacity-70 transition hover:bg-red-500/80 hover:opacity-100"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              ) : null}
              {isWidget ? (
                box.kind === 'note' ? (
                  <StickyNote className="h-3 w-3 shrink-0 opacity-50" />
                ) : (
                  <CalendarDays className="h-3 w-3 shrink-0 opacity-50" />
                )
              ) : (
                <span className="shrink-0 text-[10px] opacity-40">{boxItems.length}</span>
              )}
            </header>

            {/* 挂件（便签 / 日历）：内容自管，不参与收纳对账 */}
            {box.kind === 'note' ? (
              <div className="min-h-0 flex-1">
                <NoteWidget boxId={box.id} content={box.content} onSave={saveBoxContent} />
              </div>
            ) : box.kind === 'calendar' ? (
              <div className="min-h-0 flex-1">
                <CalendarWidget />
              </div>
            ) : (
              /* 收纳格条目网格：双击打开原文件；悬停把文件移出格子（回桌面）。
                 列宽 84px 是跟着 48px 系统图标定的 —— 桌面/资源管理器用的就是
                 48px 大图标，格子里的图标要和它看起来是同一个东西。 */
              <div
                className="grid min-h-0 flex-1 content-start gap-1 overflow-y-auto p-2"
                style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))' }}
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
                  title={`${item.displayName}\n${item.filePath}\n双击打开 · 拖到其他格子移动 · 右上角 × 移回桌面`}
                  draggable
                  onDragStart={(event) => startItemDrag(item, event)}
                  onDragEnd={endItemDrag}
                  onDoubleClick={() => openItem(item)}
                  className="group relative flex cursor-pointer flex-col items-center gap-1 rounded-lg p-1.5 transition hover:bg-white/10"
                >
                  <button
                    type="button"
                    title="移出格子：文件回到桌面（不是删除）"
                    onClick={() => removeItem(item)}
                    className="absolute right-0.5 top-0.5 hidden rounded bg-black/50 p-0.5 text-neutral-200 hover:bg-red-500/80 group-hover:block"
                  >
                    <X className="h-3 w-3" />
                  </button>
                  <FileIcon path={item.filePath} />
                  <span className="w-full truncate text-center text-[11px] leading-tight text-white opacity-90 [text-shadow:0_1px_2px_rgba(0,0,0,0.85)]">
                    {item.displayName}
                  </span>
                </div>
              ))}
              {boxItems.length === 0 && (
                <p className="col-span-full py-3 text-center text-[11px] leading-relaxed opacity-40">
                  把文件拖到这里收纳
                  <br />
                  文件会移动进 桌面/Handy整理/{box.name}
                </p>
              )}
              </div>
            )}

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

      {/* 格子都在、但都是空的 → 桌面上会一片空白。必须给个交代，
          否则用户会以为「格子又莫名消失了」。 */}
      {boxes.length > 0 && visibleBoxes.length === 0 && (
        <div
          style={{ pointerEvents: 'auto' }}
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-xl bg-neutral-900/70 px-4 py-3 text-center text-xs leading-relaxed text-neutral-200 shadow-lg backdrop-blur"
        >
          {boxes.length} 个格子还是空的，就先不在桌面上占位了
          <br />
          <span className="opacity-70">点右下角解锁图标即可看到它们，或先往里放文件</span>
        </div>
      )}

      {/* 空态引导：卡片自身可交互（已纳入命中区域），可直接创建第一个盒子 */}
      {boxes.length === 0 && (
        <div
          ref={emptyRef}
          style={{ pointerEvents: 'auto' }}
          className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-3 rounded-xl bg-neutral-900/75 px-6 py-5 text-center shadow-2xl backdrop-blur"
        >
          <p className="text-sm font-medium text-neutral-100">桌面上还没有格子</p>
          <p className="max-w-sm text-xs leading-relaxed text-neutral-300">
            收纳格是桌面上的分区：把文件拖进去，文件会
            <span className="text-neutral-100">真的移动</span>
            到 桌面/Handy整理/格子名/ 里，桌面不再重复显示它；双击图标用默认程序打开；
            右上角 × 把文件移回桌面（不是删除）。
            <br />
            也可以直接加一个便签或日历挂件，桌面随手记、随手看计划。
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={addBox}
              className="rounded-lg bg-sky-500/90 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-sky-400"
            >
              ＋ 新建收纳格
            </button>
            <button
              type="button"
              onClick={() => addWidget('note')}
              className="rounded-lg bg-white/15 px-3 py-1.5 text-xs font-medium text-neutral-100 transition hover:bg-white/25"
            >
              便签
            </button>
            <button
              type="button"
              onClick={() => addWidget('calendar')}
              className="rounded-lg bg-white/15 px-3 py-1.5 text-xs font-medium text-neutral-100 transition hover:bg-white/25"
            >
              日历 + 计划
            </button>
          </div>
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
          title="添加收纳格"
          className="rounded-full p-1.5 text-neutral-200 transition hover:bg-white/10"
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => addWidget('note')}
          disabled={hasNote}
          title={hasNote ? '便签已经有一个了' : '添加便签挂件（Markdown 边写边渲染，自动保存）'}
          className="rounded-full p-1.5 text-neutral-200 transition hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <StickyNote className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => addWidget('calendar')}
          disabled={hasCalendar}
          title={
            hasCalendar
              ? '日历挂件已经有一个了'
              : '添加日历挂件（农历 · 节气 · 节假日，点某天加计划，与工作台共用数据）'
          }
          className="rounded-full p-1.5 text-neutral-200 transition hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <CalendarDays className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={syncNow}
          title="立即对账：把格子目录里的真实内容刷新进来"
          className="rounded-full p-1.5 text-neutral-200 transition hover:bg-white/10"
        >
          <Wand2 className="h-4 w-4" />
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
