# Handy · 顺手 — 项目长期记忆

> 续接必读：批次明细 → PROJECT_STATUS.md；约定/踩坑 → CONVENTIONS.md；逐日 → YYYY-MM-DD.md。
> **超限会被注入截断而失效** ⇒ 只留跨会话最小集，**上限 ~12.5KB**；加内容前先删等量旧内容。

## 1. 标识与路径
- Handy · 顺手；identifier `com.handy.desktop`；`productName` 必须 `Handy`（禁中文/间隔号）。
- 栈 Tauri 2 + React 18 + TS + Vite + Tailwind + shadcn/ui + cmdk + Zustand；SQLite + tauri-plugin-store。窗口 6：main/note/settings/organizer/grid-overlay/workstation-bar。
- 根 `D:\_Projects\ops\handy`；参考 `D:\_Projects\ops\ops-tools`（只读）；权威文档 `docs/{01,02,03}-*`。
- ★ Git：远端 `git@github.com:zhuzhiqianggg/handy.git`（**必须 SSH**，HTTPS 超时）。推送前看 `size-pack`（正常 ~2MB，暴涨=`target/` 漏进）。
- 真实库 `%APPDATA%\com.handy.desktop\handy.db`（接管态看 `grid_meta` 三键）；日志/程序 `%LOCALAPPDATA%\Handy\`。
- 命令：Rust `source scripts/rust-env.sh && cd src-tauri`（⚠️ 无 src-tauri/scripts/）；tsc `node node_modules/typescript/bin/tsc --noEmit`；打包 `build-release.sh --no-deploy`；回归 `scripts/regression/run.mjs`；**改守卫必跑** `scripts/audit/guard-mutation-check.py`。迁移链 v1→v11 由 `cargo test --lib` 守。

## 2. 硬不变量（改前必读）
- **格子 = 呈现层**（V37）：归类/拖入**不移动文件**；V48 起 Rust 无 `fs::rename`。**「接管」已于 V102 整体删除** —— 图标永远归 Explorer，启动 `ensure_native_layout` 装配（关自动排列 + 快照 + 间距），摆位靠 `LVM_SETITEMPOSITION` 遥控；**旧的隐藏 `SysListView32` / Z 序锚定 / `desktop_icons_apply(true)` 都不复存在**。
- `grid_overlay_hide` 只收内容（**不**藏挂件窗，否则无入口=死路）；启动 `restore_overlay_if_visible` 不弹主窗。
- **「常驻」与「盒子」互斥**（V60）：退出整理后还在 ⇒ 必须浮窗，引擎当禁区（右侧整列 400）。
- **外部唤起 = 入队+唤醒**（V60）：冷启动 emit 必丢 ⇒ `PENDING_ACTION` 入队（挂载 + 收到唤醒各取一次，**不采信载荷**）。HKCU 能力必须有版本标记：`install()` **整键重建**。**一个跨线程状态只许一个记账人**（V61）。
- ★★ **显隐唯一真源 `overlay_visible`：谁写谁广播**（V79）：三处写完必须 `emit_visibility`；托盘**不许**再自己发。前端 `contentHidden` 初值 **`true`**（fail-closed），**先注册监听、再查状态**。
- **「撤掉强制可交互」≠「立刻穿透」**：`let want = interactive || cursor_hit(&win)`（**或**）。
- **内部拖拽 = 指针拖拽**（V59）：wry 无 `CF_HDROP` 不写 `*pdwEffect` ⇒ 自算落点（5px）；**不许关 `drag_drop_enabled`**。
- ★★ **「底板画到哪」与「图标摆到哪」必须同段 Rust 逻辑保证**（V102.2，10-11「整理失效」）：摆位不能只靠前端 relayoutSoon 的 `.then(ipc.desktopIconLayoutApply())`（会静默吞错，且启动/一键整理根本不走它）。Rust 端唯一入口 `grid_icons::apply_after_relayout`，挂在 grid_auto_arrange / grid_relayout / grid_layout_reset 尾部 + ensure_native_layout 第⑤步（**启动即摆位**，关自动排列不会重摆图标）。改这三处守卫时 find 串必须带 grid_log 文案锚定（两函数尾部逐字相同）。
- ★★ **渲染几何 = 引擎几何**（V59/V70）：`height: box.height`、**不叠 `max-height`**（装不下交盒内滚动）；**常量差 1px 就少一行/列**；根画布永远 `overflow-hidden`、菜单必须 `fixed`。拖动链路（V57）：移动永远可用，锁只收编辑。
- ★★ **菜单不许有两个同名项**（V89）：注入前先摘原生同名（`CNewMenu` 无 view 必 E_FAIL）；摘除**倒序**、判据只认**开头**。
- ★★ **`run_on_main_thread` 只投递、不等结果**（V89）：弹菜单必配 `mpsc` 等回传（否则 Promise 早 resolve ⇒ 竞速判据必误判）。
- ★★ **「隐藏改名框」链路已删（V96）**：ShellNew 要隐藏视图在前台、改名框必抢前台 ⇒ 互斥，V92–V95 七轮不收敛。**别再往回加** `LVM_CANCELEDITLABEL`/`VK_RETURN`/`EDIT_*`/`grid_focus_desktop`（守卫有反向断言）。
- ★★ **条目改名框必须全选默认名**（V96）：`autoFocus` 只聚焦不选中 ⇒ 打字变**追加**。两个 input 都要 `onFocus={e => e.currentTarget.select()}`。
- ★★ **B 模式「原生图标可点」两条腿**（V102）：① 根画布 `pointerEvents: none`；② **命中区只报每格标题栏**（归属由 Rust 25ms 轮询裁决，不报整窗）。不变量 `HIT_PADDING(4) < GRID_PAD_Y(8)`。代价：拖文件进格子只剩标题栏 37px。
- **复刻菜单 = 回退 + 条目菜单**（V58/V90）：`CMF_NORMAL|CMF_EXPLORE`（**不传 `CMF_CANRENAME`**）；`IContextMenu2/3` 消息**必须转发**。层级：盒子(auto)<参考线 35<工作台 38<面板 40<菜单 50<预览 95。
- ★★ **便签 contentEditable**（V67/V68）：`\n` 写进光标所在文本节点 + 垫 ZWSP；「跳出」看「上一步是不是我们插的换行」；`applyHighlight` 每 400ms 重写 `innerHTML` ⇒ `reapplyZwsp` 必须在 `restoreCaretIn` 之前。
- ★★ **压缩列高不许事后夹 `MIN_BOX_H`**（V68）：先缩放再夹会顶出可用区 ⇒ **二分求最大可行缩放比**。

## 3. 布局（用户口径 = 5 列）
**第1列「未归类」竖条已于 V102 退场（`min_x = ARRANGE_MARGIN`）→ 归纳格子 → 便签 → 工作台**。收纳区右界 = `workstation_rect().x - ARRANGE_GAP_X`。
- **V69 按内容定尺寸**：尺寸只看条目数；常量 `CELL_EXTRA_W=32`、`BOX_CELL_EXTRA_H=36`（勿混竖条 30）、`BOX_HEADER_H=37`、`GRID_SCROLLBAR_W=4`、`BOX_FIT_SLACK=2`、`MIN_BOX_W=160/120`、`AUTO_MAX_W=520`、`AUTO_MAX_COLS=5`；摆放序 = `(面积, 内容量, 高, 宽)` 降序（**内容量分量不可省**）。
  - ★★ **V95 分列 = 顺序填充**（用户「从右到左 从上到下 满了才换列」；LPT 最矮列废弃）：第一列塞满才换列；**物理装不下退回 LPT 均衡**。评分 `(-k, 自然宽优先, tallest, used_w)`：列数最少赢；**同 k 没夹宽的赢**（V94/V84 作废）。带下分流：whole `overflowed||squeezed` 才拆分。
  - ★★ **V101 带下拆分平局裁决 = 升序遍历 + `<=`**（真机事故：便签 5→2 后六格全体甩到便签底下 y=364、上带整片留空）：降序 + `<=` 会让最后检查的 m=0 赢走所有平局。**平局时 band_a 装得更多者胜**（m 越大越优先；m=0 全塞带下只有严格更低才能赢）。
  - **V97–V99 桌面右键自绘 + 新建› 对齐原生**：细节/踩坑见 CONVENTIONS（**B 方案起整体删**）。
- ★★ **V85 落位右锚定 + 列内撑满**：列**从右往左**排（第一列贴便签/工作台侧）；窄格**撑到列宽**并按新宽重算高（只撑宽、**不夹窄**）。`content_plan_in` ④ 用**右沿递减**（摆完一列 `right = x - GAP`）——写成「x = 右沿−总宽」= 块**左**端 ⇒ 左溢。
- ★ **幂等是算出来的，不许几何去兜**（V69）：摆放序是内容的纯函数 ⇒ 尺寸没变 ⇒ 落位一字不差。
- ★★ **V70**：内部几何两边逐像素相等（差 1px ⇒ 提前出滚动条 ⇒ 少一列）；高度上限跟 zone_h；**满了不许再建**（`probe_room_for_another_box` 真插真排看 overflowed，出错放行）。
- **V50**：① 挂件由列规则安置；② 收纳格**不跨进挂件带**（`band_left` = 挂件列计划最小值）；③ 便签恒定一列。
- **工作台**（V60/V62，宽 400）：日历 + 快捷入口 + 按钮（便签/格子/**整理**/显示·收起）；`WORKSTATION_W==WST_BOX_W==400` 由 `test-desktop-constants.mjs` 锁。**动态整理**（V66）：`relayoutSoon()`（120ms 防抖）→ `gridRelayout()`。

## 4. 批次索引（细节见 PROJECT_STATUS §1.x；约定/踩坑见 CONVENTIONS）
- **V42–V71**：竖条·三面板·Z 序锚定·挂件分列·指针拖拽·工作台·列式填满（**V64/V65 作废**）。
- **V75–V80** 桌面日历（`jumpTo` 夹 1900–2100 且带 selected、写盘走 `patchSettings`）。
- **V81–V101**（**B 方案起多为死码，待 Step 6 清**）：桌面右键九轮 V97 定稿 / V89–V92 五次迭代终判「不代理」/ V83–V85 几何不持久化 + 只算主屏（变则广播 `grid:bounds-changed`，副屏全原生）/ V93–V96 新建链路（判据·确认·还前台三块已删）/ V99 排序方式（随竖条删）/ **V101 格子乱排修复见 §3**。
- ★★ **B 方案（10-10 拍板；10-11 Step 4+5 已落地+装机）**：文档 `docs/04-review/{REVIEW-2026-10-10,PLAN-B-PHASED}.md`；根因 = 「接管桌面」这条路线本身在持续生产 bug。分支 `b-plan`（**已推 origin**）：Step 0–3 `699038d`→`c682f36`；**Step 4+5 = `ba78b36`**（接管能力整体删除 + 竖条退场 + 迁移 **v12** 清三键）；**V102.1 = `353c3a7`**（loadIcon 失败留痕 + 重试）。**剩余 Step 6a/6b**（删死代码 / 拆 grid.rs）。⚠️ `NoteWindow.tsx`（`App.tsx:111`）与 `shell_menu.rs`（格子条目右键）都是**活的**，禁删 —— 方案 v1 那三条删除建议是错的。守卫：shell-menu 150 / drag-pointer 163 / icon-control 97；`cargo test --lib` 90；变异 118 用例全捕获。
- ⚠️ agent 会话启动不了本 GUI ⇒ 打包 + 装机即止，**不代启动**。

## 5. 协作与操作约定
- 偏好：先规划后执行；表格化；绝对路径；改文件前先读取。红线：禁对真实用户目录写（测试限 TEMP 沙箱）。
- **批次收尾**：打包 → 停旧版 →（接管中先归还桌面图标）→ 装机 → `cmp -l` 取证（0 差异=生效）→ 停手不启动。
- ★ **接管期间装机必须先归还桌面**（V45）：查 DB → 停进程 → **立刻** `desktop-icon-restore.py` → `desktop-icon-probe.py` 复核 → `desktop_icons_hidden='0'` → 装机。**不能先恢复再杀**。
  ★★ **只置 `desktop_icons_hidden`，别动另两键**（V79）：后两者是**偏好/上次显隐意图**，一律清零 = 悄悄替用户关掉接管 ⇒ 下次启动两份内容。
- ★ `taskkill` 用**单斜杠** `/IM handy.exe /F` + `MSYS_NO_PATHCONV=1`（`//IM` 报无效参数而**进程照样活着**）。
- ★ 跑打包脚本前必须 `export PATH="/usr/bin:/bin:/mingw64/bin:$PATH"`：否则跑去调 `wsl.exe` ⇒ 被安全策略硬拦。
- ★★ **NSIS `/S` 会被 SIGTERM 打断**（连跑两次也不生效）⇒ 兜底：无 `bundle.resources`（dist 已嵌 exe）⇒ `cp -f 构建exe 已装exe` **等价**，`cmp -l` 0 字节 = 生效。
- ★★ 被 `2>/dev/null` 包住的探针，不许用「空输出」当结论 ⇒ 一律 `tasklist | grep -qi handy`。
- 高频坑（详见 CONVENTIONS）：同文件多处 Edit **串行**；`npm.cmd` 被拦 → `node node_modules/<cli>/<entry>.js`；**打包中改源码 ⇒ 产物半新半旧，必须重打**；`w!` 宏只收字面量（动态 label 用 `HSTRING`）。

## 6. 验证纪律
- agent 自报 “exit 0” 不可信 → 独立复跑、输出与 exit code 分文件落盘再 Read。
- ★★ 取 Shell 图标 / `::{CLSID}` 这类取证**禁用 Python ctypes**：本机对 shell32 调用**不可靠**（连对照组 `C:\Windows` 都在 Parse 就报 E_INVALIDARG）⇒ 结论必假。**改用 crate 临时测试**（`cargo test --lib <名> -- --nocapture`，跑完 `git checkout -- 文件` 还原）。**改源码取证后必须立刻还原** —— 本轮曾两次事故：脚本写文件把 grid.rs 整文件 CRLF→LF（整文件 diff）、全局 `replace('".to_string()),'` 误伤两处。
- 图标类症状的判据：**「提取成功」≠「图标内容正确」** ⇒ 要把提取到的像素导出来亲眼看（10-11 就是靠这个证明本机「黄文件夹」不是后端取的、而是前端回退）。前端取图标失败**必须留痕**（V102.1 之前是纯静默，出事无法归因）。
- 回归里算错的期望值比产品代码更危险 —— 逐条反问「失败场景下它会不会也成立」。
- 断言别打全文（会命中**注释** ⇒ 假通过）：打**调用点**或**行锚定**；顺序类用 `indexOf` 比位置。
- 已知预存问题（非回归）：`layout-audit` 0/84；`sample-smoke` 29/29。
- ★★ **变异自检与回归必须串行**（V102）：变异自检会**临时改源码再还原** ⇒ 并行跑回归会读到被改的源码、报假失败（本次出现 21/22，单独复跑即 22/22）。
- GUI 问题先用已知 good 旧产物对照；浮层不见 → 日志 + `window-probe.py`。
