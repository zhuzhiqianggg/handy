# Handy · 顺手 — 项目长期记忆

> 只记录跨会话有长期价值的事实与约定。
> **现状总览与续接指引见 [`../PROJECT_STATUS.md`](../PROJECT_STATUS.md)**（从 handy 打开先读它）；逐日进展见同目录 `YYYY-MM-DD.md`。
> 本目录 2026-09-15 从 `ops-tools/.workbuddy/memory/` 迁入（源目录保留未删）。

## 1. 产品既定标识（不可随意更改）

- 产品名：**Handy · 顺手**（主张「方便，而非全面」）
- 项目代号：`handy`；应用 identifier：`com.handy.desktop`；安装包/主程序名：`Handy` / `handy.exe`
- 数据库：`handy.db`；配置文件：`settings.json`
- 技术栈：Tauri 2（Rust）+ React 18 + TS + Vite + Tailwind + shadcn/ui(Radix) + cmdk + Zustand；数据层 SQLite（`tauri-plugin-sql`），配置层 `tauri-plugin-store`
- 平台：Windows 10 1809+ / 11 与 macOS 12+；**`productName` 保持 `Handy`**（会变成 exe/安装包名，不能含中文与间隔号），中文名仅用于窗口标题/托盘/UI

## 2. 路径与结构

| 项 | 值 |
| --- | --- |
| 项目根 | `D:\_Projects\ops\handy` |
| 权威文档 | `docs/{01-planning,02-architecture,03-development}`，**权威版 = 无后缀文件**（PRD/ARCHITECTURE/TASKS/DECISIONS 均 v2.0），v1 在 `docs/99-archive/` |
| 前端 | `src/{core,modules,components,platform,lib,stores,hooks}` |
| Rust | `src-tauri/src/{platform,db,commands}`、`src-tauri/capabilities/`、`src-tauri/tauri.conf.json` |
| 参考项目 | `D:\_Projects\ops\ops-tools`（网页版）——**只读借鉴，禁止修改** |
| 构建脚本 | `scripts/rust-env.sh`（注入 MSVC 环境，Rust 构建必用）、`scripts/dev-static.cjs`（浏览器冒烟静态服务）、`scripts/smoke-richmarkdown.js`（所见即所得编辑器逐字符回归驱动） |

## 3. 状态快照（2026-09-15 · V19 后）

- Phase 1（MVP）功能全部交付；**Windows 安装包已产出**（V19 后重新打包）；待用户装机验收 GUI 行为。
- git：V19 批次 = **`64e3008`**（31 文件 +3112/−372），其后 `e09d25b` 为文档回填；`be1dc58`（V18 文档回填）、`862d5bf` = V18（34 文件 +3061/−687）、`b3b46a8`（文档归位）、`ff6ebb2`（release 关 devtools）。
- 工具箱 **23 个命令**；模块：toolbox / notes(入口重定向→工作台) / workstation(日历+计划+笔记+快捷入口，**V19 双栏**) / todos / desktop-organizer(重定向→桌面整理) / desktop-grid(挂件 + **整理主控台**) / vault / settings。
- **独立窗口 6 个**：main / note / settings / organizer / grid-overlay / workstation-bar（桌面顶部常驻贴条）。
- **DB 迁移链**：v1 schema → v2 移除剪贴板表 → v3 vault → v4 grid → **v5 `todos.detail`**。

## 4. 协作与操作约定

- 用户偏好：**先规划后执行**；表格化、结构化输出；**绝对路径**；**修改文件前必须先读取**；目录扁平少层级。
- 处理任务先排除无关范围（`node_modules`/`dist`/`target`/旧版验证残留）再聚焦。
- **工具坑（必记）**：
  - 同一条消息内并行对**同一个文件**发多个 Edit 会因写入竞争丢失改动 → **同一文件的多处编辑必须串行**（一次一条消息）；不同文件可并行。
  - **Bash shim 时好时坏**：历史上 `dirname`/`ls`/`head`/`find`/`grep`/`mkdir`/`cat` 都缺过（`ls` exit 127）；现在的会话里可用。不确定时降级为 **PowerShell** 或 **node 脚本**，**输出落盘再 Read**（stdout 偶不回显）。
  - `.gitignore` 已忽略 `/*.txt`、`/*.log`、`/*_*.log`、`/*.out`、`/*.exit`、`/_shots/`；但 `_smoke_*.js` / `_smoke_*.sh` **不在忽略列表**里 → 临时脚本用完即删，可复用的挪进 `scripts/`。
  - 文件检索用 **Glob/Grep 工具**（Glob 对反斜杠路径不可靠，Grep 用正斜杠路径可靠）；**Read 用绝对路径最稳**。
  - `npm.cmd` / `cmd.exe` 被安全层拦截 → 调 CLI 一律 `node node_modules/<cli>/<entry>.js`。
  - PowerShell 捕获 git 中文输出会乱码 → 先设 `[Console]::OutputEncoding=[Text.Encoding]::UTF8`，或落盘再 Read（`git commit -m` 传中文本身是安全的）。
  - **`agent-browser keyboard type` 不可用于逐键行为验证**：它走整串 `insertText`，实测 `'# '` 落进 contentEditable 变成 `NBSP + #`、还凭空多出 `*`，会产生完全虚假的失败信号。逐键场景一律用 `eval` + `document.execCommand('insertText', false, ch)` 逐字符循环。
  - **读 React 状态前必须 `await` 一个 tick**：同一同步块里操作完立刻读 DOM 会拿到**上一帧**（React 18 批处理 + microtask flush），极易误判成「onChange 没触发」。`agent-browser eval` 支持 await Promise。
  - **静态服务必须与冒烟命令在同一条 bash 调用里启动**，否则后台进程被作业对象回收，后续命令只会得到 `ERR_CONNECTION_REFUSED`。
- **团队红线**：禁止对真实用户目录（Desktop/Documents/Downloads）做任何写操作（测试限 TEMP 沙箱）；V14 之后打包由主理人在用户明确要求时执行。

## 5. 开发环境（跨会话必读）

- 已就绪：`cargo 1.98.1` / `rustc 1.98.1 (stable-x86_64-pc-windows-msvc)`、**MSVC 14.44.35207 + Win SDK 10.0.26100**、Node v22.22.2、WebView2 137、管理员权限。版本锁定见 `rust-toolchain.toml`。
- **Rust 构建正确姿势（已验证）**：
  ```bash
  source /d/_Projects/ops/handy/scripts/rust-env.sh && cargo check --manifest-path D:/_Projects/ops/handy/src-tauri/Cargo.toml
  ```
  （PowerShell 直跑 cargo 会因环境块损坏/缺 link.exe 失败；`os error 5` 争用 → `CARGO_INCREMENTAL=0` 重试。）
- 前端构建/校验：`node node_modules/vite/bin/vite.js build`、`node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`（绕过被拦的 npm）。
- 打包：`source scripts/rust-env.sh && node node_modules/@tauri-apps/cli/tauri.js build`（`beforeBuildCommand` 若被 npm 拦截，用 `--config '{"build":{"beforeBuildCommand":"node --version"}}'` 覆盖，前端先手动 build）。
- 网络：crates.io 走清华 sparse 镜像 + `~/.cargo/config.toml` 的 `[http] check-revoke = false`（否则报 `CRYPT_E_REVOCATION_OFFLINE`）；PowerShell 5.1 不读 `HTTP_PROXY`，需要联网显式 `-Proxy http://127.0.0.1:54735`；npm registry 已是 `registry.npmmirror.com`。
- **GUI 限制**：工具沙箱内启动的 GUI 进程在调用结束会被作业对象回收，且 webview 可能不执行前端 JS → **窗口/托盘/透明/拖放等真实 GUI 行为只能由用户装机验收**。

## 6. 验证纪律（血泪教训）

- **agent 自报的 "tsc/build exit 0" 不可信**：曾两次虚报（根因 = shell 吞掉 stdout + 把 shell 退出码当成命令退出码）。→ 一律由主理人**独立复跑**，且**输出与 exit code 分文件落盘后再 Read**。
- 过期日志甄别：agent 留下的 tsc/build 日志必须核对 **mtime 与被检文件的先后**，否则会误判「树编不过」。
- 三层验证：实现者自验（落盘取证）→ 独立 QA（fresh eyes，读代码+实跑）→ 主理人终验（cargo check + tsc + 红线抽查如 async/明文日志/迁移链）。
- **DOM / 输入类问题必须用逐字符驱动复现**，且诊断输出要把 `\u200B`（零宽空格）与 `\u00A0`（NBSP）显式替换成可见标记（如 `<Z>`/`<N>`）再打印 —— 否则这些字符在日志里完全隐身，光标锚点在哪根本看不出来。

## 7. 架构约定（V18 / V19 确立，后续照此办）

- **rusqlite 参数个数必须与 SQL 占位符严格一致**：无 `?` 占位符就传空数组 `[]`，传 `0` 会报
  `Wrong number of parameters passed to query. Got 1, needed 0`（V18 桌面挂件全废的根因，
  见 `grid.rs::next_sort` 改用 `Option<i64>`）。
- **系统动作类功能一律走白名单**：`src-tauri/src/commands/sys.rs` 的 `table()` 是唯一事实源，
  前端只传 `actionId`；可执行目标/参数硬编码在 Rust，提权走 `Start-Process -Verb RunAs`。
  新增动作**只在该表追加**，禁止让前端拼命令串。
- **打开非 PE 目标只能走 `ShellExecuteW`**（V19 #1 的根因）：`.cpl`（控制面板）/`.msc`（管理单元）/
  目录/协议都不是 PE 可执行文件，`std::process::Command` 会报 `%1 不是有效的 Win32 应用程序 (os error 193)`。
  `sys.rs::launch_open` 用 `windows` crate 0.58 的 `Win32_UI_Shell::ShellExecuteW` 自主实现，
  返回值 `≤ 32` 视为失败（不依赖 `tauri_plugin_shell::open`）。
- **顶层浮窗用 Tauri 原生 `always_on_top`**（`bar.rs`），不要复用 grid-overlay 那套
  `SetWindowPos(HWND_BOTTOM)` + 光标命中轮询 —— 那套是「桌面最底层 + 点击穿透」专用。
  （V20 修正：`SetWindowPos(HWND_BOTTOM)` 实际会把窗口压到**壁纸之下**，桌面上根本看不见；
  桌面挂件真正贴到桌面的做法见 §8「桌面挂件」。）
- **主窗口默认不置顶**（V19 #5）：`tauri.conf.json` 的 main 窗口 `alwaysOnTop: false`，
  用户想驻顶由设置项 `settings.mainPinned` 决定。
- **窗口行为以设置项为单一事实源**：`settings.barPinned` / `settings.mainPinned` 由主窗口
  `main.tsx` 的 `useAppStore.subscribe` 驱动 Rust（`bar_show`/`bar_hide`、`app_set_pinned`）；
  订阅**必须限定 `windowRoot === 'main'`**（贴条窗也跑 main.tsx，不判断会自己叫自己）。
  `src/lib/store.ts::withDefaults` 负责补默认值，故旧 `settings.json` 缺新字段也安全。
- **用户可选集合一律「补默认值 + 忽略失效项」**（V19 #4）：`settings.quickActionIds`
  存自选快捷入口 id 数组，渲染时过滤掉已不存在的 id，缺字段回落到 `DEFAULT_QUICK_ACTION_IDS`。
- **笔记 UI 只在工作台**：`note-create`/`note-list` 命令收敛为「打开工作台」，TodoView 的
  「来源笔记」经 `useNotesStore.requestFocus` 定位（同窗口共用 store，无需 IPC）；
  `NoteWindow.tsx` / `NoteListView.tsx` 为休眠代码，无 UI 入口，勿再接线。
- **所见即所得 Markdown（`src/components/RichMarkdown.tsx`）**：输入用 `contentEditable` +
  输入事件里就地转换，对外**只暴露 Markdown 文本**（`Zustand/store/SQLite` 零迁移），只读展示走
  `MdText` / `renderMarkdown`。**改这个文件前必须先读组件头部的「浏览器内核踩过的坑」**（6 条），
  并按 §6 做逐字符回归。核心铁律：光标必须以**零宽哨兵 `ZWSP`（offset 1）**为落点、新块必须带
  种子、`marker` 必须先 `stripZwsp`、搬动节点后必须手动还原选区。
- **桌面整理是「文件引用型」**：格子条目只是原文件路径引用，**一键整理（`grid_auto_arrange`）也
  绝不移动/复制任何文件**；布局备份/还原存 `grid_meta`（key `layout:<uuid>`），还原前自动备份到
  `auto-before-restore`。这是用户明确要求（对标腾讯桌面整理，但不得产生磁盘副作用）。
- **浏览器冒烟**：`node scripts/dev-static.cjs 41901` 起静态服务指向 `dist`，配合
  agent-browser 深链 `?tool=<id>` / `?module=<id>` / **`?demo=richmarkdown`**；浏览器无 SQLite/Tauri IPC，
  「加载待办失败」「快捷入口需桌面环境」属预期提示，不是缺陷。

## 8. V20 确立的约定（工具基建 / 桌面挂载 / 贴条）

- **工具「示例条」是框架能力，不再各写各的**：`src/components/SampleBar.tsx` +
  `CommandShell` 的 `samples` 属性。每条示例自带 `apply` 闭包（可只填输入框，也可「填 + 开开关 + 切页签」，
  或一次设置多个字段）。示例条挂在**内容区之上且 `shrink-0`** —— `fill` 模式内容区是 `flex-1`，
  示例条必须是它的兄弟节点，塞进内容区会把输入框挤出可视区。新工具默认配 3–5 条示例。
  工具清单与逐工具优化方案见 `docs/03-development/TOOL-OPTIMIZATION.md`。
- **工具状态持久化用 `useToolState`**（`src/hooks/useToolState.ts`，localStorage、防抖 400ms、
  卸载 flush、256KB 上限）。已接：`cron-descriptor` / `regex-tester` / `text-diff`；其余约 3 行/工具。
- **结果区带高亮用 `CodeBlock`**（零依赖，按语言拼大正则扫 token）；Markdown 混代码块用
  `MarkdownWithCode`（按 ``` 围栏切分，未闭合围栏回退纯文本）。
- **文本对比对齐靠布局不靠事件**：单一滚动容器 + CSS Grid 两列 → 行对行对齐、滚动天然同步；
  虚拟空行 = `line === null` 渲染虚线占位块。**不要回到「两个独立容器 + 同步滚动监听」那套。**
- **贴条（`bar.rs` / `WorkstationBar.tsx`）**：
  - 高度由前端量出后经 `bar_set_height` 回报；`resizable(false)` 只拦用户拖拽，程序性 `set_size` 照常生效，
    但改高后**必须紧跟 `set_position()`** 才能保持顶部居中（Windows 以中心为锚点拉伸）。
  - 前端**必须外套一层 auto height 的「量高壳」**（`w-full`，不带 `h-full`）再量，否则
    「窗口高 → 量出窗口高 → 再设窗口高」会自激。展开态记忆在 localStorage（与主窗口同 origin）。
  - 折叠态与展开态共用同一份 JSX：折叠态包装层用 `display: contents` 让子块直接成为卡片 flex 项。
- **桌面挂件（`grid.rs`）**：真正「画在桌面上」= `SetParent(hwnd, 桌面宿主)`（Progman / WorkerW），
  **不是** `SetWindowPos(HWND_BOTTOM)`。系统图标显隐走 `ShowWindow(SysListView32)`，
  **绝不移动/删除用户文件**；启动 `heal_desktop_icons`、退出 `restore_desktop_icons`（图标一定回来）。
- **windows crate 0.58 写法**：`FindWindowW/FindWindowExW` 返回 `Result<HWND>`
  （用 `.unwrap_or_else(|_| null_hwnd())`）；`SetParent` 第二参**不是 `Option`**
  （空父窗传 `null_hwnd()`，不是 `None`/`Some(...)`）。
- **ShellExecute 兜底链（`sys.rs`）**：`.cpl` → `rundll32 shell32.dll,Control_RunDLL`；
  `.msc` → `mmc.exe`；目录 → `explorer.exe`。返回码 **193 = 不是 PE**，**31 = `SE_ERR_NOASSOC`**（无文件关联）。
- **前端新文件过 `tsc` 后，lucide 图标名用 node 脚本比对 `lucide-react` 导出表**
  （`Settings`/`MonitorUp`/`PenLine`/`ChevronUp` 等实测都存在，别靠猜、也别靠旧版本印象）。
- **交互元素必须真有效**：V20 挖出 5 个「界面有入口、点了不生效」的假功能（假复制按钮、切换重置、
  冷启动空表、闭包竞态）。QA 检查项已加：**每个按钮的副作用是否真实发生**。
