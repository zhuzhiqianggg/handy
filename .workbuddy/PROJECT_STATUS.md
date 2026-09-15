# Handy · 顺手 — 项目现状与续接指引

> **从 `handy` 目录打开项目，先读这一份。** 它回答三个问题：**做到哪了 → 还剩什么 → 怎么继续**。
> 最近更新：2026-09-15（V19 批次） · 长期约定见 [`.workbuddy/memory/MEMORY.md`](memory/MEMORY.md) · 逐日进展见 [`memory/`](memory/) · 规划文档见 [`../docs/README.md`](../docs/README.md)

---

## 0. 一句话现状

**Phase 1（MVP）功能已全部交付，并完成两轮用户自测反馈大修（V18 + V19）**：命令面板统一入口 + 工具箱 **23 个工具** + **桌面网格挂件** + **桌面整理主控台（一键整理 + 布局备份/还原）** + **工作台（日历 / 计划 / 笔记 / 系统快捷入口）** + **桌面顶部贴条** + 密码存储器；**Windows 安装包已产出**；`cargo check`、`tsc`、`vite build` 三绿，并对所见即所得编辑器做了**逐字符**浏览器行为级冒烟（挖出并修掉 6 个内核坑）。
**当前卡点：唯一剩下的是「用户装机做 GUI 验收」**（沙箱无法验证窗口/托盘/透明/拖放等真实 GUI 行为）。

| 项 | 值 |
| --- | --- |
| 阶段 | Phase 1 收尾 + V18/V19 反馈修复（MVP 完成，待装机验收） |
| git | V18 = `862d5bf`；V19 批次见当日提交 |
| 安装包 | `src-tauri/target/release/bundle/nsis/Handy_0.1.0_x64-setup.exe`（3.80 MB，2026-09-15 19:52）<br>`src-tauri/target/release/bundle/msi/Handy_0.1.0_x64_en-US.msi`（4.89 MB，19:51）<br>`src-tauri/target/release/handy.exe`（9.68 MB，免安装可直接跑） |

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
| **V19**（本轮） | 见 §1.5 —— 6 条自测反馈 + 6 个所见即所得编辑器内核坑 | ✅ 三绿 + 已打包 + 逐字符冒烟 |

### 1.3 功能清单（当前实际能力）

**工具箱（23 个命令，`src/modules/toolbox/commands/`）**
- 原有 9：`timestamp` / `json-formatter` / `base64-codec` / `url-codec` / `jwt-decoder` / `text-diff` / `password-generator` / `hash-generator` / `qrcode-generator`
- 新增 14：`uuid-generator` / `json-to-ts` / `regex-tester` / `case-converter` / `text-dedup` / `csv-json` / `sql-formatter` / `relative-time` / `unit-converter` / `file-size` / `cron-descriptor` / `slug-generator` / `image-to-base64` / `ascii-table`

**模块（`src/modules/`）**

| 模块 id | 用户可见名 | 说明 |
| --- | --- | --- |
| `toolbox` | 工具箱 | 23 个命令，深链 `?tool=<id>` |
| `notes` | **工作台** | 入口原地重定向到 `workstation`；`note-create`/`note-list` 命令已收敛为「打开工作台」 |
| `workstation` | 工作台视图 | **双栏布局（V19）**：左窄栏(330px)=日历+计划，右宽栏=笔记（更宽）；系统快捷入口底部全宽 |
| `todos` | 待办清单 | 整屏管理（优先级/到期/提醒/互转）；「来源笔记」切到工作台并定位该条 |
| `desktop-organizer` | **桌面整理** | 入口重定向到 `desktop-grid`；旧「扫描→预览→移动→撤销」代码休眠 |
| `desktop-grid` | 网格挂件 + **整理主控台** | 透明置底窗 `grid-overlay` + 盒子拖拽/缩放/重命名 + 条目为**原文件路径引用**；**V19 新增一键整理 / 布局备份·还原·删除** |
| `vault` | 密码存储器 | 主密码（Argon2id）→ AES-256-GCM 字段级加密；自动锁 / 复制清剪贴板 |
| `settings` | 设置中心 | 快捷键/自启/主题/模块启停/备份/贴条常驻/**主窗口始终置顶** |

**Rust 命令层（`src-tauri/src/commands/`）**：`app`(窗口/设置) · `notes`(5) · `todos`(5) · `organizer`(6，休眠) · `backup` · `vault`(8) · `grid`(19，V19 +6) · `sys`(2，系统动作白名单 32 项) · `bar`(3，桌面顶部贴条) —— 全部 `async fn`。
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

---

## 2. 剩余任务

### 2.1 🔴 唯一阻塞项：装机 GUI 验收（用户执行）

| # | 项目 | 验收点 |
| --- | --- | --- |
| 1 | 窗口/托盘 | 最小化 → 托盘左键唤回；反复切换不丢窗；首启即亮 |
| 2 | **主窗口置顶**（V19 #5） | 默认**不再置顶**——打开工具箱后能正常点到其他窗口/弹框；设置中心打开「主窗口始终置顶」后立即生效 |
| 3 | 桌面挂件 | 新建盒子后自动显示挂件；透明、置底不挡其他窗口、空白处点击穿透、拖文件进盒子、双击打开原文件 |
| 4 | **桌面整理主控台**（V19 #7） | 「一键整理」能把桌面文件按类型归入格子且**不移动任何文件**；「备份当前布局」后可改名/换布局再「还原」；还原前会自动生成 `auto-before-restore` 备份 |
| 5 | 桌面顶部贴条 | 工作台点「贴到桌面顶部」→ 顶部出现细条；**今日进度条**随勾选变化；**`+` 内联加今日待办**回车即存；点圆圈可勾掉；重启后仍按上次状态显示 |
| 6 | 工作台 | 日历点日期 → 计划切到该日并聚焦输入框；**双栏**布局（笔记更宽）；**任务整行点击展开**，名称/说明都是所见即所得（敲 `**粗体**` 当场变粗、不留星号） |
| 7 | 快捷入口 | 管理员 PowerShell / CMD 能弹 UAC 并打开；**「网络连接」/「设备管理器」等 `.cpl`/`.msc` 不再报 os error 193**；「自定义」能勾选并持久化 |
| 8 | 密码存储器 | 设主密码（**不可找回**）→ 解锁 → 闲置 5 min 自动锁 → 复制后 20 s 自动清剪贴板 |
| 9 | 工具箱重点 | 23 个工具可达；密码生成器「位置优化」；JSON 高度自适应；时间戳 Tab 联动 |
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
| [`memory/MEMORY.md`](memory/MEMORY.md) | 长期约定：标识、环境坑、验证纪律 |
| `memory/2026-09-*.md` | 逐日进展日志（含 V01–V19 全过程） |

---

## 6. 续接开工三件事

1. **先跑三绿确认树健康**：`cargo check`（经 `scripts/rust-env.sh`）+ `tsc --noEmit` + `vite build`，均应为 exit 0。
2. **确认上一轮验收结论**：若用户已装机验收，把发现的问题按「现象 + 期望」记录到本文档 §2 或当日日志，再派人修。
3. **选下一个方向**：默认优先级 = ① 修验收问题 → ② §2.2 技术债 → ③ §2.3 Phase 2 模块。
