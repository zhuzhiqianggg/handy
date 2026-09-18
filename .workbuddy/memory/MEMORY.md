# Handy · 顺手 — 项目长期记忆

> 续接必读：现状/批次明细 → PROJECT_STATUS.md；约定与踩坑 → CONVENTIONS.md；逐日 → YYYY-MM-DD.md。
> 本文件只留跨会话最小集；加内容前先删等量旧内容（曾超限被注入截断而失效）。

## 1. 既定标识
- 产品名 Handy · 顺手；identifier `com.handy.desktop`；`productName` 必须 `Handy`（进 exe/包名，禁中文与间隔号），中文名只用于标题/UI。
- 栈：Tauri 2 + React 18 + TS + Vite + Tailwind + shadcn/ui + cmdk + Zustand；SQLite + tauri-plugin-store；Win10 1809+ / macOS 12+。
- 工具箱 25 命令 / 6 分类；模块 4 个：toolbox / notes / vault / desktop-organizer（workstation·todos·desktop-grid·settings 是视图/独立窗口，非模块）。
- 独立窗口 6 个：main / note / settings / organizer / grid-overlay / workstation-bar。

## 2. 路径与关键位置
- 项目根 `D:\_Projects\ops\handy`；参考项目 `D:\_Projects\ops\ops-tools`（只读，禁改）。
- 权威文档 `docs/{01-planning,02-architecture,03-development}`（无后缀=权威）。
- 前端 `src/{core,modules,components,platform,lib,stores,hooks}`；Rust `src-tauri/src/{platform,db,commands}`。
- 真实数据：库 `%APPDATA%\com.handy.desktop\handy.db`；日志 `%LOCALAPPDATA%\Handy\handy.log`；装好的程序 `%LOCALAPPDATA%\Handy\handy.exe`（NSIS currentUser `/S`）。
- 命令：Rust 前置 `source scripts/rust-env.sh`；前端类型检查 `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`；打包 `bash scripts/build-release.sh --no-deploy`（PortableGit 全路径 bash + 显式 PATH）；回归 `scripts/regression/run.mjs`（17 套）；自检 `scripts/audit/`（tool-audit/layout-audit/sample-smoke/window-probe.py/desktop-icon-probe.py）。

## 3. 状态快照（2026-09-19 · **V44 已打包并静默装机，待用户 GUI 验收**）
- ★ 桌面格子 = 呈现层（V37 立，别按旧结论推理）：条目只是桌面文件的引用登记，拖入/移出/一键归类**一个字节都不移动文件**（对标腾讯桌面整理）。V33–V36 的「真实收纳」(`fs::rename` 进 `桌面/Handy整理/<格名>/`) 已被用户否决作废。整理后必须由格子**接管桌面呈现**（隐藏 SysListView32），否则同一批文件显示两遍——用户反复投诉点。
- V40：接管改为「整理一律接管」+ 30 秒宽限归还；统一列宽 + 左起流布局 + 高度随内容；扫两个桌面根。V40.1：dialog 插件 async/ACL 缺陷（confirmAction.ts）+ Z 序沉底再上提（CONVENTIONS §21）。
- V41：三段排布（左上固定列=系统+快捷方式 / 中段流布 / 挂件右上）；新增左下「不整理」区（`grid_loose_list`，仅接管模式渲染）修「移出没回桌面」；右键各归其位（格子菜单只挂 header、条目弹自己的菜单 + `grid_reveal_path`）；去 hover ×、拖出格子即移出；挂件竖排先牺牲底部边距（CONVENTIONS §22）。单测 43→44。
- **V42**（用户双截图六点）：① **系统图标/快捷方式不再造格子** → 改「左侧『未归类』竖条」（左上角从上往下、纯图标无外壳，`loose_strip_rect` + `LooseEntry.isSystem` + `SYSTEM_ENTRIES`）；② 自动整理**先清后算**（`dissolve_auto_boxes` 删 `::%`/`%.lnk` 登记与系统/快捷方式格，`arrange_group_of` 对 `.lnk` 返回 None），报告加 `left_over/dissolvedBoxes/dissolvedItems`；③ **镜像流布**（`FlowPlacer::{mirror,min_x}`，第 0 列=最右列、从右上往左排，`min_x` 给左条留地；⚠️ first-fit 会回填空档，**偏移量非单调**，断言别写单调）；④ 主窗口侧栏只剩工具箱+密码存储器（`ModuleMeta.sidebar:false`，模块与命令保留仍可搜索）；⑤ **桌面 Dock**（底部居中，与工作台共用 `quicklinks.ts` 数据，可拖桌面图标进）；⑥ **桌面搜索 + `desktop_open_view`**（`handy:navigate` 复用 `bar_open_command` 机制，不开新窗）。单测 44→46。
- 端到端布局测试用 `layout_all_boxes_with(loose_count)` 注入落单数，**不得依赖跑测试那台机器的桌面**。
- DB 迁移链 v1→v9，真实库可能停在 v8，首次启动顺次自动应用；由 `cargo test --lib` 守住。

- **V43**（用户三截图六点）：① 根因「整理了却没重新整理」= 一张只增不减的 `sync_dismissed` 黑名单（`register_item` 见了就跳过），真机库实测攒了 13 条零散目录/文件 → 新增 `release_dismissed()` 一键整理时先清空名单（报告 `released`）；② 根因「拖不进 Dock」= 拖动源 `effectAllowed='move'` 与 Dock `dropEffect='copy'` 冲突 → 源改 `copyMove` + Dock `onDragOver` 放宽；③ 根因「右键被格子吃掉」= 接管后没人替 Shell 弹菜单 → 新增 `platform/shell_menu.rs` 调 `IContextMenu`（普通右键=原生菜单，Shift=自带的「移出格子」）；④ 工具箱与桌面合体 → `DesktopToolPanel` 桌面抽屉（`openTarget` 改为开抽屉，主窗口退化成设置台）；⑤ 工作台数据 `ACTION_ICONS` 导出（但系统入口没真落到桌面，见 V44）；⑥ 摆放顺序改「条目少的先摆」填挂件压出的缝，抽屉/搜索统一深色玻璃卡片。单测 46 全绿。
- **V44**（用户：「我们就是桌面工具，主要功能直接在桌面上实现，不是独立窗口」）：① `lib.rs` 启动显隐改为「`read_overlay_visible` 接管生效则不弹主窗口」→ 桌面即主界面，主窗口退化按需工具宿主；② 新增 `DesktopQuickActions.tsx` 桌面「快捷操作」浮层（工具栏「快捷」按钮唤出）——系统入口(hosts编辑等 via `sysActionList`/`sysActionRun`+`ACTION_ICONS`)、我的快捷方式(与 Dock 同源 `quicklinks`、`handy:quicklinks` 事件同步)、应用入口(工具箱/便签/密码/桌面整理/设置 `openTarget`/`openSettings`)全在桌面直达，工作台窗口无需再开；三面板互斥。tsc0 · 单测46 · 回归17/17。
- ⚠️ agent 会话启动不了本 GUI（新旧版本一律挂死启动早期，非代码问题）→ 打包 + `/S` 静默装即止，**不代启动**，请用户自己启动。唯一阻塞项 = 用户装机 GUI 验收。

## 4. 协作与操作约定
- 用户偏好：先规划后执行；表格化；绝对路径；改文件前先读取；目录扁平。
- 红线：禁对真实用户目录（Desktop/Documents/Downloads）写（测试限 TEMP 沙箱）。
- 批次收尾：功能完成 → 打包 → 停旧版 → NSIS `/S` 静默装 → `cmp -l` 取证（只应差 3 字节：`_VAR_UNK`→`_NSS`）→ 停手不启动。
- 高频坑（完整 → CONVENTIONS）：① 同文件多处 Edit 必须串行（**md 追加一律用 python `open(...,'a')`，Edit 的 old_string 取太短会误删半行——V42 踩过**）；② vite build 与布局审计分两条命令；③ npm.cmd/cmd.exe 被拦 → 用 `node node_modules/<cli>/<entry>.js`；④ Bash shim 时好时坏 → 输出落盘再 Read、构建用 PortableGit 全路径 bash；⑤ 源码中文文案禁反引号/markdown 星号；⑥ 装机只用 PowerShell `Start-Process -ArgumentList "/S" -PassThru -Wait`（Git Bash `//S &` 双失效）。

## 5. 验证纪律
- agent 自报 "exit 0" 不可信 → 独立复跑、输出与 exit code 分文件落盘再 Read。
- 过期日志甄别：核 mtime 先后；回归里算错的期望值比产品代码更危险，断言逐条反问「失败场景下它会不会也成立」。
- GUI 问题先用已知 good 旧产物对照，分离「代码回归」与「环境坏了」；浮层窗不见：先读应用日志 → `window-probe.py zlist` 看层级 → 看 render 画没画；布局类先看日志量化数字。
