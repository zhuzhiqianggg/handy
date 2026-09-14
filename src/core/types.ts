import type { ComponentType, ReactNode } from 'react';
import type { Platform } from '@/types/platform';
import type { CommandLayout, ModuleSurface, WindowKind } from '@/types/window';

/**
 * 模块 / 功能（命令）双层注册契约（ARCHITECTURE ADR-6 / §4.1）。
 *
 * - 模块（Module）= 顶层功能域（M1…M11），拥有独立承载形态、生命周期与扩展点贡献；
 * - 功能（Command）= 挂靠模块下的轻量能力，命令面板的搜索/收藏/最近/复制外壳自动生效。
 *
 * 平台/窗口类基础类型复用 V03 已在 `src/types/*` 定义的集合，避免重复定义。
 */
export type { Platform };
export type { CommandLayout, ModuleSurface, WindowKind };

/** 功能分级（授权预留，ADR-10） */
export type Tier = 'free' | 'pro';

/** 主题模式（设置中心） */
export type ThemeMode = 'light' | 'dark' | 'system';

/** 独立窗口 / 面板内页的模块视图入参 */
export interface ModuleProps {
  /** 承载窗口类型 */
  windowKind?: WindowKind;
  /** 上下文（如 `{ noteId: 'xxx' }`） */
  context?: Record<string, string>;
}

/** 命令组件入参（沿用 v1 ToolProps 语义，新增跨模块跳转） */
export interface CommandProps {
  /** 初始输入（如来自剪贴板建议 / 历史） */
  initialInput?: string;
  /** 输入来源 */
  source?: 'clipboard' | 'history' | 'command' | 'manual';
  /** 使用回调（写入最近使用） */
  onUsed?: (id: string) => void;
  /** 跨模块跳转（便签↔剪贴板互转等） */
  onRequestModule?: (moduleId: string, payload?: unknown) => void;
}

/** 设置中心分区（扩展点 `settings.section` 贡献） */
export interface SettingsSection {
  id: string;
  title: string;
  order: number;
  render: () => ReactNode;
}

/** 托盘项（扩展点 `tray.item` 贡献） */
export interface TrayItem {
  id: string;
  label: string;
  onClick: () => void;
}

/** 剪贴板内容动作（扩展点 `clipboard.transform` 贡献） */
export interface ClipboardTransform {
  id: string;
  label: string;
  run: (content: string) => void;
}

/** 内容识别器（扩展点 `detect.matcher` 贡献） */
export interface Detector {
  id: string;
  match(text: string): { kind: string; suggestion: string } | null;
}

/**
 * 模块元数据：顶层功能域。
 * 必须通过 `export default { ... } satisfies ModuleMeta` 自注册（`import.meta.glob` 自动发现）。
 */
export interface ModuleMeta {
  /** 模块 id（kebab-case，全局唯一），如 'toolbox' */
  id: string;
  /** 展示名，如 '工具箱' */
  name: string;
  description: string;
  /** lucide 图标名（具名导出），如 'Wrench' */
  icon: string;
  /** 主题色（侧栏/标签），缺省用品牌色 */
  color?: string;
  /** 展示排序（升序） */
  order: number;
  /** 支持的承载形态 */
  surface: ModuleSurface[];
  /** 免费 / Pro（授权预留） */
  tier: Tier;
  /** 搜索关键词（含拼音） */
  keywords: string[];
  /** 限定平台（缺省 = 全平台） */
  platforms?: Platform[];
  /** 依赖的系统能力位（用于权限引导 / 降级） */
  capabilities?: string[];
  /** 面板内路由标识（panel surface） */
  route?: string;
  /** 独立窗口规格（window surface） */
  windowSpec?: {
    kind: WindowKind;
    multi?: boolean;
    frameless?: boolean;
    alwaysOnTop?: boolean;
  };
  /** 生命周期：激活（注册命令 / 启动监听） */
  activate?: () => Promise<void>;
  /** 生命周期：停用（释放资源） */
  deactivate?: () => Promise<void>;
  /** 扩展点贡献（自动聚合，无需改框架） */
  contributes?: {
    commands?: CommandMeta[];
    settingsSection?: SettingsSection;
    trayItems?: TrayItem[];
    clipboardTransforms?: ClipboardTransform[];
    detectors?: Detector[];
  };
  /** 面板内页视图的懒加载（未启用模块不加载其代码） */
  loadView?: () => Promise<{ default: ComponentType<ModuleProps> }>;
}

/**
 * 命令（功能）元数据：可被命令面板搜索到的轻量能力。
 *
 * 必须显式标注类型（`const CMD: CommandMeta = {...}` 或 `satisfies CommandMeta`）。
 * `load`（有 UI）与 `run`（动作式，框架级系统命令）**至少提供一个**。
 */
export interface CommandMeta {
  /** 命令 id（kebab-case，全局唯一），如 'timestamp' */
  id: string;
  /** 归属模块 id；框架级系统命令用 'system' */
  moduleId: string;
  name: string;
  description: string;
  icon?: string;
  /** 别名（英文缩写等），如 ['ts', 'timestamp'] */
  aliases: string[];
  /** 关键词（含拼音首字母），如 ['时间戳', 'sjc'] */
  keywords: string[];
  layout?: CommandLayout;
  tier: Tier;
  /** 敏感命令：结果默认不写历史 / 剪贴板（密码 / 密钥） */
  sensitive?: boolean;
  /** 是否联网（MVP 全 false） */
  isOnline?: boolean;
  /** 限定平台（缺省 = 全平台） */
  platforms?: Platform[];
  /** 懒加载视图组件（有 UI 的命令） */
  load?: () => Promise<{ default: ComponentType<CommandProps> }>;
  /** 动作式执行（无 UI 的框架级系统命令）；与 `load` 至少提供一个 */
  run?: () => void | Promise<void>;
}

/**
 * 应用级配置（`tauri-plugin-store` → `settings.json` 的 `settings` 键，ADR-7 / §7.1）。
 *
 * 注意：`modules`（模块启停）在桌面端由 Rust `module_set_enabled` / `module_list_state`
 * 命令读写同一 `settings` 对象（保持跨窗口一致）；浏览器调试环境降级为本地存储。
 */
export interface AppSettings {
  /** 呼出快捷键（平台默认见 platform.hotkeyDefault()） */
  hotkey: string;
  theme: ThemeMode;
  autoLaunch: boolean;
  autoUpdate: boolean;
  closeToTray: boolean;
  /** 剪贴板后台监听 */
  clipboardWatch: boolean;
  /** 剪贴板历史开关 */
  clipboardHistory: boolean;
  /** 工具使用历史开关 */
  recordHistory: boolean;
  /** 工具历史上限 */
  maxHistory: number;
  /** 剪贴板上限 */
  maxClipboard: number;
  // 已移除 `sensitiveToolIds`：全项目无任何消费点（死字段）。
  // 敏感管控以 `CommandMeta.sensitive` 为唯一事实源（见 core/sensitive.ts）；
  // 若将来需要「用户自定义敏感工具」开关，V13 设置中心再接。
  /** 模块启停（§7.2 settings.modules） */
  modules: Record<string, boolean>;
  /** Pro 标记（授权预留） */
  tier: Tier;
  /** 首次引导完成 */
  onboarded: boolean;
}
