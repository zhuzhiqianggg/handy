/**
 * 桌面网格挂件类型（与 Rust `commands/grid.rs` serde camelCase 一一对应）。
 *
 * 数据契约三方一致：迁移 SQL（`src-tauri/src/db/migrations.rs` v4 + v6）
 * = Rust 结构体（`src-tauri/src/commands/grid.rs`）= 本文件。
 *
 * 核心语义（V33 起）：格子是**真实收纳格**——它绑定一个真实目录
 * `桌面/Handy整理/<格子名>/`，拖进格子 = 真把文件移进该目录（桌面图标随之消失，
 * 因此不与桌面重复）；条目上的 × = 把文件移回桌面根目录，不是删除。
 * 默认**不自动收录**桌面任何东西，快捷方式与图标一律留在原位。
 */

/** 格子类型：收纳格 / 便签 / 日历（含今日计划）/ 系统入口 */
export type GridBoxKind = 'folder' | 'note' | 'calendar' | 'system';

/** 格子（`itemCount` 来自 grid_box_list 的条目计数子查询） */
export interface GridBox {
  id: number;
  name: string;
  /** 格子类型；非 folder 类型不绑目录，内容存在 content 里 */
  kind: GridBoxKind;
  /** 挂件自有数据（便签正文 / 日历配置 JSON）；收纳格为空串 */
  content: string;
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

/** 格子条目：指向**收纳目录里的真实文件**（文件确实住在那里） */
export interface GridItem {
  id: number;
  boxId: number;
  /** 收纳目录内的绝对路径（或系统格子的 CLSID 路径） */
  filePath: string;
  displayName: string;
  sort: number;
  createdAt: string;
}

/** 格子创建 / 更新入参（缺省字段由 Rust 侧补默认值；更新仅写传入字段） */
export interface GridBoxInput {
  /** 缺省 = 创建新格子 */
  boxId?: number | null;
  name?: string | null;
  kind?: GridBoxKind | null;
  content?: string | null;
  posX?: number | null;
  posY?: number | null;
  width?: number | null;
  height?: number | null;
  sort?: number | null;
}

/** 挂件层真实状态（管理页据此对齐「显示 / 隐藏格子」开关） */
export interface OverlayStatus {
  /** 挂件窗当前是否真的显示着 */
  visible: boolean;
  /** 挂件窗是否已创建（区分「没建过」与「建了但收起了」） */
  exists: boolean;
  /** 当前基准层：desktop（贴桌面）/ bottom（普通窗口） */
  attachMode: string;
  /** 系统桌面图标是否处于隐藏态 */
  iconsHidden: boolean;
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
/** Shell 真实图标数据（`grid_file_icon` 返回；RGBA 像素 base64） */
export interface FileIconData {
  width: number;
  height: number;
  rgbaBase64: string;
}

/** 桌面同步报告（`grid_desktop_sync` 返回）：**只对账，不收录** */
export interface DesktopSyncReport {
  /** 参与对账的收纳格数 */
  boxes: number;
  /** 收纳目录里新发现并登记的条目数（手工在资源管理器里放进格子的文件） */
  itemsAdded: number;
  /** 清理掉的失效登记数（文件已被移出 / 删除） */
  pruned: number;
}

/** 一键收纳结果摘要（`grid_auto_arrange` 返回）：真的移动了文件和文件夹 */
export interface AutoArrangeReport {
  /** 桌面根目录扫描到的可见条目数（含快捷方式 / 文件夹） */
  scanned: number;
  /** 本次真正移动进收纳目录的条目数（文件 + 文件夹） */
  itemsAdded: number;
  /** 其中文件夹占的数量（V34 起文件夹也纳入收纳） */
  foldersMoved: number;
  /** 本次新建的格子数 */
  boxesCreated: number;
  /** 复用了同名已有格子的次数 */
  boxesReused: number;
  /** 按设计跳过的条目数（只剩快捷方式 .lnk —— 用户要求留在桌面原位） */
  skipped: number;
  /** 单条目失败原因（不中断整批） */
  failures: string[];
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

