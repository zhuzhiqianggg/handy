import {
  AtSign,
  Binary,
  Braces,
  CalendarClock,
  CaseSensitive,
  ClipboardList,
  Clock,
  Database,
  FileCode,
  FileDiff,
  FileImage,
  Filter,
  Fingerprint,
  FolderOpen,
  HardDrive,
  Hash,
  Hourglass,
  Info,
  Keyboard,
  KeyRound,
  LayoutGrid,
  Link2,
  QrCode,
  Regex,
  Scale,
  Settings,
  ShieldCheck,
  Star,
  StickyNote,
  Table2,
  TextCursorInput,
  Trash2,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

/**
 * 图标解析（模块 `icon` / 命令 `icon` 为 lucide 具名导出字符串）。
 *
 * 集中登记以避免各组件重复维护映射表；未登记名称回退到 `fallback`（默认 `Wrench`）。
 *
 * 约定（务必遵守）：**新增工具 / 模块若使用新图标，必须在此 `ICONS` 中登记**，
 * 否则 `resolveIcon` 会静默回退到 `Wrench`——不报错，但图标与预期不符。
 */
export const ICONS: Record<string, LucideIcon> = {
  AtSign,
  Binary,
  Braces,
  CalendarClock,
  CaseSensitive,
  ClipboardList,
  Clock,
  Database,
  FileCode,
  FileDiff,
  FileImage,
  Filter,
  Fingerprint,
  FolderOpen,
  HardDrive,
  Hash,
  Hourglass,
  Info,
  Keyboard,
  KeyRound,
  LayoutGrid,
  Link2,
  QrCode,
  Regex,
  Scale,
  Settings,
  ShieldCheck,
  Star,
  StickyNote,
  Table2,
  TextCursorInput,
  Trash2,
  Wrench,
};

/** 取得图标组件（未登记则回退）。 */
export function resolveIcon(name: string | undefined, fallback: LucideIcon = Wrench): LucideIcon {
  if (name && name in ICONS) {
    return ICONS[name] as LucideIcon;
  }
  return fallback;
}
