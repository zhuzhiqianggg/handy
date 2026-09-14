import { ipc } from '@/lib/ipc';
import type {
  OrganizerApplyReport,
  OrganizerPlan,
  OrganizerPlanItem,
  OrganizerRules,
  OrganizerScanResult,
  OrganizerUndoReport,
} from '@/types/organizer';

/**
 * 桌面整理数据服务（M2，V12）。
 *
 * 与剪贴板 / 待办服务不同：桌面整理**没有前端直连 SQL**——计划生成、移动执行、
 * 撤销全部收敛在 Rust 侧（文件系统能力 + 安全策略都在那里），本服务只做 IPC 封装
 * 与类型归一，保证「前端只传参、引擎在 Rust」的边界（spec 要求）。
 *
 * 安全边界：
 *   - `scanDesktop` / `previewPlan` 的 `dir` 参数缺省 = 用户真实桌面；自动化测试
 *     只允许传 TEMP 沙箱目录；
 *   - `applyPlan` 必须由 UI 二次确认后调用（Rust 侧还会校验 applied=0 防重复执行）。
 */

/** 扫描目录条目（dir 缺省 = 用户真实桌面） */
export function scanDesktop(dir?: string): Promise<OrganizerScanResult> {
  return ipc.organizerScanDesktop(dir);
}

/** 生成整理计划（只算不搬，落库 applied=0） */
export function previewPlan(rules: OrganizerRules, dir?: string): Promise<OrganizerPlan> {
  return ipc.organizerPreviewPlan(rules, dir);
}

/** 勾选排除后回写计划条目（仅 applied=0） */
export function updatePlanItems(planId: string, items: OrganizerPlanItem[]): Promise<OrganizerPlan> {
  return ipc.organizerUpdatePlanItems(planId, items);
}

/** 执行移动（须已二次确认） */
export function applyPlan(planId: string): Promise<OrganizerApplyReport> {
  return ipc.organizerApply(planId);
}

/** 逆序撤销已应用计划 */
export function undoPlan(planId: string): Promise<OrganizerUndoReport> {
  return ipc.organizerUndo(planId);
}

/** 历史计划列表 */
export function listPlans(): Promise<OrganizerPlan[]> {
  return ipc.organizerListPlans();
}

/** 计划状态推导（前端展示用）：待应用 / 已应用 / 已撤销 */
export function planStatus(plan: OrganizerPlan): 'pending' | 'applied' | 'undone' {
  if (plan.payload.undone) {
    return 'undone';
  }
  return plan.applied ? 'applied' : 'pending';
}

/** 计划状态中文名 */
export const PLAN_STATUS_LABELS: Record<ReturnType<typeof planStatus>, string> = {
  pending: '待应用',
  applied: '已应用',
  undone: '已撤销',
};
