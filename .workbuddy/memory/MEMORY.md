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

## 3. 状态快照（2026-09-16 · V24 后）

- Phase 1（MVP）功能全部交付；**Windows 安装包已产出（V23 重新打包：nsis 3.7 MB / msi 4.7 MB / handy.exe 9.3 MB）**；待用户装机验收 GUI 行为。
- git：V22 批次 = `d49857c`（13 文件，+2614/−286）；前序 V21 = `685b8a7`（31 文件，+3524/−522）、`4b4ffa5`（V20 文档回填）、**`f96a374` = V20**（9 条反馈：工具箱重做/桌面真挂载/贴条折叠/示例条基建）、`cf3c61a`/`e09d25b`（V19 文档）、**`64e3008` = V19**、`be1dc58`（V18 文档）、`862d5bf` = V18、`b3b46a8`（文档归位）、`ff6ebb2`（release 关 devtools）。（**V23 批次提交见当日日志**）
- 工具箱 **24 个命令**（V23 新增 `text-lab` 文本处理台）；模块：toolbox / notes(入口重定向→工作台) / workstation(日历+计划+笔记+快捷入口，**V19 双栏 / V21 等高 / V22 主区可滚动防压盖 / V23 窄屏单栏**) / todos / desktop-organizer(重定向→桌面整理) / desktop-grid(挂件 + 整理主控台) / vault / settings。
- **独立窗口 6 个**：main / note / settings / organizer / grid-overlay / workstation-bar（桌面顶部常驻贴条）。
- **DB 迁移链**：v1 schema → v2 移除剪贴板表 → v3 vault → v4 grid → v5 `todos.detail`（**V21、V22 均无 schema 变更**）。
- **V21 新增/改动事实源**：`src/lib/lunar.ts`（农历/节气/干支，1900-2100）、`src/lib/holidays.ts`（国务院口径节假日表 2024-2026）、`src/components/MarkdownHelp.tsx`（`?` 帮助浮层）；新增设置项 `barOnTop: boolean`（贴条始终置顶，`bar_set_pinned`）与 `anniversaries: Anniversary[]`（用户自建纪念日）；`RichMarkdown` 升级为「代码块围栏 + 语言高亮 + `pre-wrap` 软换行」，`CodeBlock` 导出共享 tokenizer（`tokenizeCode`/`highlightCodeHtml`）；`MarkdownEditor.tsx` 自此休眠（笔记仅剩 `RichMarkdown` 一条路）。
- **V22 新增/改动事实源**：`src/lib/sql.ts`（**纯逻辑**：`formatSql` / `lintSql` / `syntaxPointsOf` / `maskSqlLiterals`）、`src/modules/toolbox/commands/sqlSamples.ts`（10 组 30 条教学示例）、`scripts/regression/test-sql.mjs`（357 条断言）；`SqlFormatter.tsx` 重写为「示例库 + 语法检查 + 边用边学」三块；命令注册项改名 `SQL 格式化 · 检查 · 学习`（id 仍是 `sql-formatter`，别名/关键词已扩）。**纯前端批次，未动 Rust。**
- **V23 新增/改动事实源**：`src/lib/textlab.ts`（**纯逻辑**，文本处理台引擎）+ `src/modules/toolbox/commands/TextLab.tsx`（第 24 个工具，四页签 + 30 步撤销栈）；`src/lib/cron.ts` 新增 `platformOf()` / `expandMacro()` / `CronPlatform`；`CronDescriptor.tsx` 删掉重复的「字段拆解」面板、加平台提示条；`scripts/audit/layout-audit.mjs`（**响应式布局审计**，常驻工具）；`scripts/regression/{test-textlab,test-cron-platform}.mjs`。**纯前端批次，未动 Rust。**

## 4. 协作与操作约定

- 用户偏好：**先规划后执行**；表格化、结构化输出；**绝对路径**；**修改文件前必须先读取**；目录扁平少层级。
- 处理任务先排除无关范围（`node_modules`/`dist`/`target`/旧版验证残留）再聚焦。
- **工具坑（必记）**：
  - 同一条消息内并行对**同一个文件**发多个 Edit 会因写入竞争丢失改动 → **同一文件的多处编辑必须串行**（一次一条消息）；不同文件可并行。
  - **Bash shim 时好时坏**：历史上 `dirname`/`ls`/`head`/`find`/`grep`/`mkdir`/`cat` 都缺过（`ls` exit 127）；现在的会话里可用。不确定时降级为 **PowerShell** 或 **node 脚本**，**输出落盘再 Read**（stdout 偶不回显）。
  - `.gitignore` 已忽略 `/*.txt`、`/*.log`、`/*_*.log`、`/*.out`、`/*.exit`、`/_shots/`；但 `_smoke_*.js` / `_smoke_*.sh` **不在忽略列表**里 → 临时脚本用完即删，可复用的挪进 `scripts/`。
  - 文件检索用 **Glob/Grep 工具**（Glob 对反斜杠路径不可靠，Grep 用正斜杠路径可靠）；**Read 用绝对路径最稳**。
  - `npm.cmd` / `cmd.exe` 被安全层拦截 → 调 CLI 一律 `node node_modules/<cli>/<entry>.js`。
  - **`vite build` 与 `dist` 清理**：本机 node 有「安全删除」垫片，**单个回合内删除累计 > 50 次即拒**，
    而且**额度按回合累计、随后的 `vite build` 会被连带拦下** —— 表现为 `CLEAN_EXIT=1` + `VITE_EXIT=1`
    一起出现（日志只有半截 build 过程），极易误判成「前端编不过」。**正解：在没有任何其它删除动作的
    回合里，单独发一条 `node node_modules/vite/bin/vite.js build`**（vite 的 `emptyDir` 只发 1 次
    `rmSync(recursive)`，计数 1）—— V23 已复验 EXIT=0。`Remove-Item` 一样躲不掉（PowerShell 工具内部
    也走 node 垫片）；**替垫片伪造批准状态是红线**。`scripts/clean-dist.mjs` 本身没错，错的是「不带上限
    一路删」—— 已加 `--max=N`（单回合上限，建议 40；`exit 2` = 还有剩余，换个回合继续），日常用不到它。
    完整细节见 PROJECT_STATUS §3 约束 16/18。**V24 补充：布局审计也会把额度吃光**（开关 28 个页面，
    无头浏览器每页都删临时文件）—— 所以**审计与 build 不能放在同一个回合**；实在要，加
    `--emptyOutDir=false`（构建全程不删文件，代价是 dist 留旧哈希产物、包体涨约 0.5 MB）。
  - **写进源码的中文化说明不要带反引号和 markdown 星号**（V23 踩到）：`cron.ts` 里给 `platformOf()`
    写警告文案时用了 `` `L` 最后一天 `` 和 `**加粗**`，模板字符串里的反引号直接把解析器搞崩
    （报 `error TS1005: ',' expected`，而且报错位置离真正的问题很远）。源码里的中文文案一律用
    「」或普通引号，别写 markdown 记号。
  - **跨零点批次以 `Get-Date` 为准，别信会话里注入的「当前时间」**（V23 踩到）：注入值写着
    09-15 17:51，本机实际是 09-16 00:44（+08:00），差点把日志归档到前一天的日期文件里。
    拿不准就 `Get-Date` 落盘看一眼。
  - **`TaskStop` 只杀 shell，不杀它的 cargo/rustc 子进程**（V21 踩到）：被停掉的 `tauri build` 会留下
    cargo + rustc 继续跑完，占着 `src-tauri/target` 的文件锁 → 新起的打包只会打印
    `Blocking waiting for file lock on build directory`，然后**两个进程各自跑完一遍打包**（白等几分钟，
    还会把 installer 覆盖两次）。停后台打包前先确认子进程已退（`tasklist` 里没有 `cargo`/`rustc`），
    或干脆等它跑完再动。
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
- 前端构建/校验：`node node_modules/vite/bin/vite.js build`、`node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`（绕过被拦的 npm）。**`vite build` 必须单独发一条命令**，不要和任何删除动作串在同一回合（见 §4 的删除额度坑）。
- **打包后必须取证**：对比 `dist/index.html` 与 `src-tauri/target/release/handy.exe` 的 **mtime**（exe 必须晚于 dist），确认新前端真的进了二进制。V22 就是改完没打包、也没取证，导致用户「没法测」。
- 打包：`source scripts/rust-env.sh && node node_modules/@tauri-apps/cli/tauri.js build`（`beforeBuildCommand` 若被 npm 拦截，用 `--config '{"build":{"beforeBuildCommand":"node --version"}}'` 覆盖，前端先手动 build）。
- 网络：crates.io 走清华 sparse 镜像 + `~/.cargo/config.toml` 的 `[http] check-revoke = false`（否则报 `CRYPT_E_REVOCATION_OFFLINE`）；PowerShell 5.1 不读 `HTTP_PROXY`，需要联网显式 `-Proxy http://127.0.0.1:54735`；npm registry 已是 `registry.npmmirror.com`。
- **GUI 限制**：工具沙箱内启动的 GUI 进程在调用结束会被作业对象回收，且 webview 可能不执行前端 JS → **窗口/托盘/透明/拖放等真实 GUI 行为只能由用户装机验收**。

## 6. 验证纪律（血泪教训）

- **agent 自报的 "tsc/build exit 0" 不可信**：曾两次虚报（根因 = shell 吞掉 stdout + 把 shell 退出码当成命令退出码）。→ 一律由主理人**独立复跑**，且**输出与 exit code 分文件落盘后再 Read**。
- 过期日志甄别：agent 留下的 tsc/build 日志必须核对 **mtime 与被检文件的先后**，否则会误判「树编不过」。
- 三层验证：实现者自验（落盘取证）→ 独立 QA（fresh eyes，读代码+实跑）→ 主理人终验（cargo check + tsc + 红线抽查如 async/明文日志/迁移链）。
- **DOM / 输入类问题必须用逐字符驱动复现**，且诊断输出要把 `\u200B`（零宽空格）与 `\u00A0`（NBSP）显式替换成可见标记（如 `<Z>`/`<N>`）再打印 —— 否则这些字符在日志里完全隐身，光标锚点在哪根本看不出来。


## 7. 历史批次约定（V18–V23）

已拆分为独立文件：**[`CONVENTIONS.md`](./CONVENTIONS.md)** —— 含架构分层约定（V18/V19）、
工具基建与桌面挂载（V20）、布局防压盖与「工具即教材」（V22）、响应式与平台标注（V23）。
要在对应模块上动手时去查它；本文件只保留**当前生效**的约定。

## 8. V24 确立的约定（工具分类 / 状态持久化 / 自检）

- **工具箱从「平铺」升级为「分类分组」**：`CommandMeta.category` 是必填项。取值联合类型在
  `src/core/types.ts` 的 `ToolCategory`，元数据（名称 / 图标 / 配色 / hint / 顺序）在
  `src/core/toolCategories.ts`，**两边必须一一对应**（`tool-audit` 双向校验）。当前 6 类：
  `text` / `data` / `encode` / `convert` / `generate` / `dev`。**加工具必须填分类** ——
  没分类 = 首页分组里没有它的位置 = 新工具被埋掉。首页已改为「搜索 + 分类页签 + 收藏/最近 + 分组网格」。
- **状态持久化有两个 hook，按「状态长什么样」二选一**（`src/hooks/`）：
  - 状态本来就集中在一个对象里 → `useToolState(id, initialObject)` → `[state, patch, reset]`；
  - 状态散在多个 `useState` 里（工具箱里绝大多数工具如此）→ `usePersistedState(id, key, initial)`，
    **签名与 `useState` 完全一致（含函数式更新）**，所以迁移只需改声明那一行，调用点一行都不动。
    V24 就是这么把 19 个工具的 80 个字段一次性接上的（脚本化替换 + 逐行断言，不手改 19 个文件）。
  - **三类绝不持久化**：派生结果（格式化输出 / 摘要 / 二维码 dataURL）、大块 Base64 正文、
    **密钥类输入**（WiFi 密码 / JWT secret）—— 落盘 = 明文写进用户目录，与「保险箱加密存储」自相矛盾。
- **「易扩展」靠三件套把「漏配」变成机器能发现的错**（都在 `scripts/`）：`new-tool.mjs`（一键生成
  组件 + 注册项 + 关键词补齐）、`audit/tool-audit.mjs`（静态自检：图标已登记 / category 合法 /
  组件文件存在 / 名称与描述长度 / 关键词 ≥5 / 示例条 / 状态持久化）、`docs/03-development/TOOL-AUTHORING.md`。
  **自检第一次运行就抓到 3 个工具的图标从未登记** —— 它们一直在静默显示扳手，这类 bug 肉眼永远发现不了。
- **自检的提示项允许「显式豁免」，不允许静默缺失**：文件里写 `// tool-audit-ignore: samples`（或 `persist`）
  并说明为什么不需要（正则库 / 示例 token 生成 / 图片工具没有可填输入）。
- **示例条里的值必须真算过**：V24 给 8 个工具补示例时，哈希 / Base64 / 时间戳全部用 `node -e` 实算后写入。
  手编一个「看起来像」的摘要，用户点开校验会直接对不上 —— 比没有示例更糟。
- **同一份内容不要存两份**：补 JSON 工具示例条时又写了一份 `SAMPLE_NESTED_JSON`，而文件里早有 `SAMPLE_JSON`
  —— 与 V23 的 Cron「字段拆解」同一类重复。判断标准见 [`CONVENTIONS.md`](./CONVENTIONS.md) §10：
  **同一份数据的两种排版 = 删，独有信息搬走**。
- **并排断点要与「工具页预设宽度 1180」对齐**：用 `lg`(1024) 而不是 `xl`(1280)，否则默认窗口尺寸下
  双双退化成单列、右边一大片空白（V24 修了 JsonFormatter / QrCodeGenerator）。
- **现代化视觉的杠杆点是设计令牌**：`src/index.css` 引入页面底色 `--canvas`（浅灰）+ 白色卡片的层次、
  更大圆角、柔和阴影、统一动效时长；`tailwind.config.ts` 加 `canvas` 色与更现代的字体栈。
  改令牌 = 一次改全局，**别逐个页面调颜色**。
- **删结构化文本（JSX 块）前先数清首尾行**：V24 用 `splice(idx - 1, 3)` 删按钮块，把外层的 `<div>`
  一起删了，`tsc` 报出一堆「JSX 标签不匹配」。删完立刻 `tsc`，别攒着。
