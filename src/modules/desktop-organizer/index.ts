import type { ModuleMeta } from '@/core/types';
import { desktopOrganizerCommands } from './commands';

/**
 * 桌面整理（M2）模块元数据（V12：scan / preview / apply / undo 闭环接入）。
 *
 * 经 `import.meta.glob`（匹配各模块目录下的 index.ts）自动发现，无需在任何注册表登记。
 * 命令在 `./commands` 声明；面板内页经 `loadView` 惰性加载 `OrganizerView`。
 * macOS 降级为「文件归类」（由 `platform.capabilities.desktopIcons` 驱动，V12 规则
 * 引擎与安全策略一致）。
 *
 * 安全说明：本模块具备**真实文件移动能力**——移动仅经用户「生成预览 → 二次确认 →
 * 应用」链路发生，支持一键撤销；自动化测试只允许在 TEMP 沙箱目录内进行。
 */
const desktopOrganizerModule = {
  id: 'desktop-organizer',
  name: '桌面整理',
  description: '桌面文件按类型 / 日期归类，可预览与撤销',
  icon: 'LayoutGrid',
  order: 40,
  surface: ['panel', 'window'],
  tier: 'free',
  keywords: ['桌面', '整理', '归类', '文件', 'organize', 'desktop', 'zmzl'],
  platforms: ['windows', 'macos'],
  capabilities: ['desktopFileOrganize'],
  route: 'desktop-organizer',
  windowSpec: { kind: 'organizer' },
  contributes: {
    commands: desktopOrganizerCommands,
  },
  loadView: () => import('./OrganizerView'),
} satisfies ModuleMeta;

export default desktopOrganizerModule;
