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
