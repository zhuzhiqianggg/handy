import { invoke } from '@tauri-apps/api/core';
import { diagLog } from '@/lib/diag';
import type { PlatformInfo } from '@/types/platform';
import type { ClipItem, ClipInput } from '@/types/clipboard';
import type {
  OrganizerApplyReport,
  OrganizerPlan,
  OrganizerPlanItem,
  OrganizerRules,
  OrganizerScanResult,
  OrganizerUndoReport,
} from '@/types/organizer';
import type { BackupReport, ImportOutcome } from '@/types/backup';

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

  // —— 剪贴板（M4 / V10）——

  /** 分页读取剪贴板历史（新 → 旧） */
  clipList: (limit: number, offset: number): Promise<ClipItem[]> =>
    call<ClipItem[]>('clip_list', { limit, offset }),
  /** 翻转单条置顶状态 */
  clipTogglePin: (clipId: string): Promise<void> =>
    call<void>('clip_toggle_pin', { clipId }),
  /** 删除单条 */
  clipDelete: (clipId: string): Promise<void> => call<void>('clip_delete', { clipId }),
  /** 清空非置顶条目，返回删除条数 */
  clipClear: (): Promise<number> => call<number>('clip_clear'),
  /** 批量落库（Rust 侧去重 / 裁剪 / FTS 对账），返回处理条数 */
  clipAddBatch: (items: ClipInput[]): Promise<number> =>
    call<number>('clip_add_batch', { items }),
  /** 读取剪贴板文本兜底（navigator.clipboard.readText 不可用 / 被拒时；空返回 null） */
  clipboardReadText: (): Promise<string | null> => call<string | null>('clipboard_read_text'),
  /** 写入剪贴板文本（V11 回贴：历史条目写回系统剪贴板） */
  clipboardWriteText: (text: string): Promise<void> =>
    call<void>('clipboard_write_text', { text }),

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

  // 待办 / 剪贴板 / 桌面整理 / 授权 / 备份等命令见 ARCHITECTURE §6，
  // 随对应任务（V09/V10/V12/V13）逐步补入。
} as const;

export type Ipc = typeof ipc;
