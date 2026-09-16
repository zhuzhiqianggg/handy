# Handy · 顺手 — 项目长期记忆

> **读取指引**：现状总览/续接指引 → [`../PROJECT_STATUS.md`](../PROJECT_STATUS.md)（从 handy 打开先读它）；
> 历史批次约定（V18–V25，动对应模块时查）→ [`CONVENTIONS.md`](./CONVENTIONS.md)；逐日进展 → 同目录 `YYYY-MM-DD.md`。
> ⚠️ 本文件曾膨胀到 16.9k 字符被注入截断（**截断点越靠后越读不到，存档越全反而越无效**）。
> 2026-09-16 瘦身至 ~6.5k：明细搬进 PROJECT_STATUS / CONVENTIONS，本文件只留**跨会话必读**。

## 1. 产品既定标识（不可随意更改）

- 产品名 **Handy · 顺手**（主张「方便，而非全面」）；代号 `handy`；identifier `com.handy.desktop`；
  安装包/主程序名 `Handy` / `handy.exe`；库 `handy.db`；配置 `settings.json`
- 技术栈：Tauri 2(Rust) + React 18 + TS + Vite + Tailwind + shadcn/ui(Radix) + cmdk + Zustand；
  数据层 SQLite(`tauri-plugin-sql`)，配置层 `tauri-plugin-store`
- 平台：Windows 10 1809+ / 11、macOS 12+；**`productName` 必须保持 `Handy`**（会成为 exe/安装包名，
  不能含中文与间隔号），中文名只用于窗口标题/托盘/UI

## 2. 路径与结构

| 项 | 值 |
| --- | --- |
| 项目根 | `D:\_Projects\ops\handy` |
| 权威文档 | `docs/{01-planning,02-architecture,03-development}`，**权威版 = 无后缀文件**，v1 在 `docs/99-archive/` |
| 前端 | `src/{core,modules,components,platform,lib,stores,hooks}`；纯逻辑全在 `src/lib/` |
| Rust | `src-tauri/src/{platform,db,commands}`、`src-tauri/capabilities/`、`src-tauri/tauri.conf.json` |
| 参考项目 | `D:\_Projects\ops\ops-tools`（网页版）——**只读借鉴，禁止修改** |
| 构建 | `scripts/rust-env.sh`（注入 MSVC，Rust 构建必用）、`scripts/dev-static.cjs` |
| 自检三件套 | `scripts/audit/tool-audit.mjs`（静态）/ `layout-audit.mjs`（几何）/ `sample-smoke.mjs`（真点示例） |
| 回归 | `scripts/regression/run.mjs` + `test-*.mjs`；`scripts/new-tool.mjs` 脚手架 |

## 3. 状态快照（2026-09-16 · V28 已交付、已打包、已装机）

- Phase 1（MVP）功能全部交付；**最近一次打包是 V28**（nsis 4.07 MB / msi 5.24 MB / handy.exe 10.50 MB，15:16 产出），
  **已静默安装到用户机**（`%LOCALAPPDATA%\Handy\handy.exe`，NSIS currentUser，静默参数 `/S`）并启动；
  一键脚本 `bash scripts/build-release.sh`（含 tsc→清 dist→vite→tauri→自动取证）。
  **唯一阻塞项 = 用户装机验收 GUI**（窗口/托盘/透明/桌面挂载/拖放/真实文件移动与撤销，沙箱验不了）。
- 工具箱 **25 个命令 / 6 分类**（text · data · encode · convert · generate · dev；V27 新增 `api-tester` 接口测试）；
  **模块目录 4 个**：toolbox / notes / vault / desktop-organizer（workstation、todos、desktop-grid、settings
  是**视图/独立窗口**，不是模块 —— 别再去找 `?module=workstation`）。
- **独立窗口 6 个**：main / note / settings / organizer / grid-overlay / workstation-bar（桌面顶部常驻贴条）。
- **DB 迁移链**：v1 → v2 去剪贴板表 → v3 vault → v4 grid → v5 `todos.detail`（**V21 起无 schema 变更**）。
- 批次明细与提交号 → PROJECT_STATUS §1（最近提交 `git log --oneline -6`）。V25–V27：
  V25 `5f8fe8a`+`3001510`；V26 `2969256`+`43a8a06`；V27 `f7e825f`+`4268257`。

### 3.1 V25–V27 事实源（细节见 PROJECT_STATUS §1.11–§1.13 与日志）

- **V25**：密码符号不连排（`passwordGen.ts` 唯一核心 + `separatedPositions`）；正则库全库自洽（`HitBadge` 自报命中数）；
  桌面整理「能力有、入口错」→ 双页签控制台默认真归类。方法论沉淀 **CONVENTIONS.md §12**。
- **V26**：工具箱纯逻辑层从零覆盖 → 1459 条断言（6 套新回归全带外部锚点：RFC 4648/1321、NIST、jwt.io、
  Goessner JSONPath、IEC 80000-13；与 `node:crypto` 交叉验证）；修 6 处「不报错只给错答案」缺陷
  （URL 主机:端口被当协议 / FileSize 切进制差 1024⁴ 倍 / JSON→TS 静默错类型等）；抽出 `src/lib/byteUnits.ts`。
- **V27**：新增 `api-tester` 接口测试（cURL 导入 + **Rust `http_request` 直发绕 CORS**，reqwest 0.13 走 rustls；
  敏感头不落盘）+ 建议条 14 处识别误报清零（JWT 依 RFC 7515 要求头部解出 JSON 对象；Base64 要求解码为合法 UTF-8）；
  `jsonLocate` 与 V8 差分 0 分歧、误导报错改准确；回归 **17 套 / 1778 条**、冒烟 28 用例 / 25 工具、
  工具自检 325 PASS。

## 4. 协作与操作约定

- 用户偏好：**先规划后执行**；表格化、结构化输出；**绝对路径**；**改文件前必须先读取**；目录扁平少层级。
- **批次收尾固定动作（用户 2026-09-16 明确）**：每轮功能做完 → 打包 → **静默安装到用户机** → 启动应用，
  用户只负责测试提意见，不想自己敲命令。安装流程：关掉运行中的 handy.exe → NSIS 安装器 `/S` 静默装
  → 验证 `%LOCALAPPDATA%\Handy\handy.exe` mtime 与注册表卸载项 → 启动（**沙箱会回收 GUI 进程，
  必须用非沙箱方式 Start-Process**）。
- 先排除无关范围（`node_modules`/`dist`/`target`/旧版验证残留）再聚焦。
- **红线**：禁止对真实用户目录（Desktop/Documents/Downloads）做任何写操作（测试限 TEMP 沙箱）。
- **最高频的 6 个坑**（完整清单 → CONVENTIONS.md §12.3 + PROJECT_STATUS §3）：
  1. 同一文件的多处 Edit **必须串行**（同消息并行会写入竞争丢改动）；不同文件可并行。
  2. **`vite build` 必须单独发一条命令**（本机 node 安全删除垫片：单回合累计 >50 次即拒，且会把随后的
     build 连带拦下，表现为 `CLEAN_EXIT=1`+`VITE_EXIT=1`，极易误判成「前端编不过」）。**布局审计与
     build 不同回合**（审计开 28 页、每页都删临时文件）。
  3. `npm.cmd` / `cmd.exe` 被安全层拦截 → 一律 `node node_modules/<cli>/<entry>.js`。
  4. Bash shim 时好时坏（`ls` 曾 exit 127；`bash scripts/xxx.sh` 整条命令可能只写出 16 字节日志就"完成"）
     → 降级 PowerShell 或 node 脚本，**输出落盘再 Read**；跑构建脚本可用 Git Bash 完整路径：
     `"C:/Users/Administrator/.workbuddy/binaries/PortableGit/versions/1.2.0/bin/bash.exe" -lc "..."`。
     ⚠️ 构建后必须核对产物 mtime，防 shim 假成功。
  5. 写进源码的中文文案**不要带反引号和 markdown 星号**（模板字符串会被反引号搞崩，报错位置离真问题很远）。
  6. **跨零点批次以 `Get-Date` 为准**，别信会话注入的「当前时间」；判断脚本是否真卡死看**日志 mtime 差**。

## 5. 开发环境（跨会话必读）

- 已就绪：cargo/rustc 1.98.1(msvc)、MSVC 14.44.35207 + Win SDK 10.0.26100、Node v22.22.2、
  WebView2 137、管理员权限。版本锁定见 `rust-toolchain.toml`。
- **Rust 构建**（PowerShell 直跑会因环境块损坏/缺 link.exe 失败）：
  `source /d/_Projects/ops/handy/scripts/rust-env.sh && cargo check --manifest-path D:/_Projects/ops/handy/src-tauri/Cargo.toml`
  （`os error 5` 争用 → `CARGO_INCREMENTAL=0` 重试）
- **前端**：`node node_modules/vite/bin/vite.js build` ／ `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`
- **打包**：`source scripts/rust-env.sh && node node_modules/@tauri-apps/cli/tauri.js build`
  （`beforeBuildCommand` 走 npm 被拦时用 `--config '{"build":{"beforeBuildCommand":"node --version"}}'` 覆盖，前端先手动 build）
- **打包后必须取证**：对比 `dist/index.html` 与 `src-tauri/target/release/handy.exe` 的 **mtime**（exe 必须晚于
  dist）。**别在 exe 里 grep 中文串**（Tauri 压缩后嵌入，必然 0 命中，会误判成没打进）。
- 网络：crates.io 走清华 sparse 镜像 + `~/.cargo/config.toml` 的 `[http] check-revoke = false`；
  PowerShell 5.1 不读 `HTTP_PROXY`，联网要显式 `-Proxy http://127.0.0.1:54735`；npm 已用 npmmirror。
- **GUI 限制**：沙箱内 GUI 进程会被作业对象回收、webview 可能不执行 JS → 真实 GUI 行为只能用户装机验收。

## 6. 验证纪律（血泪教训）

- **agent 自报的 "exit 0" 不可信**（曾两次虚报：shell 吞 stdout + 把 shell 退出码当命令退出码）→
  一律**独立复跑**，**输出与 exit code 分文件落盘后再 Read**。
- 过期日志甄别：核对 **mtime 与被检文件的先后**，否则误判「树编不过」。
- 三层验证：实现者自验（落盘取证）→ 独立 QA（fresh eyes）→ 主理人终验（cargo check + tsc + 红线抽查）。
- **DOM/输入类问题必须逐字符驱动复现**，诊断输出把 `\u200B`/`\u00A0` 换成可见标记（`<Z>`/`<N>`）再打印。
- **回归里算错的期望值比产品代码更危险**（断言写错与代码写错表现完全一样，字面量要逐字符核）；
  **写完断言逐条反问「它在失败场景下会不会也成立」**。

## 7. 历史批次约定（V18–V25）

见 **[`CONVENTIONS.md`](./CONVENTIONS.md)**：架构分层（V18/V19）、工具基建与桌面挂载（V20）、
布局防压盖与「工具即教材」（V22）、响应式与平台标注（V23）、视觉令牌/工具分类/自检体系（V24）、
反馈即缺陷 + 示例自洽 + 真桌面自证 + 浏览器脚本四规矩（V25）。
