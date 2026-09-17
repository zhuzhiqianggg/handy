# Handy · 顺手 — 项目长期记忆

> **续接必读**：现状总览 → [`../PROJECT_STATUS.md`](../PROJECT_STATUS.md)；历史批次约定与踩坑清单
> → [`CONVENTIONS.md`](./CONVENTIONS.md)；逐日进展 → 同目录 `YYYY-MM-DD.md`。
> ⚠️ 本文件**必须保持精简**（2026-09-17 从 11k 瘦到 ~6k）：明细一律写进上面两个文件，
> 这里只留**跨会话必读的最小集**。再加内容前先删等量旧内容。

## 1. 产品既定标识（不可随意更改）

- 产品名 **Handy · 顺手**（主张「方便，而非全面」）；代号 `handy`；identifier `com.handy.desktop`；
  `productName` 必须保持 **`Handy`**（会成为 exe/安装包名，不能有中文），中文名只用于窗口标题/UI
- 技术栈：Tauri 2(Rust) + React 18 + TS + Vite + Tailwind + shadcn/ui(Radix) + cmdk + Zustand；
  SQLite(`tauri-plugin-sql`) + `tauri-plugin-store`；Windows 10 1809+ / macOS 12+
- 工具箱 **25 命令 / 6 分类**；**模块目录 4 个**：toolbox / notes / vault / desktop-organizer
  （workstation、todos、desktop-grid、settings 是**视图/独立窗口**，不是模块）
- **独立窗口 6 个**：main / note / settings / organizer / grid-overlay / workstation-bar

## 2. 路径与命令

| 项 | 值 |
| --- | --- |
| 项目根 | `D:\_Projects\ops\handy` |
| 文档 | `docs/{01-planning,02-architecture,03-development}`（权威版 = 无后缀） |
| 前端 / Rust | `src/{core,modules,components,platform,lib,stores,hooks}` / `src-tauri/src/{platform,db,commands}` |
| 参考项目 | `D:\_Projects\ops\ops-tools`——**只读借鉴，禁止修改** |
| 构建与自检 | `scripts/rust-env.sh`（注入 MSVC，**Rust 命令必先 source**）；`scripts/audit/` 四个探针；`scripts/regression/run.mjs`；脚手架 `scripts/new-tool.mjs`；一键打包 `scripts/build-release.sh` |

- **前端**：`node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`；`node node_modules/vite/bin/vite.js build`
- **Rust**：`source scripts/rust-env.sh && cargo check --manifest-path D:/_Projects/ops/handy/src-tauri/Cargo.toml`
  （`os error 5` → `CARGO_INCREMENTAL=0`）
- **打包**：`bash scripts/build-release.sh [--no-deploy] [--skip-tsc] [--skip-regression]`，
  必须用 **PortableGit 全路径 bash** 并显式构造 PATH（见 CONVENTIONS §坑4）
- 真实库 `%APPDATA%\com.handy.desktop\handy.db`；日志 `%LOCALAPPDATA%\Handy\handy.log`（2MB 轮转留 3 份）

## 3. 状态快照（2026-09-17 · V39）

- **最近交付 V39**（用户截图反馈）：① **接管自愈** —— 修「源图标还在」（归还图标是单向的，
  挂件窗被 Win+D 弄成瞬时不可见就把图标还回去且再也不收回；现在按 3 秒自检、带保险丝与限流日志）；
  ② **排不下不再保持原位**（V38 日志实证 `4 个没地方放（保持原位）` 就是「桌面很乱」的来源）
  → 首次适配 + 空洞复用 + 缩到最小重试 + `place_loose` 兜底并上报；③ **格子按内容量自动定尺寸**
  （`auto_box_size`，与前端条目网格度量严格对齐）；④ **挂件锚点表**（`widget_corner`：
  日历右上角 / 便签左下角 / 其余兜底左下角，新增挂件只加一行）。
- ★ **桌面格子 = 呈现层**（V37 立）：条目只是桌面上文件的**引用登记**，拖入/移出/一键归类
  **一律不动文件**（对标腾讯桌面整理）。V33–V36 的「真实收纳」（`fs::rename` 进
  `桌面/Handy整理/<格名>/`）**已被用户否决作废**，别再按它推理。整理后由格子**接管桌面呈现**
  （隐藏原生图标），否则同一批文件会显示两遍 —— 这是用户反复投诉的点。
- **DB 迁移链** v1→…→v9；由 `cargo test --lib` **37 条**断言守住（其中排布/尺寸/锚点 17 条）。
- **批次明细与提交号** → PROJECT_STATUS §1。最近：V38 `4237af6`；V37 `1df5cb2`；V36 `97a164a`。
- ⚠️ **agent 会话启动不了本 GUI**（新旧版本一律挂死启动早期，与代码无关，见 PROJECT_STATUS §1.19.2）
  ⇒ **打包 + `/S` 静默装到 `%LOCALAPPDATA%\Handy\handy.exe` 即止，不代启动**，请用户自己启动。
  **唯一阻塞项 = 用户装机 GUI 验收**。

### 3.1 桌面格子这轮的费点（一句话版，正文见 CONVENTIONS §13–§19）

| 版本 | 关键教训 |
| --- | --- |
| V33–V34 | 模型换「真实收纳」（后被否决）；`apply_attach`/`show()` 顺序写反会把窗口顶到 Z 序顶层 |
| V35 | Win+D 丢格子用 `IsIconic`+`SW_SHOWNOACTIVATE`（**不走 `SetParent`**）；**提速会连带改掉自愈节奏** |
| V36 | ★ 「闪一下就没」根因 = Z 序自检判据**永远不成立**（桌面正上方是公共地段）⇒ 每秒重排 |
| V37 | 撤销真实收纳；⚠️ **事故**：`copy_dir_recursive` 先建目标再遍历源 ⇒ 目标在源内时无限自复制，用户桌面炸出 5 目录 / 296 GB / 1001 层 |
| V38 | 「跳过 `.lnk`」只在原生图标仍显示时成立；接管呈现后必须让快捷方式进「快捷方式」格 |
| V39 | **单向兜底 = 没有兜底**；**静默降级 = 伪装成功**；排布游标只增不减 ⇒ 空隙永远用不上 |

## 4. 协作与操作约定

- 用户偏好：**先规划后执行**；表格化输出；**绝对路径**；**改文件前必须先读取**；目录扁平。
- **红线**：禁止对真实用户目录（Desktop/Documents/Downloads）做任何写操作（测试限 TEMP 沙箱）。
- **批次收尾**：功能完成 → 打包 → **`taskkill` 停旧版 → NSIS `/S` 静默装 → 取证 → 停手不启动**。
- **装机取证用哈希比对**（V33 立）：安装后的 exe 与 `target/release/handy.exe` 逐字节比，
  只应差 **3 字节**（Tauri 打包标记 `__TAURI_BUNDLE_TYPE_VAR_UNK` → `..._NSS`）。mtime 只能证明「变新了」。
- **最高频的坑**（完整清单 → CONVENTIONS.md）：
  1. 同一文件的多处 Edit **必须串行**；不同文件可并行。
  2. **`vite build` 必须单独发一条命令**（本机 node 安全删除垫片：单回合累计删 >50 次会连带拦下 build，
     表现为 `CLEAN_EXIT=1`+`VITE_EXIT=1`，极易误判成前端编不过）。布局审计与 build 分两条命令。
  3. `npm.cmd` / `cmd.exe` 被安全层拦截 → 一律 `node node_modules/<cli>/<entry>.js`。
  4. Bash shim 时好时坏（整条命令可能只写 16 字节日志就「完成」）→ 降级 PowerShell / node，
     **输出落盘再 Read**；跑构建用 PortableGit 全路径 bash + 显式 PATH；**构建后必核对产物 mtime**。
  5. 源码里的中文文案**不要带反引号和 markdown 星号**（模板字符串会被搞崩，报错位置离真问题很远）。
  6. Bash 里 `powershell -Command` 会被安全层拒 → 用内置 PowerShell；Git Bash 里 taskkill 要写
     `MSYS_NO_PATHCONV=1 taskkill /IM x /F`（`//IM` 反而不认）。**别用 `handy.exe --version` 探测版本 ——
     它会把应用真的启动起来**。

## 5. 验证纪律（血泪教训）

- **agent 自报的 "exit 0" 不可信**（曾两次虚报）→ 一律**独立复跑**，**输出与 exit code 分文件落盘后再 Read**。
- 过期日志甄别：核对 **mtime 与被检文件的先后**，否则误判「编不过」。
- **回归里算错的期望值比产品代码更危险**；写完断言逐条反问「它在失败场景下会不会也成立」。
- **GUI 类问题先用已知 good 的旧产物做对照**，一步分开「代码回归」与「环境坏了」。
- 浮层窗「不见了」的追问顺序：**先读应用日志数行数** → `window-probe.py zlist` 看层级 → `render` 看画没画。
- 排布 / 布局类问题**先看日志里的量化数字**（如「挪动 4 个 / 4 个没地方放」），比读代码快得多。
