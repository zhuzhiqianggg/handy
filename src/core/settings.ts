import type { AppSettings } from './types';

/**
 * 配置键与默认值集中定义（`settings.json` 内的键名，见 ARCHITECTURE §7.2）。
 *
 * - `settings`：应用级配置（含模块开关 `modules`）
 * - `favorites` / `recent`：命令收藏与最近使用（配置态，沿用 v1 语义）
 */
export type { AppSettings } from './types';

/** 应用设置键 */
export const SETTINGS_KEY = 'settings';
/** 收藏键 */
export const FAVORITES_KEY = 'favorites';
/** 最近使用键 */
export const RECENT_KEY = 'recent';

/** 应用版本（与 package.json / tauri.conf.json 保持一致，供「关于」展示）。 */
export const APP_VERSION = '0.1.0';

/** 最近使用最大条数 */
export const RECENT_LIMIT = 20;

/**
 * 工作台「快捷入口」默认展示的动作 id。
 *
 * id 契约来自 Rust 白名单表 `src-tauri/src/commands/sys.rs`（那里是唯一事实源），
 * 这里只挑**高频且路径深**的几项：管理员终端、网络三件套（网络连接 / 刷新 DNS /
 * 编辑 hosts）、任务管理器、服务、临时目录。其余动作由工作台里的「自定义」自行勾选。
 */
export const DEFAULT_QUICK_ACTION_IDS: readonly string[] = [
  'powershell-admin',
  'cmd-admin',
  'ncpa',
  'dns-flush',
  'hosts-edit',
  'taskmgr',
  'services',
  'temp-folder',
];

/** 默认应用设置（首次运行时以此为基线） */
export const DEFAULT_SETTINGS: AppSettings = {
  hotkey: 'Alt+Space',
  theme: 'light',
  autoLaunch: false,
  autoUpdate: true,
  closeToTray: true,
  recordHistory: true,
  maxHistory: 50,
  // 已移除 `sensitiveToolIds`（全项目无消费点）。敏感管控唯一事实源 = `CommandMeta.sensitive`
  // （判定与清洗见 core/sensitive.ts）；如需用户自定义开关，V13 设置中心再接。
  // 空对象 = 全部模块默认启用（map 仅记录显式覆盖的开关）
  modules: {},
  tier: 'free',
  onboarded: false,
  // 默认不常驻：贴条属于「需要了才贴」的可选增强，由工作台里的「贴到桌面顶部」开启
  barPinned: false,
  // 默认不置顶：主窗口压在最上层会挡住系统弹框与其他软件，按需再开
  mainPinned: false,
  // 快捷入口默认只显示「常用」这几项，不把 30+ 个系统面板一股脑铺满界面
  quickActionIds: [...DEFAULT_QUICK_ACTION_IDS],
};
