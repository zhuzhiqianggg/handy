# Handy · 顺手 — 项目长期记忆

> **续接必读**：现状 + 批次明细 → [`../PROJECT_STATUS.md`](../PROJECT_STATUS.md)；
> 历史约定与踩坑 → [`CONVENTIONS.md`](./CONVENTIONS.md)；逐日进展 → 同目录 `YYYY-MM-DD.md`。
> ⚠️ 本文件只留**跨会话必读的最小集**（加内容前先删等量旧内容；曾因超限被注入截断而失效）。

## 1. 既定标识

- 产品名 **Handy · 顺手**；identifier `com.handy.desktop`；**`productName` 必须是 `Handy`**
  （会进 exe/安装包名，不能含中文与间隔号），中文名只用于窗口标题/UI。
- 栈：Tauri 2 + React 18 + TS + Vite + Tailwind + shadcn/ui + cmdk + Zustand；SQLite + `tauri-plugin-store`；
  Win10 1809+ / macOS 12+。
- 工具箱 **25 命令 / 6 分类**；**模块 4 个**：toolbox / notes / vault / desktop-organizer
  （workstation、todos、desktop-grid、settings 是**视图/独立窗口**，不是模块）。
- **独立窗口 6 个**：main / note / settings / organizer / grid-overlay / workstation-bar。

## 2. 路径与关键位置

| 项 | 值 |
| --- | --- |
| 项目根 | `D:\_Projects\ops\handy`（参考项目 `D:\_Projects\ops\ops-tools`——**只读，禁止修改**） |
| 权威文档 | `docs/{01-planning,02-architecture,03-development}`（**无后缀 = 权威版**） |
| 前端 / Rust | `src/{core,modules,components,platform,lib,stores,hooks}` / `src-tauri/src/{platform,db,commands}` |
| 真实数据 | 库 `%APPDATA%\com.handy.desktop\handy.db`；日志 `%LOCALAPPDATA%\Handy\handy.log` |
| 装好的程序 | `%LOCALAPPDATA%\Handy\handy.exe`（NSIS currentUser，`/S` 静默） |

**命令**（细节与坑见 CONVENTIONS）：`source scripts/rust-env.sh` 是 Rust 命令的前置；
前端 `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`；
打包 `bash scripts/build-release.sh --no-deploy`（**PortableGit 全路径 bash + 显式 PATH**）；
自检 `scripts/audit/`（tool-audit / layout-audit / sample-smoke / window-probe.py / desktop-icon-probe.py）；
回归 `scripts/regression/run.mjs`（17 套）。

## 3. 状态快照（2026-09-17 22:04 · **V40 已打包并静默装机，待用户 GUI 验收**）

- **V40**（用户截图四点）：① **「点整理不接管」的真根因** = `grid_auto_arrange` 里
  `if report.items_added > 0 { takeover_icons(true) }`，而桌面早已全部登记过（每次都「登记 0 项」）
  ⇒ 点整理压根没隐藏图标（V39 的 `reassert_takeover` 救不了：偏好从没被打开过）→ 改为
  **整理一律按接管偏好执行** + 安全闸「仅当挂件层确实在显示」（否则藏了图标却没格子顶上，桌面空白）；
  ② 轮询「一不可见立刻归还」→ **30 秒宽限**（真收起/退出仍立即归还），回来时立刻自检不等周期；
  ③ **统一列宽 + 左起首次适配流布局 + 高度随内容**（真实库曾是 160/228/300 三种宽度 + 靠右流 ⇒ 左边缘参差），
  `system` 格从挂件改判为内容格；④ **扫两个桌面根**（用户桌面 + `%PUBLIC%\Desktop`，后者 15 个快捷方式
  从来没进过格子）+ 不再排除历史容器 ⇒ `skipped` 恒 0。单测 **37 → 43 全绿**（含 2 条灌真实数据形状的端到端预演）。
- ★ **桌面格子 = 呈现层**（V37 立，别再按旧结论推理）：条目只是桌面文件的**引用登记**，拖入/移出/
  一键归类**一个字节都不移动文件**（对标腾讯桌面整理）。V33–V36 的「真实收纳」（`fs::rename` 进
  `桌面/Handy整理/<格名>/`）**已被用户否决作废**。整理后必须由格子**接管桌面呈现**（隐藏 `SysListView32`），
  否则同一批文件显示两遍 —— 用户反复投诉的点。
- **DB 迁移链** v1→v9，真实库可能停在 v8，首次启动顺次自动应用；由 `cargo test --lib` 守住。
- 最近提交：V39 `d9f033e`；V38 `4237af6`；V37 `1df5cb2`（V40 见 PROJECT_STATUS §1.26）。
- ⚠️ **agent 会话启动不了本 GUI**（新旧版本一律挂死启动早期，与代码无关，见 PROJECT_STATUS §1.19.2）
  ⇒ **打包 + `/S` 静默装即止，不代启动**，请用户自己启动。**唯一阻塞项 = 用户装机 GUI 验收**。

### 3.1 关键教训（一句话版；正文 CONVENTIONS §13–§20）

| 版本 | 教训 |
| --- | --- |
| V33–V35 | 「真实收纳」模型后被否决；`apply_attach`/`show()` 顺序写反会把窗口顶到 Z 序顶层；**提速会连带改掉自愈节奏** |
| V36 | ★「闪一下就没」根因 = Z 序自检判据**永远不成立**（桌面正上方是公共地段）⇒ 每秒重排 |
| V37 | ⚠️ **事故**：`copy_dir_recursive` 先建目标再遍历源 ⇒ 目标在源内时无限自复制，桌面炸出 5 目录 / 296 GB / 1001 层 |
| V38–V39 | 「跳过 `.lnk`」只在原生图标仍显示时成立；**单向兜底 = 没有兜底**；**静默降级 = 伪装成功** |
| V40 | **判据挂在「本次做了什么」上 ⇒ 那次没做事，功能就永远不生效**（接管挂在 `items_added>0`）；**测试里元组列序写错编译器不吭声** → 改具名字段结构体 |

## 4. 协作与操作约定

- 用户偏好：**先规划后执行**；表格化输出；**绝对路径**；**改文件前必须先读取**；目录扁平。
- **红线**：禁止对真实用户目录（Desktop/Documents/Downloads）写操作（测试限 TEMP 沙箱）。
- **批次收尾**：功能完成 → 打包 → **停旧版 → NSIS `/S` 静默装 → 取证 → 停手不启动**。
- **装机取证用哈希比对**（V33 立）：安装后的 exe 与 `target/release/handy.exe` 逐字节比，**只应差 3 字节**
  （Tauri 打包标记 `..._VAR_UNK` → `..._NSS`）。mtime 只能证明「变新了」。
- **最高频的坑**（完整清单 → CONVENTIONS）：
  1. 同一文件的多处 Edit **必须串行**；不同文件可并行。
  2. **`vite build` 与布局审计分两条命令**（本机 node 安全删除垫片：单回合累计删 >50 次会连带拦下 build，
     表现为 `CLEAN_EXIT=1`+`VITE_EXIT=1`，极易误判成前端编不过）。
  3. `npm.cmd` / `cmd.exe` 被安全层拦截 → 一律 `node node_modules/<cli>/<entry>.js`。
  4. Bash shim 时好时坏（可能只写 16 字节日志就「完成」）→ 输出**落盘再 Read**；
     构建用 PortableGit 全路径 bash；**构建后必核对产物 mtime**。
  5. 源码里的中文文案**不要带反引号和 markdown 星号**（模板字符串会被搞崩，报错位置离真问题很远）。
  6. Git Bash 里 MSYS **不会**把 `//IM` `//S` 折成 `/IM` `/S`，且**沙箱会在命令结束时回收后台进程**
     ⇒ 装机只用 PowerShell `Start-Process -ArgumentList "/S" -PassThru -Wait`（V40 实测一次成功）。
     另：**别用 `handy.exe --version` 探测版本 —— 它会把应用真的启动起来**。

## 5. 验证纪律

- **agent 自报的 "exit 0" 不可信**（曾两次虚报）→ 一律**独立复跑**，输出与 exit code 分文件落盘后再 Read。
- 过期日志甄别：核对 **mtime 与被检文件的先后**，否则误判「编不过」。
- **回归里算错的期望值比产品代码更危险**；写完断言逐条反问「失败场景下它会不会也成立」。
- **GUI 类问题先用已知 good 的旧产物做对照**，一步分开「代码回归」与「环境坏了」。
- 浮层窗「不见了」：**先读应用日志数行数** → `window-probe.py zlist` 看层级 → `render` 看画没画。
- 排布 / 布局类问题**先看日志里的量化数字**（如「挪动 4 个 / 4 个没地方放」），比读代码快得多。
