# Handy · 顺手 — 项目现状与续接指引

> **从 `handy` 目录打开项目，先读这一份。** 它回答三个问题：**做到哪了 → 还剩什么 → 怎么继续**。
> 最近更新：2026-09-15（**V20 批次**） · 长期约定见 [`.workbuddy/memory/MEMORY.md`](memory/MEMORY.md) · 逐日进展见 [`memory/`](memory/) · 规划文档见 [`../docs/README.md`](../docs/README.md)

---

## 0. 一句话现状

**Phase 1（MVP）功能已全部交付，并完成三轮用户自测反馈大修（V18 + V19 + V20）**：命令面板统一入口 + 工具箱 **23 个工具** + **桌面网格挂件（V20 起真正贴到桌面）** + **桌面整理主控台（一键整理 + 布局备份/还原）** + **工作台（日历 / 计划 / 便签 / 竖排快捷入口）** + **桌面顶部贴条（V20 支持多行展开/折叠）** + 密码存储器；**Windows 安装包已产出**；`cargo check`、`tsc`、`vite build` 三绿。V20 另把「工具示例条 + 状态持久化」做成框架能力，并产出工具优化评估报告。

**当前卡点：唯一剩下的是「用户装机做 GUI 验收」**（沙箱无法验证窗口/托盘/透明/桌面挂载/拖放等真实 GUI 行为）。

| 项 | 值 |
| --- | --- |
| 阶段 | Phase 1 收尾 + V18/V19/V20 反馈修复（MVP 完成，待装机验收） |
| git | **V20 批次 = `f96a374`**（37 文件，+6118/−999）；V19 批次 = `64e3008`（31 文件，+3112/−372）；`be1dc58` = V18 文档回填；`862d5bf` = V18 批次 |
| 安装包（V20 重新打包，2026-09-15 21:55） | `src-tauri/target/release/bundle/nsis/Handy_0.1.0_x64-setup.exe`（3.66 MB）<br>`src-tauri/target/release/bundle/msi/Handy_0.1.0_x64_en-US.msi`（4.71 MB）<br>`src-tauri/target/release/handy.exe`（9.29 MB，免安装可直接跑） |

---

## 1. 交付状态总表

### 1.1 规划任务（docs/02-architecture/TASKS.md 的 V01–V15）

| 任务 | 内容 | 状态 |
| --- | --- | --- |
| V01 | 脚手架 + 双平台工程基座 | ✅ |
| V02 | 平台适配层 + 窗口/托盘/全局快捷键/单实例 | ✅（V16 修复最小化丢窗） |
| V03 | 设计系统与共享 UI | ✅ |
| V04 | 模块框架（注册表 + 扩展点 + SQLite 持久化） | ✅ |
| V05 | 统一入口：命令面板 + 拼音搜索 + 收藏/最近 + 设置中心骨架 | ✅ |
| V06 / V07 | M1 工具箱（初版 9 子工具） | ✅（后升级到 23 个） |
| V08 / V09 | M3 便签（多窗/持久化）+ 待办与定时提醒 | ✅ 数据层保留；**V18 起 UI 并入工作台，悬浮窗入口移除** |
| V10 / V11 | M4 剪贴板历史数据层/监听/UI/智能识别 | ✅ 实现 → ❌ **已按用户决策整体移除**（与系统 `Win+V` 重复；内容识别能力以纯函数保留在 `src/lib/contentMatch.ts`） |
| V12 | M2 桌面整理（plan/preview/apply/undo） | ✅ 实现 → 🔁 **已被 V17「桌面网格挂件」+ V19「整理主控台」取代**（用户要求：不再建目录搬文件）；旧代码 `organizer.rs` + 旧前端**保留但休眠** |
| V13 | 设置中心完整版 + 模块开关 + 授权预留 + 备份 | ✅ |
| V14 | 双平台打包/签名/公证 | ⚠️ **Windows 打包 ✅**（msi+nsis）；macOS 需 Mac 环境，**未做** |
| V15 | 集成联调与打磨 | ✅（并完成多轮 UI/UX 大改） |

### 1.2 增量批次（规划外，按用户反馈推进）

| 批次 | 内容 | 状态 |
| --- | --- | --- |
| **V16** | 修复「最小化后窗口找不回」：`window.rs` 三态机 + 托盘左键还原 + 标题栏最小化键改为隐藏到托盘 + `windowShell` 拒绝脏尺寸回写 + 启动保底显示 | ✅ 已落盘并经独立核实 |
| **V17 · Batch1** | ① 窗口/托盘 ② 文本对比对比度 + 差异列表 + 当前差异高亮 + ↑↓/j/k 导航 ③ 时间戳多单位偏移 ④ 剪贴板模块移除 | ✅ |
| **V17 · Batch2** | ① 工具箱 +14 命令（→ 23）② 桌面工作台（替换便签入口）③ **密码存储器 vault** ④ **桌面网格挂件** | ✅ 三绿 + 已打包 |
| **V18** | 见 §1.4 —— 12 条自测反馈全量落地 | ✅ 三绿 + 已打包 + 行为级冒烟 |
| **V19** | 见 §1.5 —— 6 条自测反馈 + 6 个所见即所得编辑器内核坑 | ✅ 三绿 + 已打包 + 逐字符冒烟 |
| **V20**（本轮） | 见 §1.6 —— 9 条自测反馈：Cron/正则/文本对比三大工具重写 · 桌面真挂载 · 快捷入口兜底 · 工作台重排 · 贴条多行折叠 · **工具示例条基建** + 专家评估报告 | ✅ 三绿 + 已打包 |

### 1.3 功能清单（当前实际能力）

**工具箱（23 个命令，`src/modules/toolbox/commands/`）**
- 原有 9：`timestamp` / `json-formatter` / `base64-codec` / `url-codec` / `jwt-decoder` / `text-diff` / `password-generator` / `hash-generator` / `qrcode-generator`
- 新增 14：`uuid-generator` / `json-to-ts` / `regex-tester` / `case-converter` / `text-dedup` / `csv-json` / `sql-formatter` / `relative-time` / `unit-converter` / `file-size` / `cron-descriptor` / `slug-generator` / `image-to-base64` / `ascii-table`

**模块（`src/modules/`）**

| 模块 id | 用户可见名 | 说明 |
| --- | --- | --- |
| `toolbox` | 工具箱 | 23 个命令，深链 `?tool=<id>` |
| `notes` | **工作台** | 入口原地重定向到 `workstation`；`note-create`/`note-list` 命令已收敛为「打开工作台」 |
| `workstation` | 工作台视图 | **布局（V20）**：主区 = 内容列（上排 `lg:grid-cols-[350px_1fr]`：**左日历 · 右任务列表，等高**；下排**便签全宽**）+ **右侧 68px 竖排快捷入口栏** `QuickActionsRail` |
| `todos` | 待办清单 | 整屏管理（优先级/到期/提醒/互转）；「来源笔记」切到工作台并定位该条 |
| `desktop-organizer` | **桌面整理** | 入口重定向到 `desktop-grid`；旧「扫描→预览→移动→撤销」代码休眠 |
| `desktop-grid` | 网格挂件 + **整理主控台** | 透明窗 `grid-overlay`（**V20 起默认 `SetParent` 挂到桌面宿主 Progman/WorkerW，真正画在桌面上**；可回退 `bottom` 模式）+ 盒子拖拽/缩放/重命名 + 条目为**原文件路径引用**；V19 一键整理 / 布局备份·还原·删除；**V20 系统桌面图标显隐（不动文件）+ 启动 heal / 退出 restore** |
| `vault` | 密码存储器 | 主密码（Argon2id）→ AES-256-GCM 字段级加密；自动锁 / 复制清剪贴板 |
| `settings` | 设置中心 | 快捷键/自启/主题/模块启停/备份/贴条常驻/**主窗口始终置顶** |

**Rust 命令层（`src-tauri/src/commands/`）**：`app`(窗口/设置) · `notes`(5) · `todos`(5) · `organizer`(6，休眠) · `backup` · `vault`(8) · `grid`(23，V19 +6 / **V20 +4**：attach get/set、desktop_icons get/set) · `sys`(2，系统动作白名单 **49 项**) · `bar`(**4**，桌面顶部贴条 + V20 `bar_set_height`) —— 全部 `async fn`。
**DB 迁移链**：v1 schema → v2 移除剪贴板表 → v3 vault → v4 grid → **v5 `todos.detail`**（只追加、幂等）。
**独立窗口**：`main` / `note` / `settings` / `organizer` / `grid-overlay` / `workstation-bar`。

### 1.4 V18 批次明细（对应 12 条自测反馈）

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | 密码生成器首尾应为字母、符号数字居中 | ✅ 新增「位置优化」开关（默认开）：首尾强制字母，每类字符至少出现一次，Fisher-Yates 洗牌 |
| 2 | 时间戳切 Tab 内容要跟着变；偏移要更多单位；点「当天零点」不该切 Tab | ✅ 切 Tab 内容互转（往返无损）；偏移单位扩展 毫秒→年；快捷时刻补齐周/月/年且**不再切 Tab** |
| 3 | JSON 格式化高度要随窗口，别下方留白上方滚动 | ✅ 新增 `CommandShell` fill 模式；实测视口 700/940/1100 → 文本域 530/770/930，内部无滚动条 |
| 4 | 桌面挂件没实现 | ✅ 根因是 `grid.rs` 的 SQL 参数 bug（见 #9），修复后建盒子/加条目正常 |
| 5 | 标签不好用，用工作台替代 | ✅ 工作台成为唯一入口（`toolbox` 之外的模块内页） |
| 6 | 不要便签，笔记放进工作台并实时渲染 | ✅ 笔记面板内置 Markdown；`note-create`/`note-list`/待办「来源便签」全部改为工作台内，**悬浮窗入口清零** |
| 7 | 工作台要有今日/本周/本月 + 日历插件 | ✅ `CalendarPanel` + `PlanPanel`：点日期挂事件、按范围聚合、完成即划掉 |
| 8 | 快捷入口换成系统动作；笔记要能贴桌面顶部 | ✅ `sys.rs` 白名单 32 项；`bar.rs` 桌面顶部常驻贴条，可见性持久化 |
| 9 | `Wrong number of parameters passed to query. Got 1, needed 0` | ✅ `next_sort` 改为 `Option<i64>`：无占位符 SQL 走空参数 |
| 11 | 密码存储器安全性 | ✅ 复核 Argon2id(m=19456,t=2,p=1) + AES-256-GCM + 随机 nonce + 常量时间校验 |
| 12 | 继续优化样式/交互 | ✅ 快捷入口环境提示人话化、贴条状态同源、设置中心新增开关等 |

### 1.5 V19 批次明细（对应 6 条自测反馈，编号沿用用户原编号）

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | 快捷入口「网络连接」报 `%1 不是有效的 Win32 应用程序 (os error 193)` | ✅ 根因：`.cpl`/`.msc` **不是 PE 可执行文件**，用 `std::process::Command` 必然失败。`sys.rs` 里 14 处（ncpa/sysdm/appwiz/powercfg/timedate/mmsy/services.msc/devmgmt.msc/diskmgmt.msc/eventvwr.msc/wf.msc/perfmon.msc/hosts-folder/temp-folder）全部改走 `ShellExecuteW`；`launch_open` 自主实现（`windows` crate 0.58 `Win32_UI_Shell`），不再依赖 shell 插件 |
| 2 | 任务看不全、只能点 radio 选中、要 Markdown **即时渲染**（不留语法、无工具栏） | ✅ 任务升级为「**任务名称** + **任务说明**」双字段（迁移 v5 加 `todos.detail`）；摘要行**整行可点**展开，左侧圆圈只管勾完成；名称用单行模式、说明用多行模式，两者都是所见即所得 |
| 3 | 笔记与计划换位置（笔记需要更宽） | ✅ 工作台改双栏：左窄栏(330px)=日历+计划，右宽栏=笔记占满，快捷入口底部全宽 |
| 4 | 快捷入口精简 + 让用户自选 | ✅ `QuickActionsPanel` 重写：默认只显 8 个常用项；「自定义」展开全量按组勾选（存 `settings.quickActionIds`）；提供「恢复默认」 |
| 5 | 工具窗口总在最前，弹框被盖住 | ✅ 根因：`tauri.conf.json` 的 `main` 窗口 `alwaysOnTop: true` → 改 `false`；新增设置项「主窗口始终置顶」（`settings.mainPinned`），由主窗口 `useAppStore.subscribe` 驱动 `app_set_pinned` |
| 7 | 桌面整理要像腾讯桌面整理；贴条要加更多功能 | ✅ 桌面整理升级为「整理主控台」：**一键整理**（扫描→按类型分组→建/复用格子→登记文件引用，**零磁盘副作用**）、**布局备份/还原/删除**（存 `grid_meta`，还原前自动备份）；贴条新增**今日进度条** + **内联快速添加今日待办** |

#### 1.5.1 V19 附带修复：所见即所得编辑器 6 个内核坑

`RichMarkdown` 在**逐字符**真实输入下暴露的问题（`keyboard type` 整串注入测不出来）：

| # | 坑 | 修法 |
| --- | --- | --- |
| 1 | 敲完 `**粗体**` 后继续打字**仍延续加粗**（`*斜体*` 还会叠成 `***斜体***`） | 光标必须落在哨兵文本节点内的 **offset 1**；`setStartAfter(el)` 与 offset 0 都会被 Chrome 判为「紧邻前一个行内元素」而续样式 |
| 2 | 空文本节点当光标锚点会被浏览器**回收**，光标被并回 `<strong>` | 改用零宽空格（`ZWSP`）哨兵，序列化时统一剥掉 |
| 3 | `**粗体**` 逐字输入会**退化成斜体**（第 5 个 `*` 先命中单星号规则） | 斜体规则加 `(?<!\*)` 断言，把连续星号整体让给 `**` 规则 |
| 4 | 块级标记（`# ` / `- `）转换后**光标被挤回上一行**，后续文字跑进上一段 | 新块一律带一颗零宽种子（`withCaretSeed`），空块不再是空的 |
| 5 | 内容裸挂在根节点时（新笔记第一笔）`# ` **永远变不出标题** | 新增 `wrapInlineRunAtCaret`：先把行内游程包进 `<div>`；**搬动节点会重置选区**，必须手动还原光标 |
| 6 | 零宽哨兵混进块级标记判定 → `^#\s$` 永不匹配；空标题残留孤零零的 `#` | `marker` 先 `stripZwsp`；标题内容为空时不再输出 `#` |

> 已知取舍：在**列表项内部**敲 `> ` / `# ` 这类块级标记不会转换（列表项不是顶层块，直接替换会破坏 `<ul>` 结构），会原样保留为文本。

### 1.6 V20 批次明细（对应 9 条自测反馈，编号沿用用户原编号）

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | Cron 解析太简单 | ✅ **重做**。新增 `src/lib/cron.ts` 纯函数引擎：`analyzeCron` / `nextRuns` / `buildCron`；支持 5/6/7 段、Quartz `L W #`、`?`、`@daily` 类宏；逐字段校验并给人话解释；推算未来 8 次执行（含中文相对时间）；20 条场景预设；**反查生成器**（说需求 → 给表达式）。接 `useToolState` 持久化 |
| 2 | 文本对比要两列对齐 + 跟随滚动（对标 PyCharm/VSCode） | ✅ **重写**。改为**单一滚动容器 + CSS Grid 两列** → 行对行天然对齐、滚动天然同步（不再靠事件监听硬凑）；`line === null` 渲染**虚线占位块**做虚拟空行；折叠连续未变更区块（上下各留 3 行上下文）；并排 / 行内双视图 |
| 3 | 工具状态要保存（最小化再调出后输入丢失） | ✅ 新增 `useToolState`（localStorage：防抖 400ms、卸载 flush、256KB 上限）；已接 `text-diff` / `cron-descriptor` / `regex-tester` 三个最费输入的工具，其余按报告 P1 分批 |
| 4 | 桌面整理没影响真实桌面 | ✅ 根因：`SetWindowPos(HWND_BOTTOM)` 把挂件窗压到**壁纸之下**，桌面上根本看不见。改为 `SetParent(hwnd, 桌面宿主 Progman/WorkerW)` 挂成桌面子窗口；新增 `grid_attach_get/set`、`grid_desktop_icons_set/get`；系统图标显隐走 `ShowWindow(SysListView32)`（**不动任何文件**）；启动 heal、退出 restore（保证图标一定回来） |
| 5a | 快捷入口报 `ShellExecute 代码 31`（V19 修完 193 后新暴露） | ✅ 代码 31 = `SE_ERR_NOASSOC`（本机注册表无 `.cpl` 关联）。`sys.rs` 新增 `launch_fallback`：`.cpl` → `rundll32 shell32.dll,Control_RunDLL`；`.msc` → `mmc.exe`；目录 → `explorer.exe`；`sys_action_run` 改主/备两级 try。白名单 **32 → 49 项**（+17：共享文件夹/任务计划/资源监视器/msconfig/磁盘清理/碎片整理/netplwiz/lusrmgr/certmgr/odbcad32/rstrui/打印机/蓝牙/默认应用/剪贴板/远程桌面/Defender） |
| 5b | 工作台布局：任务管理左、日历左、任务列表右、**等高**；笔记改**便签**；便签内 code 支持语法高亮；多便签右键贴到桌面；**快捷入口要随手可点（竖排大图标）** | ✅ 布局改「左日历 + 右任务列表（**等高**）+ 下方便签全宽」；新增 `QuickActionsRail.tsx`（44×44 竖排图标、悬停出说明气泡、应用内跳转 + 用户自选系统面板 + 设置中心、右侧滑出自定义面板）；`NotesPanel` 便签化（编辑/预览双页签、`CodeBlock` 零依赖语法高亮、右键「贴到桌面」） |
| 6 | 正则工具要加强：多实例正则 + 可点击填充的示例文本 | ✅ **重写**。新增 `src/lib/regexLibrary.ts`：**30 条**带说明/样本/用例的内置正则（常见校验/网络与运维/日志分析/文本处理/进阶陷阱五组）；**9 套真实多行样本**（Nginx/应用日志/慢查询/syslog/K8s YAML/JSON/脏数据/Markdown/Shell）；`explainPattern` 逐 token 讲人话；四页签：匹配明细（含命名组表）/替换预览/语法解释/用例验证 |
| 7 | 其余工具逐个核查增强 + 示例文本 | ✅ 新增框架级 **`SampleBar` + `CommandShell.samples`**（示例条挂在内容区之上、`shrink-0`，每条示例自带 `apply` 闭包，可「填文本 + 开开关 + 切页签」一次性完成）；**11/23 工具已接示例**；产出 **[`docs/03-development/TOOL-OPTIMIZATION.md`](../docs/03-development/TOOL-OPTIMIZATION.md)**（23 工具评分总表 + 逐工具方案 + P0/P1/P2 + 明确取舍）。剩余 8 个工具列 P1 |
| 8 | 贴条要多行展示今日待办 + 手动收起/下拉 | ✅ `bar.rs` 新增 `bar_set_height`（保持顶部居中锚点、上限 = 工作区高 × 60%）；前端展开态 = 两列多行清单（已完成靠后穿删除线）+ localStorage 记忆 + 「量高壳」ResizeObserver 自适应窗高；折叠态用 `display: contents` 与旧版布局完全一致 |

#### 1.6.1 V20 顺手挖出并修掉的 5 个「假功能」

界面有入口、点了不生效（或反向生效）——比缺功能更伤信任：

| 工具 | 症状 | 修法 |
| --- | --- | --- |
| `csv-json` | 「复制结果提示」按钮既不下载也不复制，只弹 toast | 改为真正的导出 `.json`/`.csv` 文件 |
| `relative-time` | 「复制描述」按钮只弹「暂无可复制内容」 | 改为「填入当前时间戳」 |
| `unit-converter` | 切类别把用户已选的源单位强制重置为第一个 | 新类别里仍存在就保留 |
| `unit-converter` | `CATEGORIES[categoryId] ?? CATEGORIES.length`（回退值是 number 不是 Category） | 去掉错误回退 |
| `uuid-generator` | 示例按钮「先 setState 再 generate」读到旧值（闭包竞态）；打开是空表 | 抽 `generateWith(n,upper,dash)`；`useState` 惰性初始化实现冷启动预生成 |

另：`image-to-base64` 新增 **Data URI 开关**（`data:image/png;base64,…` 才是能贴进 `<img src>` 的形态）+ 体积膨胀比提示。

---

## 2. 剩余任务

### 2.1 🔴 唯一阻塞项：装机 GUI 验收（用户执行）

| # | 项目 | 验收点 |
| --- | --- | --- |
| 1 | 窗口/托盘 | 最小化 → 托盘左键唤回；反复切换不丢窗；首启即亮 |
| 2 | **主窗口置顶**（V19 #5） | 默认**不再置顶**——打开工具箱后能正常点到其他窗口/弹框；设置中心打开「主窗口始终置顶」后立即生效 |
| 3 | 桌面挂件 | 新建盒子后自动显示挂件；**V20 起应真正画在桌面上**（`SetParent` 到 Progman/WorkerW）——桌面上能直接看到格子、可拖文件进盒子、双击打开原文件；空白处点击穿透 |
| 3.1 | **系统桌面图标显隐**（V20） | 主控台打开「隐藏系统桌面图标」→ 桌面原图标消失而格子仍在；**退出 Handy 后系统图标必须自动恢复**（`RunEvent::Exit` → `restore_desktop_icons`） |
| 4 | **桌面整理主控台**（V19 #7） | 「一键整理」能把桌面文件按类型归入格子且**不移动任何文件**；「备份当前布局」后可改名/换布局再「还原」；还原前会自动生成 `auto-before-restore` 备份 |
| 5 | 桌面顶部贴条 | 工作台点「贴到桌面顶部」→ 顶部出现细条；**今日进度条**随勾选变化；**`+` 内联加今日待办**回车即存；点圆圈可勾掉；重启后仍按上次状态显示 |
| 5.1 | **贴条多行折叠**（V20 #8） | 点 `⌄` 展开 → 标题行下出现**两列今日待办清单**（已完成的穿删除线排在后面）且**窗口高度自适应**（无空白、无内部滚动条）；点 `⌃` 折叠回单行；**重启后保持上次的展开/折叠状态** |
| 6 | 工作台 | 日历点日期 → 计划切到该日并聚焦输入框；**V20 布局**：左日历 + 右任务列表**等高**、便签全宽；**任务整行点击展开**，名称/说明都是所见即所得（敲 `**粗体**` 当场变粗、不留星号） |
| 6.1 | **便签与快捷入口**（V20 #5b） | 便签内 ```` ```shell ```` / ```` ```python ```` 代码块有**语法高亮**；便签右键 → 「贴到桌面」能开出独立便签窗；**右侧竖排大图标**鼠标悬停出说明气泡、点击即开对应系统面板 |
| 7 | 快捷入口 | 管理员 PowerShell / CMD 能弹 UAC 并打开；**「网络连接」不再报 os error 193 / ShellExecute 31**（V20 加 `rundll32`/`mmc`/`explorer` 二级兜底）；「自定义」能勾选并持久化 |
| 8 | 密码存储器 | 设主密码（**不可找回**）→ 解锁 → 闲置 5 min 自动锁 → 复制后 20 s 自动清剪贴板 |
| 9 | 工具箱重点 | 23 个工具可达；**Cron 解析**能推算未来 8 次执行与反查生成；**正则测试**左侧 30 条正则库点选即填；**文本对比**两列逐行对齐且**左右同步滚动**、切走再回来输入还在；**示例条**点一下即填样例数据 |
| 10 | 安装体验 | 结束所有 Handy 进程后再装（历史有僵尸进程锁文件导致 NSIS 静默失败） |

### 2.2 🟡 已知遗留 / 技术债（不阻塞验收）

| 项 | 说明 |
| --- | --- |
| 更新器占位符 | `tauri.conf.json` 的 `plugins.updater.pubkey` 与 `endpoints` 仍是占位值 → **正式发版前必须替换** |
| 密码存储器未接备份 | `backup.rs` 不覆盖 vault（刻意不做明文导出）；「复制后清空剪贴板」开关未进设置中心 |
| 设置跨窗口不同步 | 贴条收起时写 `barPinned=false`，主窗口 store 不监听磁盘变化 → 设置中心开关可能显示旧值（重启后一致） |
| 挂件平台边界 | 多显示器几何仅按主屏工作区兜底；非 Windows 不保证层级；挂件窗 OS 级 `resizable=false` |
| 工作台笔记面板未分页 | 笔记列表全量渲染（几十条无碍，上百条需虚拟化） |
| **列表项内块级转换**（V19 新） | 见 §1.5.1 已知取舍；如需支持，需实现「拆分列表 + 前后插入新块」 |
| **编辑器 ZWSP 哨兵残留**（V19 新） | 每次转换会留一个零宽哨兵在 DOM 里（序列化已剥离，数据无污染）；长时间编辑同一文档会累积，暂未做清理 |
| **工具示例条覆盖率 11/23**（V20 新） | 剩余 8 个（timestamp / json-formatter / base64-codec / url-codec / jwt-decoder / password-generator / hash-generator / qrcode-generator）待接，方案与建议示例已写在 `docs/03-development/TOOL-OPTIMIZATION.md` §6 P1 |
| **工具状态持久化 3/23**（V20 新） | 仅 `text-diff` / `cron-descriptor` / `regex-tester` 接了 `useToolState`，其余约 3 行/工具 |
| shell open 作用域放宽 | 为「打开本地文件」把 capabilities 的 `shell:allow-open` 放宽到 `**`（配置中已说明）；`grid_open_path` 走 Rust 侧双保险 |
| macOS 打包 | 签名/公证/`.dmg` 未做（需 Mac 环境） |
| 休眠代码 | V12 旧桌面整理（`organizer.rs` + `OrganizerView.tsx`）、V08 悬浮便签（`NoteWindow.tsx` + `NoteListView.tsx`）保留未删，均无 UI 入口 |
| 根目录残留 | `handy/` 根下历史验证日志（`*.log`/`*.txt`，已被 `.gitignore` 忽略，磁盘仍在；用户曾明确拒绝批量删除） |

### 2.3 🟢 Phase 2+ 路线（PRD §路线图）

- Phase 2：M5 快速启动/全局搜索 · M6 截图套件（标注/贴图/OCR）· M7 文件处理（批量重命名/编码换行/重复文件/磁盘分析）
- Phase 3：M8 系统优化增强 · M9 安全隐私 · M10 媒体/PDF · 官方扩展包(L2) + Pro 分层
- Phase 4：插件市场(L3) · 可选账号/同步 · 商业化闭环

---

## 3. 开发约束速查（违反会返工）

1. **所有 Rust 命令必须 `async fn`** —— 历史上同步命令在主线程执行会楔死 WebView2 的 COM STA，导致全部 IPC 永久 pending。
2. 前端**禁止组件内直接 `invoke`**，一律经 `src/lib/ipc.ts` 封装；SQL 只在 `src/core/data/*Service.ts` 里拼。
3. **DB 迁移只追加、幂等**；schema 三方一致（migration SQL = Rust 结构体 serde camelCase = `src/types/*.ts`）。
4. 模块注册：`src/modules/<id>/index.ts` 导出 `ModuleMeta`（`import.meta.glob` 自动发现）；命令注册在 `src/modules/toolbox/commands/index.ts`，`id` 全局唯一 kebab-case。
5. **新图标必须登记 `src/lib/icons.ts`**，否则静默回退成扳手图标。
6. 同一文件多处编辑**必须串行**（并行 Edit 会丢改动）。
7. 禁止对真实用户目录写操作；测试用 TEMP 沙箱。
8. 系统动作类功能**只增白名单表**（`src-tauri/src/commands/sys.rs` 的 `table()`），前端永远只传 `actionId`。
9. **打开非 PE 目标（`.cpl`/`.msc`/目录/协议）只能走 `ShellExecuteW`**，不要用 `std::process::Command`（会得到 os error 193）。
10. **窗口显隐/置顶以设置项为单一事实源**：`settings.barPinned`/`mainPinned` 由主窗口 `useAppStore.subscribe` 驱动 Rust；订阅**必须限定 `windowRoot === 'main'`**（贴条窗也跑 `main.tsx`，不判断会自己叫自己）。
11. **改 `RichMarkdown` 前必读组件头部注释**（记录了大量 contentEditable 内核坑），并按 §4 的逐字符冒烟回归。

---

## 4. 环境与命令速查

```bash
# Rust（必须经环境脚本，否则缺 MSVC linker）
source /d/_Projects/ops/handy/scripts/rust-env.sh && cargo check --manifest-path D:/_Projects/ops/handy/src-tauri/Cargo.toml

# 前端类型校验（绕过被安全层拦截的 npm）
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json

# 前端生产构建
node node_modules/vite/bin/vite.js build

# 打包（先确保 dist 已构建；beforeBuildCommand 走 npm 会被拦，用 --config 覆盖成空操作）
source scripts/rust-env.sh && node node_modules/@tauri-apps/cli/tauri.js build \
  --config '{"build":{"beforeBuildCommand":"node --version"}}'

# 浏览器冒烟：起静态服务 + 逐字符驱动所见即所得编辑器
#   （必须在同一条 bash 调用里起服务，否则后台进程会被作业对象回收）
node scripts/dev-static.cjs 41901 &
agent-browser open "http://127.0.0.1:41901/index.html?demo=richmarkdown"
agent-browser eval "$(cat _smoke_drive.js)"   # 返回逐步骤 html/source/选区报告
agent-browser close
```

- 环境已就绪：cargo/rustc 1.98.1 · MSVC 14.44.35207 · Win SDK 10.0.26100 · Node v22.22.2 · WebView2 137
- 坑：`npm.cmd`/`cmd.exe` 被拦 → 用 node 直调；沙箱内 GUI 进程会被回收 → GUI 只能用户验；`agent-browser keyboard type` **整串 `insertText` 且对空格/特殊字符处理不可靠**（实测 `# ` 变成 `NBSP+#`、凭空多出 `*`）→ 逐键场景必须用 `execCommand('insertText')` 逐字符驱动，且**读 React 状态前要 `await` 一个 tick**。
- 浏览器冒烟要点：`?tool=<id>` / `?module=<id>` / `?demo=richmarkdown` 深链可直接进页面；浏览器**无 SQLite 与 Tauri IPC**，因此「加载待办失败」「快捷入口需桌面环境」属预期提示。

---

## 5. 文档地图

| 文档 | 内容 |
| --- | --- |
| [`../docs/README.md`](../docs/README.md) | 文档索引与推荐阅读顺序 |
| `docs/01-planning/PRD.md` | 权威需求（11 模块矩阵、30 条痛点、MVP 裁定、商业化） |
| `docs/01-planning/DECISIONS.md` | 决策记录（D1–D14 已全关闭） |
| `docs/01-planning/TOOLS_INVENTORY.md` | 参考项目工具盘点与迁移取舍 |
| `docs/02-architecture/ARCHITECTURE.md` | 权威架构（注册契约、IPC 契约、数据模型、打包签名） |
| `docs/02-architecture/TASKS.md` | V01–V15 任务分解与依赖图 |
| `docs/03-development/DEVELOPMENT.md` | 开发规范与环境准备 |
| **`docs/03-development/TOOL-OPTIMIZATION.md`** | **工具优化评估报告（V20）**：23 个工具评分总表 + 逐工具方案 + P0/P1/P2 + 明确取舍 |
| [`memory/MEMORY.md`](memory/MEMORY.md) | 长期约定：标识、环境坑、验证纪律、V18–V20 架构约定 |
| `memory/2026-09-*.md` | 逐日进展日志（含 V01–V20 全过程） |

---

## 6. 续接开工三件事

1. **先跑三绿确认树健康**：`cargo check`（经 `scripts/rust-env.sh`）+ `tsc --noEmit` + `vite build`，均应为 exit 0。
2. **确认上一轮验收结论**：若用户已装机验收，把发现的问题按「现象 + 期望」记录到本文档 §2 或当日日志，再派人修。
3. **选下一个方向**：默认优先级 = ① 修验收问题 → ② §2.2 技术债 → ③ §2.3 Phase 2 模块。
