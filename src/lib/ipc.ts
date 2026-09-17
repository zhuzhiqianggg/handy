import { invoke } from '@tauri-apps/api/core';
import { diagLog } from '@/lib/diag';
import type { PlatformInfo } from '@/types/platform';
import type {
  OrganizerApplyReport,
  OrganizerPlan,
  OrganizerPlanItem,
  OrganizerRules,
  OrganizerScanResult,
  OrganizerUndoReport,
} from '@/types/organizer';
import type { BackupReport, ImportOutcome } from '@/types/backup';
import type {
  AutoArrangeReport,
  DesktopSyncReport,
  FileIconData,
  GridBox,
  GridBoxInput,
  GridGeometry,
  GridItem,
  GridLayout,
  GridRegion,
  LayoutImportReport,
  LayoutSnapshotMeta,
  OverlayStatus,
} from '@/types/grid';
import type {
  VaultItem,
  VaultItemInput,
  VaultItemPatch,
  VaultStatus,
} from '@/types/vault';
import type { SysAction } from '@/types/sys';
// 仅类型引用（`import type` 编译期擦除，不引入运行期循环依赖）
import type { Todo } from '@/core/data/todosService';

/**
 * 统一的 invoke 封装。
 *
 * 约定（TASKS §2.4）：
 * - 组件中**禁止**直接调用 `invoke`，一律经本模块；
 * - Rust 命令返回 `Result<T, String>`，此处统一归一为 `Error`，`message` 为中文可读信息。
 */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const started = performance.now();
  // 看门狗：超过 5s 未返回则记入 Handy.log（不 reject，仅诊断「永久挂起」类问题）
  let pendingLogged = false;
  const watchdog = window.setTimeout(() => {
    pendingLogged = true;
    diagLog(`ipc PENDING>5s ${cmd}`);
  }, 5000);
  try {
    const result = await invoke<T>(cmd, args);
    const ms = Math.round(performance.now() - started);
    if (ms > 1500) {
      diagLog(`ipc SLOW ${cmd} ${ms}ms`);
    }
    return result;
  } catch (error: unknown) {
    const message =
      typeof error === 'string'
        ? error
        : error instanceof Error
          ? error.message
          : String(error);
    diagLog(`ipc FAIL ${cmd} ${Math.round(performance.now() - started)}ms: ${message}`);
    throw new Error(message);
  } finally {
    if (!pendingLogged) {
      window.clearTimeout(watchdog);
    }
  }
}

export const ipc = {
  /** 平台信息与能力位（注入 `src/platform`） */
  platformInfo: (): Promise<PlatformInfo> => call<PlatformInfo>('platform_info'),

  /** 应用级：显示主面板 */
  appShowMain: (): Promise<void> => call<void>('app_show_main'),
  /** 应用级：隐藏主面板（常驻托盘） */
  appHideMain: (): Promise<void> => call<void>('app_hide_main'),
  /** 应用级：切换主面板显隐 */
  appToggleMain: (): Promise<void> => call<void>('app_toggle_main'),
  /** 应用级：退出应用 */
  appQuit: (): Promise<void> => call<void>('app_quit'),

  // —— 模块启停（V04）——

  /** 读取模块启停状态（`settings.modules`，仅显式覆盖项） */
  moduleListState: (): Promise<Record<string, boolean>> =>
    call<Record<string, boolean>>('module_list_state'),
  /** 写入单个模块启停状态（跨窗口一致） */
  moduleSetEnabled: (moduleId: string, enabled: boolean): Promise<void> =>
    call<void>('module_set_enabled', { moduleId, enabled }),

  // —— 便签（M3 / V08）——

  /**
   * 打开（或聚焦）便签独立窗口，返回窗口 label（`note-<id>`）。
   * CRUD 不经 IPC：便签是单表简单实体，前端经 `lib/db` 直连 SQLite（见 notesService）；
   * 开窗必须在 Rust 侧完成（无边框 / 几何 / 置顶），故仅此处走命令。
   */
  openNoteWindow: (noteId: string): Promise<string> =>
    call<string>('open_note_window', { noteId }),

  // —— 桌面整理（M2 / V12）——

  /** 枚举桌面条目（dir 缺省 = 用户真实桌面；显式目录仅供测试 / 自定义场景） */
  organizerScanDesktop: (dir?: string): Promise<OrganizerScanResult> =>
    call<OrganizerScanResult>('organizer_scan_desktop', { dir: dir ?? null }),
  /** 按规则生成整理计划（只算不搬；dir 缺省 = 用户真实桌面） */
  organizerPreviewPlan: (rules: OrganizerRules, dir?: string): Promise<OrganizerPlan> =>
    call<OrganizerPlan>('organizer_preview_plan', { rules, dir: dir ?? null }),
  /** 前端勾选排除后回写计划条目（仅 applied=0 的计划可改） */
  organizerUpdatePlanItems: (planId: string, items: OrganizerPlanItem[]): Promise<OrganizerPlan> =>
    call<OrganizerPlan>('organizer_update_plan_items', { planId, items }),
  /** 执行移动（前端二次确认后调用；Rust 侧再校验 applied=0） */
  organizerApply: (planId: string): Promise<OrganizerApplyReport> =>
    call<OrganizerApplyReport>('organizer_apply', { planId }),
  /** 逆序撤销已应用计划 */
  organizerUndo: (planId: string): Promise<OrganizerUndoReport> =>
    call<OrganizerUndoReport>('organizer_undo', { planId }),
  /** 历史计划列表（含 applied / undone 状态） */
  organizerListPlans: (): Promise<OrganizerPlan[]> =>
    call<OrganizerPlan[]>('organizer_list_plans'),

  // —— 设置中心 / 备份（M7 / V13）——

  /** 重注册全局快捷键（注册失败返回错误，前端不落盘并回滚显示） */
  hotkeyUpdate: (hotkey: string): Promise<void> =>
    call<void>('hotkey_update', { hotkey }),
  /** 导出备份（targetDir 由用户经 dialog 选择后传入） */
  backupExport: (targetDir: string): Promise<BackupReport> =>
    call<BackupReport>('backup_export', { targetDir }),
  /** 导入备份（校验 + 写 pending 标记；重启应用生效） */
  backupImport: (sourceDir: string): Promise<ImportOutcome> =>
    call<ImportOutcome>('backup_import', { sourceDir }),

  // —— 密码存储器（M5 / vault）——

  /** 查询密码库状态（是否已初始化 / 是否已解锁） */
  vaultStatus: (): Promise<VaultStatus> => call<VaultStatus>('vault_status'),
  /** 首次设置主密码（已初始化时报错；成功后进入解锁态） */
  vaultSetup: (masterPassword: string): Promise<VaultStatus> =>
    call<VaultStatus>('vault_setup', { masterPassword }),
  /** 解锁（主密码错误返回中文错误） */
  vaultUnlock: (masterPassword: string): Promise<VaultStatus> =>
    call<VaultStatus>('vault_unlock', { masterPassword }),
  /** 锁定（清除后端内存中的密钥） */
  vaultLock: (): Promise<void> => call<void>('vault_lock'),
  /** 列出全部条目（逐字段解密；锁定态报错「密码库已锁定」） */
  vaultList: (): Promise<VaultItem[]> => call<VaultItem[]>('vault_list'),
  /** 新建条目（明文仅在传输中，落库前由 Rust 侧逐字段加密） */
  vaultCreate: (input: VaultItemInput): Promise<VaultItem> =>
    call<VaultItem>('vault_create', { input }),
  /** 更新条目（仅传入需修改的字段） */
  vaultUpdate: (itemId: number, patch: VaultItemPatch): Promise<VaultItem> =>
    call<VaultItem>('vault_update', { itemId, patch }),
  /** 删除条目 */
  vaultDelete: (itemId: number): Promise<void> => call<void>('vault_delete', { itemId }),

  // —— 待办（桌面日历挂件「今日计划」用；同一张 todos 表，与工作台共用） ——

  /** 待办列表（未完成优先、优先级高优先、到期近者优先） */
  todosList: (): Promise<Todo[]> => call<Todo[]>('todos_list'),
  /** 切换待办完成态 */
  todosToggleDone: (todoId: string, done: boolean): Promise<Todo> =>
    call<Todo>('todos_toggle_done', { todoId, done }),
  /** 新建待办 */
  todosCreate: (title: string, dueAt?: number | null): Promise<Todo> =>
    call<Todo>('todos_create', { input: { title, dueAt: dueAt ?? null } }),

  // —— 桌面格子（V33 真实收纳：拖进去 = 真把文件移进 桌面/Handy整理/<格子名>/）——

  /** 格子列表（含条目计数） */
  gridBoxList: (): Promise<GridBox[]> => call<GridBox[]>('grid_box_list'),
  /** 创建（boxId 缺省）或更新格子（名称 / 类型 / 挂件数据 / 几何 / 排序） */
  gridBoxUpsert: (input: GridBoxInput): Promise<GridBox> =>
    call<GridBox>('grid_box_upsert', {
      boxId: input.boxId ?? null,
      name: input.name ?? null,
      kind: input.kind ?? null,
      content: input.content ?? null,
      accent: input.accent ?? null,
      posX: input.posX ?? null,
      posY: input.posY ?? null,
      width: input.width ?? null,
      height: input.height ?? null,
      sort: input.sort ?? null,
    }),
  /** 删除格子（收纳目录里还有文件则原样保留，只有空目录才顺手删掉） */
  gridBoxDelete: (boxId: number): Promise<void> => call<void>('grid_box_delete', { boxId }),
  /** 写挂件数据（便签正文 / 日历配置 JSON） */
  gridBoxSetContent: (boxId: number, content: string): Promise<void> =>
    call<void>('grid_box_set_content', { boxId, content }),

  // —— 桌面整理：一键整理 / 布局备份与还原（V19）——

  /**
   * 一键收纳桌面：普通文件按类型**移动**进 `桌面/Handy整理/<类别>/`，每类一个格子。
   * 快捷方式与文件夹不动（留在桌面默认位置）。
   */
  gridAutoArrange: (dir?: string | null): Promise<AutoArrangeReport> =>
    call<AutoArrangeReport>('grid_auto_arrange', { dir: dir ?? null }),
  /** 导出当前桌面布局快照（备份用；只含几何与路径引用，不含文件内容） */
  gridLayoutExport: (): Promise<GridLayout> => call<GridLayout>('grid_layout_export'),
  /** 从布局快照还原（替换式：先清空现有格子，再按快照重建） */
  gridLayoutImport: (layout: GridLayout): Promise<LayoutImportReport> =>
    call<LayoutImportReport>('grid_layout_import', { layout }),
  /** 把当前布局备份成一份本机快照 */
  gridLayoutSave: (name?: string | null): Promise<LayoutSnapshotMeta> =>
    call<LayoutSnapshotMeta>('grid_layout_save', { name: name ?? null }),
  /** 列出全部布局快照（含「还原前自动备份」） */
  gridLayoutList: (): Promise<LayoutSnapshotMeta[]> =>
    call<LayoutSnapshotMeta[]>('grid_layout_list'),
  /** 从某份快照还原布局（还原前会自动备份当前布局） */
  gridLayoutRestore: (snapshotId: string): Promise<LayoutImportReport> =>
    call<LayoutImportReport>('grid_layout_restore', { snapshotId }),
  /** 删除一份布局快照 */
  gridLayoutDelete: (snapshotId: string): Promise<void> =>
    call<void>('grid_layout_delete', { snapshotId }),
  /**
   * 把文件放进格子 = **真的把文件移进**该格子的收纳目录（同名不覆盖，冲突改名）。
   * displayName 缺省 = 文件名。
   */
  gridItemAdd: (boxId: number, filePath: string, displayName?: string): Promise<GridItem> =>
    call<GridItem>('grid_item_add', { boxId, filePath, displayName: displayName ?? null }),
  /** 把条目移出格子：**文件移回桌面根目录**（不是删除），随后清掉登记 */
  gridItemDelete: (itemId: number, dismiss?: boolean): Promise<void> =>
    call<void>('grid_item_delete', { itemId, dismiss: dismiss ?? null }),
  /** 移动条目到另一个格子 = 真的把文件移到目标格子的收纳目录 */
  gridItemMove: (itemId: number, targetBoxId: number): Promise<void> =>
    call<void>('grid_item_move', { itemId, targetBoxId }),
  /** 桌面同步：**只对账**（按目录补齐 / 清理登记），不自动收录桌面文件 */
  gridDesktopSync: (): Promise<DesktopSyncReport> => call<DesktopSyncReport>('grid_desktop_sync'),
  /** 某盒子的条目列表 */
  gridItemList: (boxId: number): Promise<GridItem[]> => call<GridItem[]>('grid_item_list', { boxId }),
  /** 读取挂件窗几何（无记录返回 null） */
  gridGeometryGet: (): Promise<GridGeometry | null> =>
    call<GridGeometry | null>('grid_geometry_get'),
  /** 持久化挂件窗几何（窗口 moved / resized 防抖后调用） */
  gridGeometrySet: (geo: GridGeometry): Promise<void> =>
    call<void>('grid_geometry_set', { x: geo.x, y: geo.y, width: geo.width, height: geo.height }),
  /** 交互期显式申请：true = 拖拽/缩放/重命名期间保持可交互；false = 交还光标命中轮询控制 */
  gridSetInteractive: (interactive: boolean): Promise<void> =>
    call<void>('grid_set_interactive', { interactive }),
  /** 上报命中区域（挂件窗内物理像素，Rust 光标轮询用；全量替换） */
  gridOverlayUpdateRegions: (regions: GridRegion[]): Promise<void> =>
    call<void>('grid_overlay_update_regions', { regions }),
  /** 挂件前端心跳（每 10s；仅作诊断记录，不再触发窗口重建） */
  gridOverlayHeartbeat: (): Promise<void> => call<void>('grid_overlay_heartbeat'),
  /** 挂件前端故障上报（window.onerror / unhandledrejection） */
  gridOverlayFault: (message: string): Promise<void> =>
    call<void>('grid_overlay_fault', { message }),
  /** 读取挂件最近一次前端故障（无记录返回 null） */
  gridOverlayFaultGet: (): Promise<string | null> =>
    call<string | null>('grid_overlay_fault_get'),
  /** 显示（幂等）桌面挂件窗（Rust 侧创建无边框透明窗并压回桌面层） */
  gridOverlayShow: (): Promise<void> => call<void>('grid_overlay_show'),
  /** 隐藏桌面挂件窗（不销毁，格子配置保留） */
  gridOverlayHide: (): Promise<void> => call<void>('grid_overlay_hide'),
  /** 查询挂件层**真实状态**（唯一真相来源：窗口本身，而非前端局部 state） */
  gridOverlayStatus: (): Promise<OverlayStatus> => call<OverlayStatus>('grid_overlay_status'),
  /** 打开条目原文件（Rust 侧 shell 插件 open；本地路径不受前端 open 作用域限制） */
  gridOpenPath: (path: string): Promise<void> => call<void>('grid_open_path', { path }),
  /** 提取文件/文件夹的系统真实图标（RGBA base64）；失败或不支持返回 null */
  gridFileIcon: (path: string): Promise<FileIconData | null> =>
    call<FileIconData | null>('grid_file_icon', { path }),

  // —— 桌面层挂载 / 系统图标显隐（V20：让格子真正画在桌面上）——

  /** 读取挂件窗基准层：`desktop` = 贴到桌面（默认），`bottom` = 压到 Z 序最底 */
  gridAttachGet: (): Promise<'desktop' | 'bottom'> =>
    call<'desktop' | 'bottom'>('grid_attach_get'),
  /** 设置挂件窗基准层并立即生效（窗口未打开时只落库） */
  gridAttachSet: (mode: 'desktop' | 'bottom'): Promise<void> =>
    call<void>('grid_attach_set', { mode }),
  /** 隐藏 / 恢复系统桌面图标（返回 false = 本机找不到桌面图标视图，不支持） */
  gridDesktopIconsSet: (hidden: boolean): Promise<boolean> =>
    call<boolean>('grid_desktop_icons_set', { hidden }),
  /** 系统桌面图标当前是否可见 */
  gridDesktopIconsGet: (): Promise<boolean> => call<boolean>('grid_desktop_icons_get'),

  // —— 工作台顶部贴条（常驻桌面顶部的今日概览）——

  /** 显示（幂等）工作台顶部贴条：无边框 / 透明 / 始终置顶 / 顶部居中 */
  barShow: (): Promise<void> => call<void>('bar_show'),
  /** 隐藏贴条（不销毁，下次 bar_show 复用） */
  barHide: (): Promise<void> => call<void>('bar_hide'),
  /**
   * 调整贴条高度（逻辑像素）；锚点不变（仍顶部居中）。
   * 折叠 / 展开由前端量出内容高度后回报，Rust 侧只做区间钳制。
   */
  barSetHeight: (height: number): Promise<void> => call<void>('bar_set_height', { height }),
  /**
   * 切换贴条是否**始终置顶**（`settings.barOnTop`）。
   *
   * 与 `barPinned`（贴条开着没有）是两个维度：贴条开着但一直压在所有窗口上很碍事，
   * 关掉后贴条退化成普通窗口 —— 被别的窗口盖住，切回桌面又能看见。
   * 窗口没开着时只落设置，下次开窗由前端重新应用。
   */
  barSetPinned: (pinned: boolean): Promise<void> => call<void>('bar_set_pinned', { pinned }),
  /** 唤出主窗口并切到工作台模块（贴条上的「打开工作台」） */
  barOpenWorkstation: (): Promise<void> => call<void>('bar_open_workstation'),
  /**
   * 唤出主窗口并直接打开指定工具（V28，贴条搜索框）。
   *
   * 走「show 主窗 + handy:navigate 事件」同一套导航机制；commandId 需为
   * 工具箱命令 id（`registry.commandsOf('toolbox')` 中的条目）。
   */
  barOpenCommand: (commandId: string): Promise<void> =>
    call<void>('bar_open_command', { commandId }),

  // —— 主窗口置顶（默认关；置顶会盖住其它程序，收敛为设置项由用户自选）——

  /** 设置主窗口是否始终置顶 */
  appSetPinned: (pinned: boolean): Promise<void> => call<void>('app_set_pinned', { pinned }),

  // —— 工作台「快捷入口」：系统级动作（Rust 侧白名单制）——

  /**
   * 系统快捷动作清单。
   * 可执行目标与参数全部硬编码在 Rust 侧（`commands/sys.rs`），前端只负责渲染。
   */
  sysActionList: (): Promise<SysAction[]> => call<SysAction[]>('sys_action_list'),
  /** 执行一个系统快捷动作（只传动作 id；未知 id 与非法动作由 Rust 侧拒绝） */
  sysActionRun: (actionId: string): Promise<void> =>
    call<void>('sys_action_run', { actionId }),

  // —— 工作台快捷入口（workstation）——

  /**
   * 打开网址 / 本地路径（tauri-plugin-shell 的 `open` 命令；Rust 侧已注册该插件，
   * capabilities 已授予 `shell:allow-open`）。
   * 注意：`shell:allow-open` 默认作用域仅放行 http(s) / mailto / tel 链接；
   * 本地路径被默认作用域拒绝时由调用方捕获并向用户提示。
   */
  shellOpen: (path: string): Promise<void> =>
    call<void>('plugin:shell|open', { path, with: null }),

  // 待办 / 桌面整理 / 授权 / 备份等命令见 ARCHITECTURE §6，
  // 随对应任务（V09/V12/V13）逐步补入。
} as const;

export type Ipc = typeof ipc;
