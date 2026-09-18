import type { ModuleMeta } from '@/core/types';
import { desktopOrganizerCommands } from './commands';

/**
 * 桌面整理模块元数据。
 *
 * **注册策略（原地改名重定向，同 notes → 工作台）**：沿用模块 id `desktop-organizer`，
 * 命令、路由、启停状态、备份兼容均无需迁移。
 *
 * # V25：首屏换成 `DesktopOrganizerConsole`（两页签）
 *
 * 用户反馈「桌面整理还是在自己的框里面玩，没有正式操作系统桌面」。
 * 查证结论是**能力有、入口错**，于是加了这一层页签控制台。
 *
 * # V37：两页签的共同前提变成「默认不动文件」
 *
 * V33–V36 那一版把两个页签都做成了「真移动」，被用户装机实测直接否掉：
 * 「是桌面整理，不是让你把桌面上的东西都给我移动到一个目录下面去，这个完全是错误的」。
 * 现在：
 *
 *   - **归类文件**（`OrganizerView` + Rust `organizer.rs` / `grid.rs`）默认
 *     **归拢到桌面格子**（只登记引用，文件原地不动）；「移动到整理目录」降级成
 *     显式可选项，仍保留预览 / 二次确认 / 一键撤销；
 *   - **桌面格子**（`GridManagerView` + Rust `grid.rs`）回到登记引用模型，但定位是
 *     **呈现层**：格子就是桌面图标的另一种排布，拖进 / 移出 / 换格只改显示。
 *
 * 两处都不再「自动」动文件，容器目录 `桌面/Handy整理/` 只服务于用户显式选择的归档模式。
 */
const desktopOrganizerModule = {
  id: 'desktop-organizer',
  name: '桌面整理',
  description: '把桌面图标按类型归拢进格子显示，文件一律留在原位；想真归档也可显式选择移动，可预览可撤销',
  icon: 'LayoutGrid',
  order: 40,
  surface: ['panel'],
  /**
   * V42：**不再占主面板侧栏的位置**。
   *
   * 用户原话：「桌面整理和工作台功能全部都做到桌面去了，工具主页面里面就只需要保留
   * 工具箱和密码存储器了……不需要一个独立的窗口打开才操作」。桌面整理的主战场本来就是
   * 桌面本身（格子挂件层 + 它的工具栏），管理页（格子列表 / 备份 / 诊断修复）改由
   * 挂件层工具栏的「整理页」按钮打开 —— 主面板侧栏不必再留一格。
   */
  sidebar: false,
  tier: 'free',
  keywords: [
    '桌面整理',
    '桌面归类',
    '文件归类',
    '一键整理',
    '自动整理',
    '移动文件',
    '撤销整理',
    '桌面挂件',
    '格子',
    '收纳格',
    '网格',
    '挂件',
    '便签',
    '日历',
    '计划',
    '备份布局',
    '还原布局',
    '图标',
    '快捷',
    'organize',
    'widget',
    'grid',
    'desktop',
    'zmzl',
    'gj',
  ],
  platforms: ['windows', 'macos'],
  capabilities: ['desktopFileOrganize'],
  route: 'desktop-organizer',
  contributes: {
    commands: desktopOrganizerCommands,
  },
  loadView: () => import('./DesktopOrganizerConsole'),
} satisfies ModuleMeta;

export default desktopOrganizerModule;
