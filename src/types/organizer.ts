/**
 * 桌面整理类型（M2 / V12）。
 *
 * 与 Rust `commands/organizer.rs` 的 serde camelCase 结构一一对应。
 * 独立成文件以避免 `lib/ipc.ts` ↔ `core/data/organizerService.ts` 相互依赖成环
 * （与 `types/clipboard.ts` 同模式）。
 */

/** 整理规则（引擎在 Rust 侧，前端只传参） */
export interface OrganizerRules {
  /** "by-type"（六类扩展名）| "by-date"（按修改月份 YYYY-MM） */
  mode: 'by-type' | 'by-date';
  /** 是否整理文件夹（by-type 恒不搬；by-date 可选开） */
  includeFolders: boolean;
}

/** 计划条目：一条待执行 / 已执行的移动 */
export interface OrganizerPlanItem {
  name: string;
  source: string;
  dest: string;
  /** 分组名（by-type 类别 / by-date "YYYY-MM"） */
  kind: string;
  size: number;
}

/** 失败 / 跳过 / 冲突明细 */
export interface OrganizerFailedMove {
  name: string;
  source: string;
  dest: string;
  reason: string;
}

/** 计划 payload（Rust `PlanPayload`） */
export interface OrganizerPlanPayload {
  rules: OrganizerRules;
  /** 目标根目录（计划锁定，如 `桌面/Handy整理`） */
  targetDir: string;
  items: OrganizerPlanItem[];
  /** apply 结果：失败明细 */
  failed: OrganizerFailedMove[];
  /** undo 已执行 */
  undone: boolean;
  /** undo 跳过/冲突明细 */
  undoSkipped: OrganizerFailedMove[];
}

/** 整理计划（`organize_plans` 行） */
export interface OrganizerPlan {
  id: string;
  payload: OrganizerPlanPayload;
  applied: boolean;
  createdAt: number;
}

/** 扫描条目 */
export interface OrganizerScanItem {
  name: string;
  path: string;
  isDir: boolean;
  isLnk: boolean;
  ext: string;
  size: number;
  mtime: number;
  category: string;
}

/** 扫描结果 */
export interface OrganizerScanResult {
  dir: string;
  items: OrganizerScanItem[];
}

/** apply 结果摘要 */
export interface OrganizerApplyReport {
  moved: number;
  failed: OrganizerFailedMove[];
}

/** undo 结果摘要 */
export interface OrganizerUndoReport {
  restored: number;
  skipped: OrganizerFailedMove[];
}
