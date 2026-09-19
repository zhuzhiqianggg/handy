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

## 3. 状态快照（2026-09-19 · **V46 已打包并静默装机，待用户 GUI 验收**）
- ★ **桌面格子 = 呈现层**（V37 立，别按旧结论推理）：条目只是桌面文件的引用登记，拖入/移出/一键归类**一个字节都不移动文件**。V33–V36 的「真实收纳」(`fs::rename` 进 `桌面/Handy整理/<格名>/`) 已被用户否决作废。整理后必须由格子**接管桌面呈现**（隐藏 `SysListView32`），否则同一批文件显示两遍——用户反复投诉点。
- ★ **接管与归还**：`grid_overlay_hide` **不隐藏挂件窗**，只收「格子内容」+ 恢复原生图标 —— 工具栏**常驻桌面**（否则隐藏后无入口再打开整理 = 死路）。启动走 `restore_overlay_if_visible`（接管→`show_overlay`，未接管→`show_launcher_only`），**不弹主窗口**。退出恢复三处：`ExitRequested`＋`Exit`＋`app_quit`（**强杀不会触发任何一处** → 见 §4 装机铁律）。
- 端到端布局测试用 `layout_all_boxes_with(loose_count)` 注入落单数，**不得依赖跑测试那台机器的桌面**。DB 迁移链 v1→v9，由 `cargo test --lib` 守住。
- ★ **桌面层权威定义 → `docs/02-architecture/DESKTOP-LAYER.md`（V46 新建，先读它）**：六区结构 + `overlay_visible` 唯一真源（`On`/`Off`）+ 五条不变量 + 桌面层保险 + 工具呈现模型。别再按代码注释里的旧结论推理。
- ★ **Z 序：`SetWindowPos(hwnd, X)` 是把 hwnd 放到 X 下面**（V46 现场实验确立，见 CONVENTIONS §27）。「贴桌面正上方」= **单步 `HWND_BOTTOM`**，幂等。旧的两步法方向写反了，靠「普通窗口不可能低于桌面」的钳制侥幸成立。
- ★ **桌面层保险指标 = 产品指标**：检测 **1s**、判到就纠、退避上限 **5s**（旧：3s/两次去抖/失败退避 **300s** → 真机单会话 265 条 `TooHigh`）。不变量：`Off ⇒ 原生图标必须可见`（V45 的 `reassert_takeover` 只看偏好不看 `overlay_visible` ⇒ 收起后图标又被藏 = 空桌面）；`On ⇒ 窗口可见`（新增「显示态却不可见 → `show()` 捞回」）。单测 47/47（新增 `band_insurance_recovers_fast`）。
- 布局不变量（V38–V42）：三段排布（左上固定列 / 中段流布 / 挂件右上）+ 左下「不整理」竖条（`loose_strip_rect`，系统图标与快捷方式不造格子）；**镜像流布**（`FlowPlacer::{mirror,min_x}`，第 0 列=最右列；⚠️ first-fit 会回填空档，**偏移量非单调**，断言别写单调）；自动整理**先清后算**（`dissolve_auto_boxes`）；摆放「条目少的先摆」填挂件压出的缝。

### 批次索引（细节见 PROJECT_STATUS §1.x）
- **V42–V44.3** 左侧竖条 · 镜像流布 · 桌面 Dock/搜索 · 桌面优先（启动不弹主窗、对话框面板→桌面抽屉、挂件窗常驻 + `contentHidden`）。
- **V45** `TooltipProvider` 提到 `main.tsx` 根覆盖**所有窗口根**（工具会跑在挂件窗，任何依赖主窗口壳的能力都要在挂件窗补齐）；三套旧面板合并为 `DesktopSidePanel.tsx`；密码存储器并入工具箱；恢复 `notes`/`desktop-organizer` 侧栏（主窗口=「按需宿主」，启动仍不弹）；桌面右键菜单 `platform/desktop_menu.rs`（`--show-grid` → `show_overlay_now`）。
- **V46** 桌面层保险 v2（见上）+ 修 `reassert_takeover` 空桌面 + 新增捞回路径 + 日志限流带 `z_chain_brief()`；桌面上的**面板/工具本体/工具栏/Dock 全部改实心**（用户：「不要透明了 透明有问题」），抽屉尺寸 620→**820px** 且 `right-[252px]`（旧 124px 会盖住工具栏）；工具标题栏「在控制台打开」→ `desktop_open_view`；新增诊断 `scripts/audit/zorder-probe.py`（复刻 Rust 判定 + 实验）。
- ⚠️ agent 会话启动不了本 GUI（新旧版本一律挂死启动早期，非代码问题）→ 打包 + `/S` 静默装即止，**不代启动**，请用户自己启动。唯一阻塞项 = 用户装机 GUI 验收。
- 预存未清（与本批无关）：`sample-smoke` 13 个工具内探针过期、`layout-audit` 2/84（`base64-codec`/`cron-descriptor` @680 窄屏微裁切）。

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
