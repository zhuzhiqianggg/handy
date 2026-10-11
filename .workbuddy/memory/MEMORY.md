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
- ★★ **装机打包禁令（V102.8 事故）**：裸 `cargo build --release` 产出 **dev 模式 exe**（不嵌 dist ⇒ WebView2 连 `localhost:1420` ⇒ 启动即「localhost 拒绝连接」白页）。装机必须走 `build-release.sh --no-deploy`（内部 `tauri build` 自动带 `custom-protocol`）；内存紧张致 rustc OOM（0xc0000409，编 lib 三件套 staticlib/cdylib/rlib 时）可退 `cargo build --release --features custom-protocol --bin handy`。**判据：`grep -c "assets/index-" exe` >0 = 已嵌 dist；0 = dev 模式禁装。**

## 2. 硬不变量（改前必读）
- **格子 = 呈现层**（V37）：归类/拖入**不移动文件**；V48 起 Rust 无 `fs::rename`。★★ **V102.8 起不接管（B 方案唯一模式）**：`const iconControl = true`（GridOverlay.tsx 硬编码）—— 不藏 `SysListView32`，格子=装饰底板+标题栏、内容区 `pointerEvents:none` 穿透、竖条不渲染，图标归 Explorer ⇒ Delete/Shift+Delete/框选/右键/属性/第三方 Shell 扩展**全原生**。
- `grid_overlay_hide` 只收内容（**不**藏挂件窗，否则无入口=死路）；启动 `restore_overlay_if_visible` 不弹主窗。
- **「常驻」与「盒子」互斥**（V60）：退出整理后还在 ⇒ 必须浮窗，引擎当禁区（右侧整列 400）。
- **外部唤起 = 入队+唤醒**（V60）：冷启动 emit 必丢 ⇒ `PENDING_ACTION` 入队（挂载 + 收到唤醒各取一次，**不采信载荷**）。HKCU 能力必须有版本标记：`install()` **整键重建**。**一个跨线程状态只许一个记账人**（V61）。
- ★★ **显隐唯一真源 `overlay_visible`：谁写谁广播**（V79）：三处写完必须 `emit_visibility`；托盘**不许**再自己发。前端 `contentHidden` 初值 **`true`**（fail-closed），**先注册监听、再查状态**。
- **内部拖拽 = 指针拖拽**（V59）：wry 无 `CF_HDROP` 不写 `*pdwEffect` ⇒ 自算落点（5px）；**不许关 `drag_drop_enabled`**。
- ★★ **槽位锚点不是常量、是视图状态函数**（V102.9 实测推翻 V102.3）：同机三个时刻分别测到 **(0,5)**（`icon_pos_backup` 快照）/ **(27,2)**（旧接管版运行中）/ **(0,0)**（V102.8 纯 B 方案），步长恒为 `LVM_GETITEMSPACING`(逻辑 76×88)×DPI = 物理 **95×110**。**「从现有图标坐标 mod 步长反推」永远得不到它**（图标坐标里还叠着一层与槽位无关的偏移）。另有两点被证伪：① 纯 B 方案视图下 `LVM_SETITEMPOSITION` **写什么读回什么、零吸附**（15 次试探含 2s 长等待）；② `LVS_EX_SNAPTOGRID` **本来就是关的**。⇒ 摆位策略 = `set_snap_to_grid(false)` + **`di::snap_grid()` 现场实测**（写 (0,0) 读回即锚点；用最后一个图标当探针、**务必复位**）+ 失败退回反推并记日志。⚠️ `LVM_SETEXTENDEDLISTVIEWSTYLE` 语义是 **`wParam`=mask、`lParam`=新值**（不是 set/clear —— 写反会把样式打开）。`LVM_SETICONSPACING` 引发**全桌面重排**（禁用）。⚠️ 跨进程坐标实验必须 `SetProcessDpiAwarenessContext(-4)`（cargo test 默认 DPI-unaware 读到虚拟化值）；`work_area().position` 是物理、格子坐标是逻辑 —— 混算曾被 (0,0) 主屏掩盖。
- ★★ **「夹紧」与「判断能不能装下」必须用两个值**（V102.9）：`box_height_at` 把越界需求夹成 `zone_h` ⇒ 调用方 `tallest > zone_h` 的越界检查**形同虚设** ⇒「1 列装 34 条」这种根本装不下的解被判为可行 ⇒ 真机 75 条里 **50 条被摆到格子外/屏幕外**（物理 y 到 2455，屏幕只有 1080）= 用户截图「图标没进格子」。修：`box_height_needed()`（真实需求，不夹紧）当**可行性判据**，`box_height_at`（夹紧）只用于**最终落库**。★ B 模式特有：图标是 Explorer 画的、**格子没有滚动能力** ⇒ `apply_layout` 必须按 `cols × max_rows` **截断**（宁可少摆 + 记日志，也不许摆到看不见的地方）。
- ★★ **渲染几何 = 引擎几何**（V59/V70）：`height: box.height`、**不叠 `max-height`**（装不下交盒内滚动）；**常量差 1px 就少一行/列**；根画布永远 `overflow-hidden`、菜单必须 `fixed`。拖动链路（V57）：移动永远可用，锁只收编辑。
- ★★ **条目改名框必须全选默认名**（V96）：`autoFocus` 只聚焦不选中 ⇒ 打字变**追加**。两个 input 都要 `onFocus={e => e.currentTarget.select()}`。
- ★★ **便签 contentEditable**（V67/V68）：`\n` 写进光标所在文本节点 + 垫 ZWSP；「跳出」看「上一步是不是我们插的换行」；`applyHighlight` 每 400ms 重写 `innerHTML` ⇒ `reapplyZwsp` 必须在 `restoreCaretIn` 之前。
- ★★ **压缩列高不许事后夹 `MIN_BOX_H`**（V68）：先缩放再夹会顶出可用区 ⇒ **二分求最大可行缩放比**。

## 3. 布局（用户口径 = 5 列）
**未归类竖条（V102 曾退场，V102.5 回退后**又回来了**）→ 归纳格子 → 便签 → 工作台**。收纳区右界 = `workstation_rect().x - ARRANGE_GAP_X`。
- **V69 按内容定尺寸**：尺寸只看条目数；常量清单由 `test-desktop-constants.mjs` 锁（`CELL_EXTRA_W=32`/`BOX_CELL_EXTRA_H=36` 勿混 30/`BOX_HEADER_H=37`/`MIN_BOX_W=160,120`/`AUTO_MAX_W=520`）；摆放序 = `(面积, 内容量, 高, 宽)` 降序（**内容量分量不可省**）。
  - ★★ **V95 分列 = 顺序填充**（用户「从右到左 从上到下 满了才换列」；LPT 废弃）：第一列塞满才换列；装不下退回 LPT 均衡。评分 `(-k, 自然宽优先, tallest, used_w)`：列数最少赢、**同 k 没夹宽的赢**。带下分流：whole `overflowed||squeezed` 才拆。
  - ★★ **V101 带下拆分平局裁决 = 升序遍历 + `<=`**（真机事故：便签 5→2 后六格全体甩到便签底下、上带留空）：**平局时 band_a 装得更多者胜**（m=0 只有严格更低才能赢）。
- ★★ **V85 落位右锚定 + 列内撑满**：列**从右往左**排（第一列贴便签/工作台侧）；窄格**撑到列宽**并按新宽重算高（只撑宽、**不夹窄**）。`content_plan_in` ④ 用**右沿递减**（摆完一列 `right = x - GAP`）——写成「x = 右沿−总宽」= 块**左**端 ⇒ 左溢。
- ★ **幂等是算出来的，不许几何去兜**（V69）：摆放序是内容的纯函数 ⇒ 尺寸没变 ⇒ 落位一字不差。
- ★★ **V70**：内部几何两边逐像素相等（差 1px ⇒ 提前出滚动条 ⇒ 少一列）；高度上限跟 zone_h；**满了不许再建**（`probe_room_for_another_box` 真插真排看 overflowed，出错放行）。
- **V50**：① 挂件由列规则安置；② 收纳格**不跨进挂件带**（`band_left` = 挂件列计划最小值）；③ 便签恒定一列。
- **工作台**（V60/V62，宽 400）：日历 + 快捷入口 + 按钮（便签/格子/**整理**/显示·收起）；`WORKSTATION_W==WST_BOX_W==400` 由 `test-desktop-constants.mjs` 锁。**动态整理**（V66）：`relayoutSoon()`（120ms 防抖）→ `gridRelayout()`。

## 4. 批次索引（细节见 PROJECT_STATUS §1.x；约定/踩坑见 CONVENTIONS）
- **V42–V71**：竖条·三面板·Z 序锚定·挂件分列·指针拖拽·工作台·列式填满（**V64/V65 作废**）。
- **V81–V101**：桌面右键九轮 V97 定稿 / V89–V92 终判「不代理」/ V83–V85 几何不持久化 + 只算主屏 / V93–V96 新建链路 / **V101 带下拆分见 §3**。
- ★★ **现状基线 = `89797a9`（V102.8，b-plan 已推）**：B 方案落地。`Cell{w,h,gap}` 横纵**实测**（`icon_spacing_x`/`_y`，gap=0，横向必须实测不许反推——V102.3 就是反推 84 vs 真值 76 才「散成一片」）；`b_cell` 读不到退 `Cell::from_icon(32)`。固有代价：用户手动拖走图标 ⇒ 格子空一块。⚠️ `NoteWindow.tsx`（`App.tsx:111`）与 `shell_menu.rs` **活的**，禁删。守卫基线：shell-menu 150 / drag-pointer 163 / icon-control 109；cargo 91；变异 4 守卫 **126** 全捕获。V102.1–V102.7 与 `ba78b36` 全部作废。**待用户拍板**：Step 6a 清死代码（7 条 never used 警告）/ 6b 拆 grid.rs（11.7k 行）。
- **V102.7 幽灵条目**（10-11）：格子条目指向的文件已被删 ⇒ 右键**毫无反应**（`SHCreateItemFromParsingName` → 0x80070002；失败在 `run_on_main_thread` 闭包里、前端收不到）。修：① `shell_context_menu` 投递前探路径回人话；② 前端 `.catch` 里 refresh 摘登记；③ `onDesktopChanged` 加 `added.length===0` 对账（原来只看竖条）。★ **教训：登记式格子 ⇒ 外部删除靠「变化事件 + 对账」兜，别等 15s 轮询。**
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
