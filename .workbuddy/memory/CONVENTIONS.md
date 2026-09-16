# Handy · 顺手 — 历史批次约定（V18–V24）

> 从 [`MEMORY.md`](./MEMORY.md) 拆出来的：这些是**逐批次沉淀的架构与实现约定**，
> 属于「要动对应模块时来查」的参考，不必每次会话都读 —— 之前它把 MEMORY.md 撑到 16.9k，
> 导致注入被截断（截断点落在 §6 中间，越靠后越读不到，存档越全反而越无效）。
> 最新一批的约定仍在 MEMORY.md；逐日进展见同目录 `YYYY-MM-DD.md`；现状总览见 `../PROJECT_STATUS.md`。

---

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
- **纯逻辑回归（V21 转正，V22 扩容到 4 套，V23 到 6 套 / 715 条断言）**：`src/lib/` 下不碰 React/DOM/Tauri 的纯模块
  （`cron` / **`cron` 平台判定** / `lunar` / `holidays` / **`sql`** / **`textlab`**）一律进
  `scripts/regression/run.mjs`（**6 套**：cron 114 · cron-platform 45 · lunar 32 · holidays 30 ·
  sql 357 · textlab 137；`test-sql.mjs` 一套 **357 条断言**）。**关键手法：Node ≥ 22.18 自带原生类型剥离，
  测试脚本直接 `import '../../src/lib/x.ts'` 即可，不要为测试引入 esbuild 打包步骤**（V21 最初就是手工
  esbuild 出 `_v21_*.mjs` 再跑，纯属自找麻烦）。加套件 = 新写 `test-<name>.mjs` + 加进 `run.mjs` 的 `SUITES`。
  这几个模块历史上都翻过车（cron 的 Quartz `N/step` 展开、lunar 的闰月游标漂移、sql 的「抹平用空格」导致误报），
  **改动后打包前必跑**。
  另：`holidays.ts` 的数据表用「全年逐日统计四类之和 = 全年天数（365/366）」当断言，能兜住区间写错。
- **面向用户当教材用的常量数据也要进回归（V22 新）**：`src/modules/toolbox/commands/sqlSamples.ts`
  里 30 条示例 SQL 是给用户照着学的，`test-sql.mjs` 末组断言要求每条 ①无 error 档问题 ②格式化后仍无 error
  ③至少识别出一个语法点。**示例本身出错 = 「学习指导」误人子弟**，所以教学数据要跟代码同一个标准守。

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
- **桌面挂件（`grid.rs`）**：~~真正「画在桌面上」= `SetParent(hwnd, 桌面宿主)`~~ ⚠️ **V21 已推翻**
  （`SetParent` 会丢逐像素 alpha 变灰块 + 触发窗口重建导致点击闪 + Explorer 重启后失效）。
  现行方案是 **顶层窗 + `SetWindowPos(hwnd, host, …, SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE)` 插在桌面宿主之上
  + `WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW`**，也**不是** `HWND_BOTTOM`（会掉到壁纸下面）。
  系统图标显隐走 `ShowWindow(SysListView32)`，
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

## 9. V22 确立的约定（布局防压盖 / 工具即教材）

- **网格里不允许 `min-h-*` 大于父格子**：V22「工作台挤在一起」的根因就是四层 `min-h-*`
  （网格行 440 + 计划 320 + 便签 `min-h-[420px]` 塞在 `h-[260px]` 壳里）同时超过可用高度，
  而网格项默认 `min-height:auto` **不会收缩** → 内容向下溢出自己的单元格，后渲染的面板把它盖住。
  **等高的正确做法**：父行给明确高度（`grid min-h-0 flex-1`）+ 子项 `min-h-0` + 把滚动条交给最内层；
  实在要保底就**让最外层内容列自己滚**（`flex min-h-0 flex-1 flex-col overflow-y-auto`），
  宁可出滚动条也绝不叠内容。新面板一律 `min-h-0 + overflow-hidden`，不要写 `min-h-[数字]`。
- **面向用户的「教学型工具」分三块落位（SQL 工具为样板）**：① **示例库**（分组 chip，点一条即填充，
  每条带 `takeaway` + `points` 讲解）② **实时检查**（分 error/warn/info 三档，每条必须给「怎么改 + 为什么」，
  只报错不给解法等于没写）③ **边用边学**（从当前输入自动识别语法点，点开一句话讲透）。
  **语法不是查来的，是在改自己那段时顺手看到的** —— 这是用户要的产品感。
- **检查器一律「宁可漏报也不误报」，且判据要跑在抹平后的文本上**：`lintSql` 先用 `maskSqlLiterals`
  把字符串/注释抹平（**填充符必须是 `\u0000` 这类非空白非单词字符，不能用空格** —— 用空格会让
  `in ('a', 'b')` 变成 `in (  ,  ,  )`，逗号「隔空」看到右括号而误报合法 SQL；同一个根因还误报
  `select a, 'x' from t` 与「末条是注释 = 缺分号」）。**代价**：凡判据依赖「后面跟着引号」的规则都会失效
  （`LIKE 'a%'` 已改为 `\blike\b`）。
- **格式化器只动换行与缩进，绝不改内容**：`formatSql` 先把字符串/反引号标识符/注释整段换成占位符，
  排版完成后再还原 —— 否则 `where name = 'from here'` 会被子句规则切开、`-- 注释` 会被折叠空白吃掉换行
  而吞掉后面整条语句。子句换行**必须单次交替匹配且长的排前面**（`LEFT JOIN` 先被插换行、再被 `JOIN`
  匹配到中间那个空格，会输出 `LEFT\n  JOIN` —— 这是真出过的事故）。
- **输入框不做输入期语法高亮**：桌面端 `contentEditable` 上色会在中文输入法下崩光标（V19/V21 已验证），
  所以 SQL 输入保持朴素 `textarea`，**高亮只出现在结果区**（`CodeBlock lang="sql"`）。别为了「好看」把
  这条推翻。
- **浏览器冒烟可以直接看工具页**：`vite` dev server + `agent-browser`，深链 `?tool=<id>`；
  但 **dev server 与浏览器必须在同一条 bash 调用 / 同一个 node 脚本里**（沙箱回收后台进程），
  且默认视口约 **1078×545**，比真机 1180×820 **矮 275px** —— 判读截图时要想到「挤」可能只是视口小。

## 10. V23 确立的约定（响应式 / 文本处理 / 平台标注）

- **响应式铁律：`flex-1` 在 auto 高度的父容器里不是「撑满」而是「可被压缩到 0」**（`flex-basis: 0%`）。
  窄窗口下它会先把内容压扁而不是产生滚动条 —— V23 实测 `CalendarPanel` 的 42 格网格被压到只显示 20 号、
  `PlanPanel` 被压成 19px 空壳。**要「撑满」必须给父级明确高度**；给不了就让内容自然排布、滚动交给外层。
  因此：**一切 `flex-1` / `min-h-*` 都用 `lg:` 前缀关进宽屏**，窄屏走「单栏 + 内容高度 + 外层滚动」。
  这与 §9「网格里不允许 `min-h-*` 大于父格子」是同一件事的另一面（一个管「撑爆」，一个管「压扁」）。
- **布局改动要跑数据，不要只靠眼睛**：`node scripts/audit/layout-audit.mjs` 对 24 工具 + 3 模块页 ×
  3 档视口（680/1024/1680）实测 `ox`/`mox`（横向溢出）、`clipX`/`clipY`（**内容溢出但不滚**）、
  `overlap`（**非祖孙块级矩形相交**）+ 截图。**只看溢出会漏掉所有真缺陷** —— V23 那两处 `ox` 全程为 0，
  只有 `clipY` / `overlap` 抓得到。参数：`--widths=` / `--only=` / `--shots`。
  dev server 与浏览器同前条，必须在同一条命令里。
- **文本处理类工具的换行必须全程带着走**：切行统一吃 `\r\n` / `\r` / `\n`，拼回时按原风格还原。
  直接 `split('\n')` 会在 Windows 文本行尾留 `\r`，于是「去重」把 `a` 和 `a\r` 当成两行 ——
  这是这类工具最经典的假 bug。`src/lib/textlab.ts` 的 `detectEol` / `splitLines` / `joinLines` 是标准解法。
- **同类操作用「数据驱动表 + 单个 switch」**：`LINE_OPS`（20 项 / 5 组）是唯一事实源，`applyLineOp` 是唯一
  switch —— 新增行操作 = 加一条数据 + 一个分支，界面与回归自动覆盖。别写成 20 个按钮各自 20 段逻辑。
- **平台方言要「标」不要「删」**：Quartz（6/7 段，Java / Spring / XXL-JOB 在用）不是冷门语法，
  真正的坑是「贴进 crontab 不报错、只是不跑」的静默失效。做法是 `platformOf()` 判定 + 常驻提示条 +
  误用自动变警示色，而不是砍掉功能。**判定必须精确匹配整段**（`L` / `5L` / `15W` / `1#2`），
  不能粗筛 `/[LW#]/` —— `JUL` 含 L、`WED` 含 W，粗筛会把最普通的写法误报，假警报比不提示更糟。
  回归里必须有**反向用例**（`test-cron-platform.mjs` 守着 JUL/WED/SAT 不得报警）。
- **重复 UI 面板要敢于删、但要把独有信息内联走**：V23 删掉 Cron 的「字段拆解」前，先确认它与逐段编辑
  渲染的是**同一份数据**，再把它独有的两样（展开取值、出错定位）并进保留的那个面板。
  判断标准：**同一份数据的两种排版 = 内容重复，删；独有信息是另一回事，搬走**。
- **体量大的功能必须给分阶段范围与优先级**：用户提「参考 Notepad++ 的文本处理」时明确要求说明工程体量
  并分阶段。做法见 PROJECT_STATUS §1.9.3 —— Phase 1 只做「纯字符串变换、能进回归」的部分（价值密度最高
  且正确性可证明），Phase 2 做「把单次操作升格成可重复流程」（批量 / 配方 / 巡检报告），
  Phase 3 明确**不做**（编码互转要自带码表、超大文件要换架构、列块框选是编辑器工程）。
  **产品主张是「方便，而非全面」——做半个 VSCode 不如把 24 个工具都做扎实。**

## 11. V24 确立的约定（视觉令牌 / 工具分类 / 自检体系）

- **现代化视觉的杠杆点是设计令牌**：页面底色 `--canvas`（浅灰）+ 白色卡片的层次、更大圆角、柔和阴影、
  统一动效时长定义在 `src/index.css`，`tailwind.config.ts` 加 `canvas` 色与更现代字体栈。
  **改令牌 = 一次改全局，别逐个页面调颜色。**
- **工具箱从「平铺」升级为「分类分组」**：`CommandMeta.category` 是必填项。取值联合类型在
  `src/core/types.ts` 的 `ToolCategory`，元数据（名称 / 图标 / 配色 / hint / 顺序）在
  `src/core/toolCategories.ts`，**两边必须一一对应**（`tool-audit` 双向校验）。当前 6 类：
  `text` / `data` / `encode` / `convert` / `generate` / `dev`。**加工具必须填分类** ——
  没分类 = 首页分组里没有它的位置 = 新工具被埋掉。
- **状态持久化有两个 hook，按「状态长什么样」二选一**（`src/hooks/`）：
  - 状态本来就集中在一个对象里 → `useToolState(id, initialObject)` → `[state, patch, reset]`；
  - 状态散在多个 `useState` 里（工具箱绝大多数工具如此）→ `usePersistedState(id, key, initial)`，
    **签名与 `useState` 完全一致（含函数式更新）**，迁移只需改声明那一行，调用点一行都不动。
    V24 就是这么把 19 个工具的 80 个字段一次性接上的（脚本化替换 + 逐行断言，不手改 19 个文件）。
  - **三类绝不持久化**：派生结果（格式化输出 / 摘要 / 二维码 dataURL）、大块 Base64 正文、
    **密钥类输入**（WiFi 密码 / JWT secret）—— 落盘 = 明文写进用户目录，与「保险箱加密存储」自相矛盾。
- **「易扩展」靠三件套把「漏配」变成机器能发现的错**（都在 `scripts/`）：`new-tool.mjs`（一键生成
  组件 + 注册项 + 关键词补齐）、`audit/tool-audit.mjs`（静态自检：图标已登记 / category 合法 /
  组件文件存在 / 名称与描述长度 / 关键词 ≥5 / 示例条 / 状态持久化）、`docs/03-development/TOOL-AUTHORING.md`。
  **自检第一次运行就抓到 3 个工具的图标从未登记** —— 它们一直在静默显示扳手，肉眼永远发现不了。
- **自检的提示项允许「显式豁免」，不允许静默缺失**：文件里写 `// tool-audit-ignore: samples`（或 `persist`）
  并说明为什么不需要（正则库 / 示例 token 生成 / 图片工具没有可填输入）。
- **示例条里的值必须真算过**：哈希 / Base64 / 时间戳全部用 `node -e` 实算后写入。手编一个「看起来像」
  的摘要，用户点开校验会直接对不上 —— 比没有示例更糟。**同理，冒烟断言里的字面量也要对着数据核一遍**
  （V24 它先报了一次假失败：断言写 `books`、而 `SAMPLE_JSON` 里字段是单数 `book`）。
- **同一份内容不要存两份**：补 JSON 工具示例条时又写了一份 `SAMPLE_NESTED_JSON`，而文件里早有 `SAMPLE_JSON`
  —— 与 V23 的 Cron「字段拆解」同一类重复。判断标准见 §10：**同一份数据的两种排版 = 删，独有信息搬走**。
- **并排断点要与「工具页预设宽度 1180」对齐**：用 `lg`(1024) 而不是 `xl`(1280)，否则默认窗口尺寸下
  双双退化成单列、右边一大片空白（V24 修了 JsonFormatter / QrCodeGenerator）。
- **删结构化文本（JSX 块）前先数清首尾行**：V24 用 `splice(idx - 1, 3)` 删按钮块，把外层的 `<div>`
  一起删了，`tsc` 报出一堆「JSX 标签不匹配」。删完立刻 `tsc`，别攒着。
  **迁移 / 替换脚本的自检条件要盯「独立证据」**（如 import 行开头），别盯刚被改写过的位置 ——
  V24 的 import 插入判断写在替换后的行上，判定恒真 → 18 个文件一句都没插上。
- **`tool-audit` 证明不了「点下去真的生效」**：它只能静态看到 `samples=` 写了没有。于是 V24 转正了
  `scripts/audit/sample-smoke.mjs`（真实 dist + 无头浏览器逐个点示例 chip，回读输入框与页面正文断言，
  **连填完以后派生结果算不算得出来一起验**）。**三件套分工：tool-audit 静态、layout-audit 量几何、
  sample-smoke 真点。**
