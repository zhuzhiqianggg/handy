import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  CalendarDays,
  EyeOff,
  File,
  FolderClosed,
  Lock,
  LockOpen,
  Palette,
  Plus,
  StickyNote,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import { ipc } from '@/lib/ipc';
import { isTauri } from '@/platform/detect';
import type { GridAccent, GridBox, GridItem, GridRegion } from '@/types/grid';
import { ACCENT_ORDER, CalendarWidget, NOTE_ACCENTS, NoteWidget } from './DesktopWidgets';

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
/** 盒子标题栏高度（与 JSX 里的 h-8 一致）：算挂件自动高度时要把它加回去 */
const BOX_HEADER_H = 32;
/** 盒子边框高度（上 + 下，border-box 下高度含边框） */
const BOX_BORDER_H = 2;

/**
 * 缩放手柄方向。
 *
 * V35（用户反馈「右边和下边都可以，现在只有右下角才可以拉」）：补齐**四边 + 四角**
 * 共 8 个手柄。字母含义按罗盘：`n` 上、`s` 下、`w` 左、`e` 右。
 */
type ResizeEdge = 'n' | 's' | 'w' | 'e' | 'ne' | 'nw' | 'se' | 'sw';

/**
 * 8 个缩放手柄的定位与光标（类名写成字面量，Tailwind 才扫得到）。
 *
 * 四边只占一条 6px 命中带，且**两端各留 12px 让给角手柄**（`left-3 right-3` 等），
 * 否则角上会同时命中「边」和「角」两个元素，拉起来方向会跳。
 */
const RESIZE_HANDLES: ReadonlyArray<{ edge: ResizeEdge; className: string; cursor: string }> = [
  { edge: 'n', className: 'left-3 right-3 top-0 h-1.5', cursor: 'cursor-ns-resize' },
  { edge: 's', className: 'bottom-0 left-3 right-3 h-1.5', cursor: 'cursor-ns-resize' },
  { edge: 'w', className: 'bottom-3 left-0 top-3 w-1.5', cursor: 'cursor-ew-resize' },
  { edge: 'e', className: 'bottom-3 right-0 top-3 w-1.5', cursor: 'cursor-ew-resize' },
  { edge: 'nw', className: 'left-0 top-0 h-3 w-3', cursor: 'cursor-nwse-resize' },
  { edge: 'ne', className: 'right-0 top-0 h-3 w-3', cursor: 'cursor-nesw-resize' },
  { edge: 'sw', className: 'bottom-0 left-0 h-3 w-3', cursor: 'cursor-nesw-resize' },
  { edge: 'se', className: 'bottom-0 right-0 h-3 w-3', cursor: 'cursor-nwse-resize' },
];

/** 一次布局交互（移动 / 缩放）的会话状态 */
interface Interaction {
  kind: 'move' | 'resize';
  boxId: number;
  /** `kind='resize'` 时表示拉的是哪条边/哪个角 */
  edge: ResizeEdge | null;
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

/**
 * 卡片磨砂底色（内联渐变，跟着 `accent` 走）。
 *
 * 取「同色系深底 + 中等透明度」：透明度太高（V34 的 0.045 白）会让前景文字和壁纸
 * 混在一起、看着发虚，用户反馈的「有点模糊」正是这个；太低又变成一块黑砖、失去
 * 「融入桌面」的感觉。0.62 → 0.46 的竖向渐变兼顾两头：上半部更实（标题读得清），
 * 下半部略透（露出壁纸走向），配合顶部 1px 高光就有了「玻璃」的厚度感。
 */
function cardBackground(accent: GridAccent): string {
  /** 各配色的底色 RGB（深色，保证白色文字对比度 ≥ 7:1） */
  const tint: Record<GridAccent, string> = {
    '': '12,14,22',
    amber: '26,19,9',
    rose: '30,12,20',
    sky: '9,18,30',
    emerald: '8,24,18',
    violet: '20,13,30',
    slate: '16,18,23',
  };
  const rgb = tint[accent] ?? tint[''];
  return `linear-gradient(180deg, rgba(${rgb},0.62), rgba(${rgb},0.46))`;
}

/** 编辑态描边：用配色染一下，一眼看出这格是哪个颜色 */
function accentRing(accent: GridAccent): string {
  const ring: Record<GridAccent, string> = {
    '': 'ring-1 ring-sky-300/45',
    amber: 'ring-1 ring-amber-300/60',
    rose: 'ring-1 ring-rose-300/60',
    sky: 'ring-1 ring-sky-300/60',
    emerald: 'ring-1 ring-emerald-300/60',
    violet: 'ring-1 ring-violet-300/60',
    slate: 'ring-1 ring-slate-200/55',
  };
  return ring[accent] ?? ring[''];
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
  /** 正在挑选配色的格子 id（V35：多个便签并存时用来区分） */
  const [accentBoxId, setAccentBoxId] = useState<number | null>(null);
  /**
   * 格子右键菜单（V35 借鉴腾讯桌面整理的操作面板）。
   *
   * 为什么要有：格子的能力已经不少（重命名 / 配色 / 解散 / 新建同款），但**入口都是
   * 「先解锁布局、再找标题栏上的小按钮」** —— 用户原话是「我都搞不懂」。右键就直接
   * 列出来，不用先切模式，这是桌面上最本能的一个动作。
   */
  const [menuBox, setMenuBox] = useState<{ id: number; x: number; y: number } | null>(null);

  /** 渲染无关的可变状态（事件回调内读取，避免闭包过期） */
  const boxesRef = useRef<GridBox[]>([]);
  const scaleRef = useRef(1);
  const interactionRef = useRef<Interaction | null>(null);
  /** 进行中的条目内部拖拽（null = 没有正在拖的条目） */
  const itemDragRef = useRef<ItemDrag | null>(null);
  const hintTimerRef = useRef<number | undefined>(undefined);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  /** 空态卡片的 DOM 引用：它也要纳入命中区域，否则「创建第一个盒子」按钮点不到 */
  const emptyRef = useRef<HTMLDivElement | null>(null);
  /** 各挂件最近一次上报的「内容自然高度」：用户手动拉过之后据此判断内容有没有变 */
  const lastNaturalRef = useRef<Map<number, number>>(new Map());
  /**
   * 「用户手动定过高度」的挂件：`boxId → 当时的内容自然高度`。
   *
   * 自动撑高和手动缩放会互相打架 —— 用户把日历拉矮，撑高逻辑立刻又把它顶回去。
   * 规则：手动拉过之后**先听用户的**；等这份内容真的变了（自然高度变了），
   * 自动撑高才重新接管。这样两边都合理。
   */
  const autoHeightBlockedRef = useRef<Map<number, number>>(new Map());
  /** 挂件高度落库防抖定时器（自动撑高会连续调几次，别每次都写库） */
  const heightSaveTimerRef = useRef<number | undefined>(undefined);

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
          // 缩放：按手柄方向决定动哪几条边。
          // 拉左边 / 上边时，**原点要跟着走**（盒子是「往左长」而不是「往右缩」），
          // 且先把宽高夹到下限、再反推原点，否则拖到最小尺寸后原点会持续滑动。
          const edge = interaction.edge ?? 'se';
          let nextX = interaction.origX;
          let nextY = interaction.origY;
          let nextW = interaction.origW;
          let nextH = interaction.origH;
          if (edge.includes('e')) {
            nextW = Math.max(interaction.origW + dx, MIN_BOX_W);
          }
          if (edge.includes('s')) {
            nextH = Math.max(interaction.origH + dy, MIN_BOX_H);
          }
          if (edge.includes('w')) {
            nextW = Math.max(interaction.origW - dx, MIN_BOX_W);
            nextX = interaction.origX + (interaction.origW - nextW);
          }
          if (edge.includes('n')) {
            nextH = Math.max(interaction.origH - dy, MIN_BOX_H);
            nextY = interaction.origY + (interaction.origH - nextH);
          }
          return {
            ...box,
            posX: Math.max(nextX, 0),
            posY: Math.max(nextY, 0),
            width: nextW,
            height: nextH,
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
      // 手动缩放过挂件 → 记录「此时的内容自然高度」，自动撑高先让位（见 autoHeightBlockedRef）
      if (interaction.kind === 'resize') {
        const target = boxesRef.current.find((box) => box.id === interaction.boxId);
        if (target && (target.kind === 'calendar' || target.kind === 'note')) {
          const natural = lastNaturalRef.current.get(target.id);
          if (natural !== undefined) {
            autoHeightBlockedRef.current.set(target.id, natural);
          }
        }
      }
      persistBoxGeometry(interaction.boxId);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [persistBoxGeometry]);

  /**
   * 把被操作的格子提到最上层。
   *
   * 格子是绝对定位、可以互相叠的（靠右自动流 + 手动拖动），叠起来之后**下面那个
   * 就点不到了** —— 所以每次开始拖 / 拉之前先把它抬起来（`sort` 取全表最大值 + 1）。
   * 只在「交互开始」时抬，不做成「点一下就抬」：后者会让每次单击都写一次数据库。
   */
  const raiseBox = useCallback((box: GridBox): void => {
    const list = boxesRef.current;
    const maxSort = list.reduce((acc, item) => Math.max(acc, item.sort), 0);
    if (box.sort >= maxSort) {
      return; // 已经在最上层
    }
    const nextSort = maxSort + 1;
    setBoxes((prev) =>
      prev.map((item) => (item.id === box.id ? { ...item, sort: nextSort } : item)),
    );
    void ipc.gridBoxUpsert({ boxId: box.id, sort: nextSort }).catch(() => undefined);
  }, []);

  const startMove = useCallback(
    (event: React.MouseEvent, box: GridBox): void => {
      event.preventDefault();
      raiseBox(box);
      interactionRef.current = {
        kind: 'move',
        boxId: box.id,
        edge: null,
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
    [raiseBox],
  );

  const startResize = useCallback(
    (event: React.MouseEvent, box: GridBox, edge: ResizeEdge): void => {
      if (!editMode) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      raiseBox(box);
      interactionRef.current = {
        kind: 'resize',
        boxId: box.id,
        edge,
        startX: event.clientX,
        startY: event.clientY,
        origX: box.posX,
        origY: box.posY,
        origW: box.width,
        origH: box.height,
      };
      void ipc.gridSetInteractive(true).catch(() => undefined);
    },
    [editMode, raiseBox],
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
   * V34 曾按用户要求把同类挂件限成一个；**V35 用户改口**：「便签应该可以添加多个」。
   * 于是这里拆成两条规则：
   *   - **便签可以多个**：按 便签 / 便签 2 / 便签 3… 自动起名，并给一个**不同的默认配色**
   *     （多个便签如果长得一模一样，桌面上根本分不清）——点标题栏的调色盘可随时改；
   *   - **日历仍然只有一个**：日历背后是同一份 `todos`，多开纯粹是重复信息。
   */
  const addWidget = useCallback(
    (kind: 'note' | 'calendar'): void => {
      if (kind === 'calendar') {
        const existing = boxesRef.current.find((box) => box.kind === 'calendar');
        if (existing) {
          showHint('日历挂件已经有一个了，直接用它就好');
          return;
        }
      }
      const sameKind = boxesRef.current.filter((box) => box.kind === kind).length;
      const preset =
        kind === 'note'
          ? {
              // 第 1 个叫「便签」，之后顺延编号 —— 名字是给人看的，不该出现「便签 1」
              name: sameKind === 0 ? '便签' : `便签 ${sameKind + 1}`,
              width: 260,
              height: 220,
              // 轮着给配色，保证相邻两个便签颜色不同
              accent: ACCENT_ORDER[(sameKind % (ACCENT_ORDER.length - 1)) + 1] ?? 'amber',
            }
          : { name: '日历 · 今日计划', width: 360, height: 430, accent: '' as GridAccent };
      void ipc
        .gridBoxUpsert({
          name: preset.name,
          kind,
          accent: kind === 'note' ? (preset.accent as GridAccent) : null,
          width: preset.width,
          height: preset.height,
        })
        .then((created) => {
          setBoxes((prev) => [...prev, created]);
          setItems((prev) => ({ ...prev, [created.id]: [] }));
          showHint(
            kind === 'note'
              ? `已新建${created.name}（支持 Markdown，边写边渲染）`
              : '已新建日历挂件（含今日计划，与工作台共用数据）',
          );
        })
        .catch((error: Error) => showHint(error.message));
    },
    [showHint],
  );

  /** 改格子配色（便签尤其需要：多个便签并存时要一眼分清） */
  const setAccent = useCallback(
    (boxId: number, accent: GridAccent): void => {
      setAccentBoxId(null);
      setBoxes((prev) => prev.map((box) => (box.id === boxId ? { ...box, accent } : box)));
      void ipc.gridBoxUpsert({ boxId, accent }).catch((error: Error) => showHint(error.message));
    },
    [showHint],
  );

  /**
   * 挂件上报「内容自然高度」→ 把盒子高度调到刚好装下（V35 用户要求：
   * 「日历下面的计划部分可以根据计划条数多少动态扩展高度」）。
   *
   * 三条护栏，缺一不可：
   *   ① 正在拖 / 拉这个格子 → 让位给人；
   *   ② 用户手动定过高度、且内容没变 → 让位给人（见 `autoHeightBlockedRef`）；
   *   ③ 变化小于 8px → 不动（防亚像素抖动来回写库）。
   * 上限取屏幕高度的 70%，免得计划特别多时把格子撑到屏幕外。
   */
  const applyWidgetHeight = useCallback((boxId: number, natural: number): void => {
    lastNaturalRef.current.set(boxId, natural);
    if (interactionRef.current?.boxId === boxId) {
      return;
    }
    const blocked = autoHeightBlockedRef.current.get(boxId);
    if (blocked !== undefined && Math.abs(blocked - natural) < 8) {
      return;
    }
    const box = boxesRef.current.find((item) => item.id === boxId);
    if (!box) {
      return;
    }
    const maxH = Math.max(Math.round(window.innerHeight * 0.7), MIN_BOX_H);
    const target = Math.min(
      Math.max(Math.round(natural + BOX_HEADER_H + BOX_BORDER_H), MIN_BOX_H),
      maxH,
    );
    if (Math.abs(target - box.height) < 8) {
      return;
    }
    autoHeightBlockedRef.current.delete(boxId);
    setBoxes((prev) => prev.map((item) => (item.id === boxId ? { ...item, height: target } : item)));
    if (heightSaveTimerRef.current !== undefined) {
      window.clearTimeout(heightSaveTimerRef.current);
    }
    heightSaveTimerRef.current = window.setTimeout(() => {
      heightSaveTimerRef.current = undefined;
      void ipc.gridBoxUpsert({ boxId, height: target }).catch(() => undefined);
    }, 400);
  }, []);

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
   * 日历挂件仍然唯一（日历背后是同一份 `todos`，多开只是重复信息）；
   * 便签 V35 起可以多个，所以不再置灰。
   */
  const hasCalendar = boxes.some((box) => box.kind === 'calendar');

  /** 新建一个与模板同款（同尺寸、同配色）的收纳格。 */
  const duplicateBox = useCallback(
    (template: GridBox): void => {
      void ipc
        .gridBoxUpsert({
          name: `${template.name} 副本`,
          kind: 'folder',
          accent: template.accent,
          width: template.width,
          height: template.height,
        })
        .then((created) => {
          setBoxes((prev) => [...prev, created]);
          setItems((prev) => ({ ...prev, [created.id]: [] }));
          showHint(`已新建收纳格：${created.name}`);
        })
        .catch((error: Error) => showHint(error.message));
    },
    [showHint],
  );

  /**
   * 右键菜单的关闭时机。
   *
   * 注意**不能**只靠「在菜单上 stopPropagation 就完事」：菜单是 React 节点，
   * 而这里挂的是 window 上的原生监听，原生事件照样会冒泡到 window。
   * 所以用 ref 判一下点击是不是落在菜单内部。
   */
  useEffect(() => {
    if (menuBox === null) {
      return undefined;
    }
    const onDown = (event: MouseEvent): void => {
      if (menuRef.current?.contains(event.target as Node) === true) {
        return;
      }
      setMenuBox(null);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setMenuBox(null);
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuBox]);

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
              // 非编辑态：给卡片铺一层**深色磨砂底**。为什么用内联 style 而不是
              // Tailwind 类：底色要跟着 `accent` 走（7 种组合），内联渐变最直白，
              // 也不必担心 JIT 扫不到动态拼出来的类名。
              background: editMode ? undefined : cardBackground(box.accent),
            }}
            /* 观感目标（用户原话）：「桌面就是一个大容器，格子就是大容器里面的小容器，
               自然嵌入在桌面上」「像在壁纸上画了一张图」。
               V35 用户又说「背景透明后有点模糊，增加对比度」—— 于是这一版把
               「几乎看不见的浅雾」换成**深色磨砂**：底色确有厚度（前景文字对比度够高），
               但仍透出壁纸；**没有硬边框**，靠「顶部一道极淡的高光 + 大范围柔和外阴影」
               把边缘融进桌面 —— 像贴在壁纸上的一张毛玻璃卡，而不是浮起来的白面板。 */
            className={`absolute flex flex-col overflow-hidden rounded-2xl text-neutral-100 ${
              editMode
                ? 'border border-dashed bg-neutral-900/55 backdrop-blur-md'
                : 'shadow-[0_10px_30px_rgba(0,0,0,0.34),inset_0_1px_0_rgba(255,255,255,0.09)] backdrop-blur-lg backdrop-saturate-150'
            } ${isDropTarget ? 'ring-2 ring-sky-300/85' : editMode ? accentRing(box.accent) : ''}`}
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
            onMouseDown={(event) => {
              // 编辑态：**从格子任意空白处都能拖动**（不只是 32px 高的标题栏）。
              // 条目元素带 data-grid-item，交给它们自己的拖拽/双击逻辑。
              if (!editMode) {
                return;
              }
              const target = event.target as HTMLElement | null;
              if (target?.closest('[data-grid-item="1"]')) {
                return;
              }
              if (target?.closest('button,input,[contenteditable="true"]')) {
                return;
              }
              startMove(event, box);
            }}
            onContextMenu={(event) => {
              // 借鉴腾讯桌面整理：右键格子直接出操作面板，不必先解锁布局再找小按钮。
              // 用 clientX/clientY —— 根容器是 fixed inset-0，和视口是同一套坐标。
              event.preventDefault();
              setAccentBoxId(null);
              setMenuBox({ id: box.id, x: event.clientX, y: event.clientY });
            }}
          >
            {/* 标题栏：拖拽移动（随时可用）+ 双击重命名 */}
            <header
              onMouseDown={(event) => startMove(event, box)}
              onDoubleClick={() => beginRename(box)}
              className="flex h-8 shrink-0 cursor-move items-center gap-1 px-2 active:cursor-grabbing"
              title="拖拽移动 · 双击重命名标题"
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
                  className={`min-w-0 flex-1 truncate text-xs font-semibold [text-shadow:0_1px_2px_rgba(0,0,0,0.75)] ${
                    editMode ? 'opacity-95' : 'opacity-85'
                  }`}
                >
                  {box.name}
                </span>
              )}
              {/* 配色（便签最爱用：多个便签靠颜色区分） */}
              {editMode ? (
                <button
                  type="button"
                  title="换个配色"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={() => setAccentBoxId((prev) => (prev === box.id ? null : box.id))}
                  className="shrink-0 rounded p-0.5 opacity-80 transition hover:bg-white/20 hover:opacity-100"
                >
                  <Palette className="h-3 w-3" />
                </button>
              ) : null}
              {editMode && !isWidget ? (
                <button
                  type="button"
                  title="填路径收纳（也会把文件移动进格子目录）"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={() => beginAddPath(box.id)}
                  className="shrink-0 rounded p-0.5 opacity-80 transition hover:bg-white/20 hover:opacity-100"
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
                  className="shrink-0 rounded p-0.5 opacity-80 transition hover:bg-red-500/80 hover:opacity-100"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              ) : null}
              {isWidget ? (
                box.kind === 'note' ? (
                  <StickyNote
                    className="h-3.5 w-3.5 shrink-0"
                    style={{ color: NOTE_ACCENTS[box.accent]?.hex ?? NOTE_ACCENTS[''].hex }}
                  />
                ) : (
                  <CalendarDays className="h-3.5 w-3.5 shrink-0 opacity-60" />
                )
              ) : (
                <span className="shrink-0 text-[10px] opacity-55">{boxItems.length}</span>
              )}
            </header>

            {/* 配色选择器（编辑态点调色盘展开） */}
            {editMode && accentBoxId === box.id ? (
              <div
                className="flex shrink-0 items-center gap-1 border-b border-white/15 px-2 py-1"
                onMouseDown={(event) => event.stopPropagation()}
              >
                {ACCENT_ORDER.map((key) => (
                  <button
                    key={key || 'default'}
                    type="button"
                    title={NOTE_ACCENTS[key].label}
                    onClick={() => setAccent(box.id, key)}
                    style={{ background: NOTE_ACCENTS[key].hex }}
                    className={`h-4 w-4 rounded-full transition hover:scale-110 ${
                      box.accent === key
                        ? 'ring-2 ring-sky-300'
                        : 'ring-1 ring-white/30'
                    }`}
                  />
                ))}
                <span className="ml-1 text-[10px] opacity-75">{NOTE_ACCENTS[box.accent].label}</span>
              </div>
            ) : null}

            {/* 挂件（便签 / 日历）：内容自管，不参与收纳对账 */}
            {box.kind === 'note' ? (
              <div className="min-h-0 flex-1" data-grid-item="1">
                <NoteWidget
                  boxId={box.id}
                  content={box.content}
                  accent={box.accent}
                  onSave={saveBoxContent}
                />
              </div>
            ) : box.kind === 'calendar' ? (
              <div className="min-h-0 flex-1" data-grid-item="1">
                {/* 日历上报内容自然高度 → 盒子跟着撑开/收拢（用户要求：计划条数多少
                    动态扩展高度，不再把计划压成一个要滚的小窗口）。 */}
                <CalendarWidget
                  onContentHeight={(natural) => applyWidgetHeight(box.id, natural)}
                />
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
                  data-grid-item="1"
                  title={`${item.displayName}\n${item.filePath}\n双击打开 · 拖到其他格子移动 · 右上角 × 移回桌面`}
                  draggable
                  onDragStart={(event) => startItemDrag(item, event)}
                  onDragEnd={endItemDrag}
                  onDoubleClick={() => openItem(item)}
                  className="group relative flex cursor-pointer flex-col items-center gap-1 rounded-lg p-1.5 transition hover:bg-white/15"
                >
                  <button
                    type="button"
                    title="移出格子：文件回到桌面（不是删除）"
                    onClick={() => removeItem(item)}
                    className="absolute right-0.5 top-0.5 hidden rounded bg-black/60 p-0.5 text-neutral-100 hover:bg-red-500/85 group-hover:block"
                  >
                    <X className="h-3 w-3" />
                  </button>
                  <FileIcon path={item.filePath} />
                  <span className="w-full truncate text-center text-[11px] font-medium leading-tight text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.95)]">
                    {item.displayName}
                  </span>
                </div>
              ))}
              {boxItems.length === 0 && (
                <p className="col-span-full py-3 text-center text-[11px] leading-relaxed opacity-55">
                  把文件拖到这里收纳
                  <br />
                  文件会移动进 桌面/Handy整理/{box.name}
                </p>
              )}
              </div>
            )}

            {/* 缩放手柄（仅编辑态）：**四边 + 四角**，不再只有右下角一个。
                V35 用户原话：「格子拉升缩放大小，右边和下边都可以，现在只有右下角才可以拉」。
                四边的命中带避开四个角（角上各有自己的手柄），免得互相抢。 */}
            {editMode
              ? RESIZE_HANDLES.map(({ edge, className, cursor }) => (
                  <div
                    key={edge}
                    onMouseDown={(event) => startResize(event, box, edge)}
                    title="拖拽调整大小"
                    className={`absolute z-10 ${className} ${cursor}`}
                  />
                ))
              : null}
            {/* 角上手柄画一个小折角，给个「这里能拉」的视觉提示 */}
            {editMode ? (
              <svg
                viewBox="0 0 16 16"
                aria-hidden
                className="pointer-events-none absolute bottom-0 right-0 z-10 h-4 w-4 text-white/60"
              >
                <path d="M14 14L7 14M14 14L14 7" stroke="currentColor" strokeWidth="1.5" fill="none" />
              </svg>
            ) : null}
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

      {/* 格子右键菜单（V35）。借鉴腾讯桌面整理：所有格子操作都在这里，不必先解锁布局。 */}
      {menuBox !== null &&
        (() => {
          const box = boxes.find((item) => item.id === menuBox.id);
          if (box === undefined) {
            return null;
          }
          const isFolder = box.kind === 'folder';
          const rowClass =
            'flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition hover:bg-white/10';
          return (
            <div
              key="grid-box-menu"
              ref={menuRef}
              style={{ left: menuBox.x, top: menuBox.y, pointerEvents: 'auto' }}
              className="absolute z-50 w-48 overflow-hidden rounded-lg bg-neutral-900/95 py-1 text-xs text-neutral-100 shadow-2xl ring-1 ring-white/15 backdrop-blur"
            >
              <div className="truncate px-2.5 pb-1 pt-0.5 text-[10px] text-neutral-400">
                {box.name}
              </div>
              <button
                type="button"
                className={rowClass}
                onClick={() => {
                  const target = box;
                  setMenuBox(null);
                  beginRename(target);
                }}
              >
                重命名格子
              </button>
              {isFolder ? (
                <button
                  type="button"
                  className={rowClass}
                  onClick={() => {
                    const target = box;
                    setMenuBox(null);
                    duplicateBox(target);
                  }}
                >
                  新建同款格子
                </button>
              ) : (
                <button
                  type="button"
                  className={rowClass}
                  onClick={() => {
                    setMenuBox(null);
                    addWidget(box.kind === 'note' ? 'note' : 'calendar');
                  }}
                >
                  {box.kind === 'note' ? '再加一个便签' : '日历只有一个'}
                </button>
              )}
              <div className="px-2.5 pb-0.5 pt-1.5 text-[10px] text-neutral-400">配色</div>
              <div className="flex flex-wrap gap-1 px-2.5 pb-1.5">
                {ACCENT_ORDER.map((key) => (
                  <button
                    key={key || 'default'}
                    type="button"
                    title={NOTE_ACCENTS[key].label}
                    aria-label={`配色 ${NOTE_ACCENTS[key].label}`}
                    onClick={() => {
                      setAccent(box.id, key);
                    }}
                    style={{ background: NOTE_ACCENTS[key].hex }}
                    className={`h-4 w-4 rounded-full ring-1 ring-white/25 transition hover:scale-110 ${
                      box.accent === key ? 'ring-2 ring-sky-300' : ''
                    }`}
                  />
                ))}
              </div>
              <div className="my-1 h-px bg-white/10" />
              <button
                type="button"
                className={`${rowClass} text-rose-300`}
                onClick={() => {
                  const target = box.id;
                  setMenuBox(null);
                  deleteBox(target);
                }}
              >
                解散该格子
              </button>
              <p className="px-2.5 pb-1 pt-0.5 text-[10px] leading-relaxed text-neutral-500">
                解散只删格子，「桌面/Handy整理/{box.name}/」里的文件原样保留
              </p>
            </div>
          );
        })()}

      {/* 提示条（非交互文本） */}
      {hint && (        <div className="absolute left-1/2 top-4 -translate-x-1/2 rounded-md bg-neutral-900/80 px-3 py-1.5 text-xs text-neutral-100 shadow-lg backdrop-blur">
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
          title="添加便签（Markdown 边写边渲染，自动保存；可以加多个，各选一种颜色）"
          className="rounded-full p-1.5 text-neutral-200 transition hover:bg-white/10"
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
