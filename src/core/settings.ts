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
};
