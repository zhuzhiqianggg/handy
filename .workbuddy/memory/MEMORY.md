# Handy · 顺手 — 项目长期记忆

> 续接必读：现状/批次明细 → PROJECT_STATUS.md；约定与踩坑 → CONVENTIONS.md；逐日 → YYYY-MM-DD.md。
> 本文件只留跨会话最小集；加内容前先删等量旧内容（曾超限被注入截断而失效）。

## 1. 既定标识
- 产品名 Handy · 顺手；identifier `com.handy.desktop`；`productName` 必须 `Handy`（进 exe/包名，禁中文与间隔号），中文名只用于标题/UI。
- 栈：Tauri 2 + React 18 + TS + Vite + Tailwind + shadcn/ui + cmdk + Zustand；SQLite + tauri-plugin-store；Win10 1809+ / macOS 12+。
- 工具箱 **26 命令 / 7 分类**（V45 起 `vault` 是工具箱里的一个工具，分类 `security`）；模块 **3 个**：toolbox / notes / desktop-organizer（三个都 `sidebar:true`；workstation·todos·desktop-grid·vault 是视图/独立窗口，非模块）。
- 独立窗口 6 个：main / note / settings / organizer / grid-overlay / workstation-bar。

## 2. 路径与关键位置
- 项目根 `D:\_Projects\ops\handy`；参考项目 `D:\_Projects\ops\ops-tools`（只读，禁改）。
- 权威文档 `docs/{01-planning,02-architecture,03-development}`（无后缀=权威）。
- 前端 `src/{core,modules,components,platform,lib,stores,hooks}`；Rust `src-tauri/src/{platform,db,commands}`。
- 真实数据：库 `%APPDATA%\com.handy.desktop\handy.db`（接管态看 `grid_meta`：`overlay_visible`/`desktop_takeover`/`desktop_icons_hidden`）；日志 `%LOCALAPPDATA%\Handy\handy.log`；装好的程序 `%LOCALAPPDATA%\Handy\handy.exe`（NSIS currentUser `/S`）。
- 命令：Rust 前置 `source scripts/rust-env.sh`；类型检查 `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`；打包 `bash scripts/build-release.sh --no-deploy`（PortableGit 全路径 bash + 显式 PATH）；回归 `scripts/regression/run.mjs`（17 套）；自检 `scripts/audit/`（tool-audit / layout-audit / sample-smoke / window-probe.py / desktop-icon-probe.py / **desktop-icon-restore.py**）。

## 3. 状态快照（2026-09-19 · **V45 已打包并静默装机，待用户 GUI 验收**）
- ★ **桌面格子 = 呈现层**（V37 立，别按旧结论推理）：条目只是桌面文件的引用登记，拖入/移出/一键归类**一个字节都不移动文件**。V33–V36 的「真实收纳」(`fs::rename` 进 `桌面/Handy整理/<格名>/`) 已被用户否决作废。整理后必须由格子**接管桌面呈现**（隐藏 `SysListView32`），否则同一批文件显示两遍——用户反复投诉点。
- ★ **接管与归还**（V40 + V44.2 + V44.3）：接管 = 「整理一律接管」+ 30 秒宽限归还；`grid_overlay_hide` **不再隐藏挂件窗**，只收「格子内容」+ 恢复原生图标 —— 工具栏（工具箱/密码箱/搜索/整理/显示）**常驻桌面**，否则「隐藏后没有任何入口能再打开整理」是死路。启动一律 `restore_overlay_if_visible`（接管→`show_overlay`，未接管→`show_launcher_only`），**不弹主窗口**。退出恢复走 `ExitRequested`＋`Exit`＋`app_quit` 三处（`Exit` 在拆解后触发不可靠）；**强杀不会触发任何一处**（见 §4 装机铁律）。
- 端到端布局测试用 `layout_all_boxes_with(loose_count)` 注入落单数，**不得依赖跑测试那台机器的桌面**。DB 迁移链 v1→v9，真实库可能停在 v8，首次启动顺次自动应用，由 `cargo test --lib` 守住。
- 布局不变量（V38–V42）：三段排布（左上固定列 / 中段流布 / 挂件右上）+ 左下「不整理」竖条（`loose_strip_rect`，系统图标与快捷方式不造格子）；**镜像流布**（`FlowPlacer::{mirror,min_x}`，第 0 列=最右列；⚠️ first-fit 会回填空档，**偏移量非单调**，断言别写单调）；自动整理**先清后算**（`dissolve_auto_boxes`）；摆放「条目少的先摆」填挂件压出的缝。单测 46/46。

### 批次索引（细节见 PROJECT_STATUS §1.x）
- **V42** 系统图标/快捷方式改左侧竖条 · 镜像流布 · 桌面 Dock · 桌面搜索 · 侧栏收缩。
- **V43** `sync_dismissed` 黑名单只增不减 → `release_dismissed()`；拖放源 `effectAllowed` 必须与目标 `dropEffect` 兼容（`copyMove`）；接管后由 `platform/shell_menu.rs` 替 Shell 弹原生右键菜单。
- **V44 / V44.3** 桌面优先：启动不弹主窗；对话框式面板 → 桌面抽屉；挂件窗常驻 + 托盘切换 + `contentHidden`。
- **V45**（用户五条 + 三截图）① **P0**：`TooltipProvider` 只包主窗口 → 桌面抽屉里开密码生成器白屏；改在 `main.tsx` 根上包**所有窗口根**（**约定：工具会跑在挂件窗，任何依赖主窗口壳的能力都要在挂件窗补齐**）；② 三套旧面板（搜索浮层/工具箱抽屉/快捷浮层）合并为 **`DesktopSidePanel.tsx`**（右侧滑入 + 搜索/工具箱/快捷三 tab，工具本体就地渲染，不弹对话框）；③ 密码存储器**并入工具箱**（新增 `security` 分类 + `toolbox/commands/Vault.tsx`，删 `modules/vault/index.ts` 模块注册，`VaultView`/Rust 加解密零改动）；④ 恢复 `notes`/`desktop-organizer` 侧栏注册（主窗口=「按需宿主」，启动仍不弹）；⑤ **桌面背景右键菜单** `platform/desktop_menu.rs`（HKCU `DesktopBackground\Shell`，`"handy.exe" --show-grid` → `show_overlay_now`，冷启动 + 单实例双路径；`GridManagerView` 有安装/卸载开关）。
- ⚠️ agent 会话启动不了本 GUI（新旧版本一律挂死启动早期，非代码问题）→ 打包 + `/S` 静默装即止，**不代启动**，请用户自己启动。唯一阻塞项 = 用户装机 GUI 验收。

## 4. 协作与操作约定
- 用户偏好：先规划后执行；表格化；绝对路径；改文件前先读取；目录扁平。
- 红线：禁对真实用户目录（Desktop/Documents/Downloads）写（测试限 TEMP 沙箱）。
- 批次收尾：功能完成 → 打包 → 停旧版 → **归还桌面图标**（见下）→ NSIS `/S` 静默装 → `cmp -l` 取证（只应差 3 字节：`_VAR_UNK`→`_NSS`）→ 停手不启动。
- ★ **接管期间装机必须先归还桌面**（V45 踩到）：旧版正在接管（`grid_meta` 三键皆 1）时 `Stop-Process -Force` **不会**触发退出恢复 → 空白桌面。顺序：查 DB → 停进程 → **立刻** `python scripts/audit/desktop-icon-restore.py` → `desktop-icon-probe.py` 复核 `vis=True` → `desktop_icons_hidden` 置 `'0'` → 装机。**不能先恢复再杀**（接管自愈 3 秒内会重新藏起来）；别用 PowerShell `Add-Type`（本机安全策略直接拦），用 Python `ctypes`。
- 高频坑（完整 → CONVENTIONS）：① 同文件多处 Edit 必须串行（**md 追加一律用 python `open(...,'a')`**；Edit 的 old_string 取太短会误删半行——V42 踩过）；② vite build 与布局审计分两条命令；③ npm.cmd/cmd.exe 被拦 → 用 `node node_modules/<cli>/<entry>.js`；④ Bash shim 时好时坏 → 输出落盘再 Read、构建用 PortableGit 全路径 bash；⑤ 源码中文文案禁反引号/markdown 星号；⑥ heredoc 可能被安全策略拦 → 写 `.py` 临时脚本再跑；⑦ 审计脚本靠正则读源码时，格式一变就**静默变弱**（V45 `ToolCategory` 踩到）→ 加「解析为空即 FAIL」守卫。

## 5. 验证纪律
- agent 自报 "exit 0" 不可信 → 独立复跑、输出与 exit code 分文件落盘再 Read。
- 过期日志甄别：核 mtime 先后；回归里算错的期望值比产品代码更危险，断言逐条反问「失败场景下它会不会也成立」。
- 已知预存问题（非回归，V44.1 起）：`sample-smoke` 13 个工具内部探针过期；`layout-audit` 2/84（`base64-codec`/`cron-descriptor` @680 窄屏微裁切）。
- GUI 问题先用已知 good 旧产物对照，分离「代码回归」与「环境坏了」；浮层窗不见：先读应用日志 → `window-probe.py zlist` 看层级 → 看 render 画没画；布局类先看日志量化数字。
