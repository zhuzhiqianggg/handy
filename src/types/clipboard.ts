/**
 * 剪贴板历史类型（M4 / V10）。
 *
 * 与 `clip_items` 表 / Rust `commands/clip.rs::ClipItem` 一一对应（serde camelCase）。
 * 独立成文件以避免 `lib/ipc.ts` ↔ `core/data/clipboardService.ts` 相互依赖成环。
 */

/** 剪贴板条目实体 */
export interface ClipItem {
  id: string;
  /** 内容类别（当前仅 'text'；图片等为 V11 预留） */
  kind: string;
  content: string;
  /** 缩略图（图片类预留，文本为 null） */
  thumb: string | null;
  /** 来源应用（V11 起尽力填充，V10 为 null） */
  sourceApp: string | null;
  pinned: boolean;
  /**
   * 敏感标记：**V10 起敏感内容不落库**（见 `clipboardService.isSensitiveClipboard`
   * 的取舍说明），本列由 schema 保留、当前恒为 0，供将来「会话内易失条目」复用。
   */
  sensitive: boolean;
  createdAt: number;
}

/** 批量写入入参（`kind` 缺省 'text'；`id` 缺省由 Rust 生成 uuid） */
export interface ClipInput {
  id?: string;
  kind?: string;
  content: string;
  thumb?: string | null;
  sourceApp?: string | null;
}
