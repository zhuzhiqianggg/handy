/**
 * 桌面网格挂件类型（与 Rust `commands/grid.rs` serde camelCase 一一对应）。
 *
 * 数据契约三方一致：迁移 SQL（`src-tauri/src/db/migrations.rs` v4）
 * = Rust 结构体（`src-tauri/src/commands/grid.rs`）= 本文件。
 *
 * 核心语义：条目（GridItem）只是**原文件路径的引用**——文件绝不被移动、
 * 复制或重命名；打开经 shell 唤起系统默认程序作用于原文件。
 */

/** 盒子（`itemCount` 来自 grid_box_list 的条目计数子查询） */
export interface GridBox {
  id: number;
  name: string;
  /** 几何均为逻辑像素（相对挂件窗客户区左上角） */
  posX: number;
  posY: number;
  width: number;
  height: number;
  sort: number;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 挂件条目：原文件路径的引用 */
export interface GridItem {
  id: number;
  boxId: number;
  /** 原文件的绝对路径（只读引用，永不修改） */
  filePath: string;
  displayName: string;
  sort: number;
  createdAt: string;
}

/** 盒子创建 / 更新入参（缺省字段由 Rust 侧补默认值；更新仅写传入字段） */
export interface GridBoxInput {
  /** 缺省 = 创建新盒子 */
  boxId?: number | null;
  name?: string | null;
  posX?: number | null;
  posY?: number | null;
  width?: number | null;
  height?: number | null;
  sort?: number | null;
}

/** 挂件窗几何（逻辑像素，持久化在 grid_meta） */
export interface GridGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 光标命中区域（挂件窗客户区内**物理像素**，前端按 scaleFactor 换算后上报）。
 * Rust 光标轮询线程据此决定挂件窗何时从点击穿透切回可交互。
 */
export interface GridRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

// —— 一键整理 / 布局备份与还原（V19）——

/** 一键整理结果摘要 */
/** 桌面同步报告 = 一键整理结果 + 失效引用清理数（`grid_desktop_sync` 返回） */
export interface DesktopSyncReport extends AutoArrangeReport {
  /** 本次清理的失效引用数（桌面文件已被删除 / 移走） */
  pruned: number;
}

export interface AutoArrangeReport {
  /** 桌面上扫描到的可见条目数（隐藏 / 系统文件与符号链接已排除） */
  scanned: number;
  /** 本次新建的格子数 */
  boxesCreated: number;
  /** 复用了同名已有格子的次数 */
  boxesReused: number;
  /** 新登记的条目引用数 */
  itemsAdded: number;
  /** 已在格子中、本次跳过的分组数 */
  skipped: number;
}

/** 布局快照里的单条引用 */
export interface LayoutItem {
  filePath: string;
  displayName: string;
  sort: number;
}

/** 布局快照里的单个格子 */
export interface LayoutBox {
  name: string;
  posX: number;
  posY: number;
  width: number;
  height: number;
  sort: number;
  items: LayoutItem[];
}

/**
 * 桌面布局快照（备份文件内容）。
 *
 * 语义：**只记录格子几何与文件引用**，不含文件内容 —— 还原布局不会回迁任何文件，
 * 因为整理本身从未移动过文件。
 */
export interface GridLayout {
  version: number;
  exportedAt: string;
  boxes: LayoutBox[];
}

/** 布局还原结果摘要 */
export interface LayoutImportReport {
  boxes: number;
  items: number;
  /** 快照指向的文件当前已不存在（引用照常恢复，打开时才提示） */
  missingFiles: number;
}

/** 布局快照摘要（「备份布局」列表用，不含完整布局体） */
export interface LayoutSnapshotMeta {
  id: string;
  name: string;
  savedAt: string;
  boxCount: number;
  itemCount: number;
}

