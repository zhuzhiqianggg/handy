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
  GridBox,
  GridBoxInput,
  GridGeometry,
  GridItem,
  GridRegion,
} from '@/types/grid';
import type {
  VaultItem,
  VaultItemInput,
  VaultItemPatch,
  VaultStatus,
} from '@/types/vault';

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

  // —— 桌面网格挂件（M2 改版：文件引用型，绝不移动文件）——

  /** 盒子列表（含条目计数） */
  gridBoxList: (): Promise<GridBox[]> => call<GridBox[]>('grid_box_list'),
  /** 创建（boxId 缺省）或更新盒子（几何 / 名称 / 排序），返回落库后的完整实体 */
  gridBoxUpsert: (input: GridBoxInput): Promise<GridBox> =>
    call<GridBox>('grid_box_upsert', {
      boxId: input.boxId ?? null,
      name: input.name ?? null,
      posX: input.posX ?? null,
      posY: input.posY ?? null,
      width: input.width ?? null,
      height: input.height ?? null,
      sort: input.sort ?? null,
    }),
  /** 删除盒子（级联删除其条目引用；文件本体不受影响） */
  gridBoxDelete: (boxId: number): Promise<void> => call<void>('grid_box_delete', { boxId }),
  /** 添加条目：仅登记原文件路径引用（displayName 缺省 = 文件名） */
  gridItemAdd: (boxId: number, filePath: string, displayName?: string): Promise<GridItem> =>
    call<GridItem>('grid_item_add', { boxId, filePath, displayName: displayName ?? null }),
  /** 删除条目（仅移除引用） */
  gridItemDelete: (itemId: number): Promise<void> => call<void>('grid_item_delete', { itemId }),
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
  /** 显示（幂等）桌面挂件窗（Rust 侧创建无边框透明窗并压回桌面层） */
  gridOverlayShow: (): Promise<void> => call<void>('grid_overlay_show'),
  /** 隐藏桌面挂件窗（不销毁，盒子配置保留） */
  gridOverlayHide: (): Promise<void> => call<void>('grid_overlay_hide'),
  /** 打开条目原文件（Rust 侧 shell 插件 open；本地路径不受前端 open 作用域限制） */
  gridOpenPath: (path: string): Promise<void> => call<void>('grid_open_path', { path }),

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
