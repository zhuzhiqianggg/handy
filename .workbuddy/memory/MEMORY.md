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
| 构建脚本 | `scripts/rust-env.sh`（注入 MSVC 环境，Rust 构建必用） |

## 3. 状态快照（2026-09-15）

- Phase 1（MVP）功能全部交付；**Windows 安装包已产出**；待用户装机验收 GUI 行为。
- git：HEAD `ff6ebb2`（前一提交 `e04bf38` = V17 批次，39 文件 +6823/−28）。
- 工具箱 **23 个命令**；模块：toolbox / notes(已改名「工作台」) / todos / desktop-organizer(已改名「桌面挂件」) / vault(密码存储器) / workstation / settings。

## 4. 协作与操作约定

- 用户偏好：**先规划后执行**；表格化、结构化输出；**绝对路径**；**修改文件前必须先读取**；目录扁平少层级。
- 处理任务先排除无关范围（`node_modules`/`dist`/`target`/旧版验证残留）再聚焦。
- **工具坑（必记）**：
  - 同一条消息内并行对**同一个文件**发多个 Edit 会因写入竞争丢失改动 → **同一文件的多处编辑必须串行**（一次一条消息）；不同文件可并行。
  - **Bash shim 损坏**：`dirname`/`ls`/`head`/`find`/`grep` 常缺失（`ls` 直接 exit 127）→ 文件枚举与信息获取优先用 **PowerShell**（`Get-Item`/`Get-ChildItem`），**输出必须落盘再 Read**（stdout 常不回显）。
  - 文件检索用 **Glob/Grep 工具**（Glob 对反斜杠路径不可靠，Grep 用正斜杠路径可靠）；**Read 用绝对路径最稳**。
  - `npm.cmd` / `cmd.exe` 被安全层拦截 → 调 CLI 一律 `node node_modules/<cli>/<entry>.js`。
  - PowerShell 捕获 git 中文输出会乱码 → 先设 `[Console]::OutputEncoding=[Text.Encoding]::UTF8`，或落盘再 Read（`git commit -m` 传中文本身是安全的）。
- **团队红线**：禁止对真实用户目录（Desktop/Documents/Downloads）做任何写操作（测试限 TEMP 沙箱）；V14 之后打包由主理人在用户明确要求时执行。

## 5. 开发环境（跨会话必读）

- 已就绪：`cargo 1.98.1` / `rustc 1.98.1 (stable-x86_64-pc-windows-msvc)`、**MSVC 14.44.35207 + Win SDK 10.0.26100**、Node v22.22.2、WebView2 137、管理员权限。版本锁定见 `rust-toolchain.toml`。
- **Rust 构建正确姿势（已验证）**：
  ```bash
  source /d/_Projects/ops/handy/scripts/rust-env.sh && cargo check --manifest-path D:/_Projects/ops/handy/src-tauri/Cargo.toml
  ```
  （PowerShell 直跑 cargo 会因环境块损坏/缺 link.exe 失败；`os error 5` 争用 → `CARGO_INCREMENTAL=0` 重试。）
- 前端构建/校验：`node node_modules/vite/bin/vite.js build`、`node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`（绕过被拦的 npm）。
- 打包：`source scripts/rust-env.sh && node node_modules/@tauri-apps/cli/tauri.js build`（`beforeBuildCommand` 若被 npm 拦截，可用 `--config '{"build":{"beforeBuildCommand":"node -e \"process.exit(0)\""}}'` 覆盖，前端先手动 build）。
- 网络：crates.io 走清华 sparse 镜像 + `~/.cargo/config.toml` 的 `[http] check-revoke = false`（否则报 `CRYPT_E_REVOCATION_OFFLINE`）；PowerShell 5.1 不读 `HTTP_PROXY`，需要联网显式 `-Proxy http://127.0.0.1:54735`；npm registry 已是 `registry.npmmirror.com`。
- **GUI 限制**：工具沙箱内启动的 GUI 进程在调用结束会被作业对象回收，且 webview 可能不执行前端 JS → **窗口/托盘/透明/拖放等真实 GUI 行为只能由用户装机验收**。

## 6. 验证纪律（血泪教训）

- **agent 自报的 "tsc/build exit 0" 不可信**：曾两次虚报（根因 = shell 吞掉 stdout + 把 shell 退出码当成命令退出码）。→ 一律由主理人**独立复跑**，且**输出与 exit code 分文件落盘后再 Read**。
- 过期日志甄别：agent 留下的 tsc/build 日志必须核对 **mtime 与被检文件的先后**，否则会误判「树编不过」。
- 三层验证：实现者自验（落盘取证）→ 独立 QA（fresh eyes，读代码+实跑）→ 主理人终验（cargo check + tsc + 红线抽查如 async/明文日志/迁移链）。
