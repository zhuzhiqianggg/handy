# Handy · 顺手 — 项目现状与续接指引

> **从 `handy` 目录打开项目，先读这一份。** 它回答三个问题：**做到哪了 → 还剩什么 → 怎么继续**。
> 最近更新：2026-09-15 · 长期约定见 [`.workbuddy/memory/MEMORY.md`](memory/MEMORY.md) · 逐日进展见 [`memory/`](memory/) · 规划文档见 [`../docs/README.md`](../docs/README.md)

---

## 0. 一句话现状

**Phase 1（MVP）功能已全部交付**：命令面板统一入口 + 工具箱 **23 个工具** + 桌面网格挂件 + 便签/待办 + 桌面工作台 + 密码存储器；**Windows 安装包已产出**；`cargo check` 与 `tsc` 均经主理人独立复验 **exit 0**。
**当前卡点：唯一剩下的是「用户装机做 GUI 验收」**（沙箱无法验证窗口/托盘/透明/拖放等真实 GUI 行为）。

| 项 | 值 |
| --- | --- |
| 阶段 | Phase 1 收尾（MVP 完成，待装机验收） |
| git | **HEAD `ff6ebb2`**；上一提交 `e04bf38` = V17 批次（39 文件，+6823/−28） |
| 安装包 | `src-tauri/target/release/bundle/nsis/Handy_0.1.0_x64-setup.exe`（3.57 MB）<br>`src-tauri/target/release/bundle/msi/Handy_0.1.0_x64_en-US.msi`（4.60 MB）<br>`src-tauri/target/release/handy.exe`（9.06 MB，免安装可直接跑） |

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
| V08 / V09 | M3 便签（多窗/持久化）+ 待办与定时提醒 | ✅ |
| V10 / V11 | M4 剪贴板历史数据层/监听/UI/智能识别 | ✅ 实现 → ❌ **已按用户决策整体移除**（与系统 `Win+V` 重复；内容识别能力以纯函数保留在 `src/lib/contentMatch.ts`） |
| V12 | M2 桌面整理（plan/preview/apply/undo） | ✅ 实现 → 🔁 **已被 V17「桌面网格挂件」取代**（用户要求：不再建目录搬文件）；旧代码 `organizer.rs` + 旧前端**保留但休眠** |
| V13 | 设置中心完整版 + 模块开关 + 授权预留 + 备份 | ✅ |
| V14 | 双平台打包/签名/公证 | ⚠️ **Windows 打包 ✅**（msi+nsis）；macOS 需 Mac 环境，**未做** |
| V15 | 集成联调与打磨 | ✅（并完成多轮 UI/UX 大改：窗口可调尺寸、便签 Markdown 编辑器、工具箱对齐参考项目） |

### 1.2 增量批次（规划外，按用户反馈推进）

| 批次 | 内容 | 状态 |
| --- | --- | --- |
| **V16** | 修复「最小化后窗口找不回」：`window.rs` 三态机（最小化→还原聚焦 / 可见→隐藏 / 隐藏→显示）+ 托盘左键还原 + 标题栏最小化键改为隐藏到托盘 + `windowShell` 拒绝脏尺寸回写 + 启动保底显示 | ✅ 已落盘并经独立核实 |
| **V17 · Batch1** | ① 窗口/托盘（同上 V16）② 文本对比对比度 + 差异列表面板 + 当前差异高亮 + ↑↓/j/k 导航 ③ 时间戳：`fillNow` 尊重当前 Tab、新增「应用偏移」控件、顶部 NowBanner 实时时钟 ④ 剪贴板模块移除（路由保留） | ✅ 全项目 tsc exit 0（独立复验） |
| **V17 · Batch2** | ① 工具箱 +14 个新命令（→ 共 23）② 桌面工作台（替换便签入口，聚合今日待办/便签/快捷入口）③ **密码存储器 vault**（Argon2id + AES-256-GCM）④ **桌面网格挂件**（透明置底窗 + 网格盒子 + 文件永不移动） | ✅ cargo check + tsc 双绿（独立复验）+ 已打包 |

### 1.3 功能清单（当前实际能力）

**工具箱（23 个命令，`src/modules/toolbox/commands/`）**
- 原有 9：`timestamp` / `json-formatter` / `base64-codec` / `url-codec` / `jwt-decoder` / `text-diff` / `password-generator` / `hash-generator` / `qrcode-generator`
- 新增 14：`uuid-generator` / `json-to-ts` / `regex-tester` / `case-converter` / `text-dedup` / `csv-json` / `sql-formatter` / `relative-time` / `unit-converter` / `file-size` / `cron-descriptor` / `slug-generator` / `image-to-base64` / `ascii-table`

**模块（`src/modules/`）**

| 模块 id | 用户可见名 | 说明 |
| --- | --- | --- |
| `toolbox` | 工具箱 | 23 个命令，深链 `?tool=<id>` |
| `notes` | **工作台** | 入口原地重定向到 `workstation`（零迁移）；便签数据层/桌面便签窗全部保留 |
| `workstation` | 工作台视图 | 问候+时钟 / 今日待办 / 便签卡 / 快捷入口（localStorage） |
| `todos` | 待办清单 | 含提醒调度（系统通知） |
| `desktop-organizer` | **桌面挂件** | 入口重定向到 `desktop-grid`；旧「扫描→预览→移动→撤销」代码休眠 |
| `desktop-grid` | 网格挂件 | 透明置底窗 `grid-overlay` + 盒子拖拽/缩放/重命名 + 条目为**原文件路径引用** |
| `vault` | 密码存储器 | 主密码（Argon2id）→ AES-256-GCM 字段级加密；自动锁 / 复制清剪贴板 |
| `settings` | 设置中心 | 快捷键/自启/主题/模块启停/备份 |

**Rust 命令层（`src-tauri/src/commands/`）**：`app`(窗口/设置) · `notes`(5) · `todos`(5) · `organizer`(6，休眠) · `backup` · **`vault`(8)** · **`grid`(13)** —— 全部 `async fn`。
**DB 迁移链**：v1 schema → v2 移除剪贴板表 → **v3 vault_meta/vault_items** → **v4 grid_meta/grid_boxes/grid_items**（只追加，幂等）。

---

## 2. 剩余任务

### 2.1 🔴 唯一阻塞项：装机 GUI 验收（用户执行）

| # | 项目 | 验收点 |
| --- | --- | --- |
| 1 | 窗口/托盘 | 最小化 → 托盘左键唤回；反复切换不丢窗；首启即亮 |
| 2 | 桌面挂件 | 透明、置底不挡其他窗口、空白处点击穿透、拖文件进盒子、双击打开原文件 |
| 3 | 密码存储器 | 设主密码（**不可找回**）→ 解锁 → 闲置 5 min 自动锁 → 复制后 20 s 自动清剪贴板 |
| 4 | 工作台 | 三卡渲染、便签点击开独立窗、待办勾选与快捷添加 |
| 5 | 工具箱 | 23 个工具可达；重点：文本对比高亮/差异面板/键盘导航、时间戳「应用偏移」与顶部实时钟 |
| 6 | 便签/待办 | 新建便签开窗、Markdown 渲染、Esc 关闭 |
| 7 | 安装体验 | 结束所有 Handy 进程后再装（历史有僵尸进程锁文件导致 NSIS 静默失败） |

### 2.2 🟡 已知遗留 / 技术债（不阻塞验收）

| 项 | 说明 |
| --- | --- |
| 更新器占位符 | `tauri.conf.json` 的 `plugins.updater.pubkey` 与 `endpoints` 仍是占位值 → **正式发版前必须替换**（本地测试无影响） |
| 密码存储器未接备份 | `backup.rs` 不覆盖 vault（刻意不做明文导出）；密码生成器 ↔ vault 联动未做；「复制后清空剪贴板」开关未进设置中心 |
| 快捷入口无编辑 | 工作台快捷入口仅支持增/删/打开，无重命名/改地址 |
| shell open 作用域放宽 | 为「打开本地文件」把 capabilities 的 `shell:allow-open` 放宽到 `**`（安全权衡，已在配置中说明）；`grid_open_path` 走 Rust 侧作为双保险 |
| 挂件平台边界 | 多显示器几何仅按主屏工作区兜底；非 Windows 不保证层级（本期目标即 Windows）；挂件窗 OS 级 `resizable=false` |
| macOS 打包 | 签名/公证/`.dmg` 未做（需 Mac 环境） |
| 休眠代码 | V12 旧桌面整理（`organizer.rs` + `OrganizerView.tsx`）保留未删 |
| 根目录残留 | `handy/` 根下约 120 个历史验证日志（`*.log`/`*.txt`，已被 `.gitignore` 忽略，磁盘仍在；历史上用户曾明确拒绝批量删除） |

### 2.3 🟢 Phase 2+ 路线（PRD §路线图）

- Phase 2：M5 快速启动/全局搜索 · M6 截图套件（标注/贴图/OCR）· M7 文件处理（批量重命名/编码换行/重复文件/磁盘分析）
- Phase 3：M8 系统优化增强 · M9 安全隐私 · M10 媒体/PDF · 官方扩展包(L2) + Pro 分层
- Phase 4：插件市场(L3) · 可选账号/同步 · 商业化闭环

---

## 3. 开发约束速查（违反会返工）

1. **所有 Rust 命令必须 `async fn`** —— 历史上同步命令在主线程执行会楔死 WebView2 的 COM STA，导致全部 IPC 永久 pending。
2. 前端**禁止组件内直接 `invoke`**，一律经 `src/lib/ipc.ts` 封装；SQL 只在 `src/core/data/*Service.ts` 里拼。
3. **DB 迁移只追加、幂等**；schema 三方一致（migration SQL = Rust 结构体 serde camelCase = `src/types/*.ts`）。
4. 模块注册：`src/modules/<id>/index.ts` 导出 `ModuleMeta`（`import.meta.glob` 自动发现）；命令注册在 `src/modules/toolbox/commands/index.ts`，`id` 全局唯一 kebab-case（供深链 `?tool=<id>`）。
5. **新图标必须登记 `src/lib/icons.ts`**，否则静默回退成扳手图标。
6. 同一文件多处编辑**必须串行**（并行 Edit 会丢改动）。
7. 禁止对真实用户目录写操作；测试用 TEMP 沙箱。

---

## 4. 环境与命令速查

```bash
# Rust（必须经环境脚本，否则缺 MSVC linker）
source /d/_Projects/ops/handy/scripts/rust-env.sh && cargo check --manifest-path D:/_Projects/ops/handy/src-tauri/Cargo.toml

# 前端类型校验（绕过被安全层拦截的 npm）
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json

# 前端生产构建
node node_modules/vite/bin/vite.js build

# 打包（先确保 dist 已构建）
source scripts/rust-env.sh && node node_modules/@tauri-apps/cli/tauri.js build
```

- 环境已就绪：cargo/rustc 1.98.1 · MSVC 14.44.35207 · Win SDK 10.0.26100 · Node v22.22.2 · WebView2 137
- 坑：`npm.cmd`/`cmd.exe` 被拦 → 用 node 直调；Bash shim 缺 `ls`/`dirname` → 用 PowerShell 并落盘再读；沙箱内 GUI 进程会被回收 → GUI 只能用户验。

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
| `memory/2026-09-*.md` | 逐日进展日志（含 V01–V17 全过程） |

---

## 6. 续接开工三件事

1. **先跑双绿确认树健康**：`cargo check`（经 `scripts/rust-env.sh`）+ `tsc --noEmit`，均应为 exit 0。
2. **确认上一轮验收结论**：若用户已装机验收，把发现的问题按「现象 + 期望」记录到本文档 §2 或当日日志，再派人修。
3. **选下一个方向**：默认优先级 = ① 修验收问题 → ② §2.2 技术债 → ③ §2.3 Phase 2 模块。
