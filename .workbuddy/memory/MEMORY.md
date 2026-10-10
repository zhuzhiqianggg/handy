# Handy · 顺手 — 项目长期记忆

> 续接必读：批次明细 → PROJECT_STATUS.md；约定/踩坑 → CONVENTIONS.md；逐日 → YYYY-MM-DD.md。
> **超限会被注入截断而失效** ⇒ 只留跨会话最小集，**上限 ~12.5KB**；加内容前先删等量旧内容。

## 1. 标识与路径
- Handy · 顺手；identifier `com.handy.desktop`；`productName` 必须 `Handy`（禁中文/间隔号）。
- 栈 Tauri 2 + React 18 + TS + Vite + Tailwind + shadcn/ui + cmdk + Zustand；SQLite + tauri-plugin-store。窗口 6：main/note/settings/organizer/grid-overlay/workstation-bar。
- 根 `D:\_Projects\ops\handy`；参考 `D:\_Projects\ops\ops-tools`（只读）；权威文档 `docs/{01,02,03}-*`（含 `02-architecture/DESKTOP-LAYER.md`）。
- ★ Git：远端 `git@github.com:zhuzhiqianggg/handy.git`（**必须 SSH**，HTTPS 超时）；分支 main。推送前看 `size-pack`（正常 ~2MB，暴涨=`target/` 漏进）。
- 真实库 `%APPDATA%\com.handy.desktop\handy.db`（接管态看 `grid_meta` 三键）；日志/程序 `%LOCALAPPDATA%\Handy\`。
- 命令：Rust `source scripts/rust-env.sh && cd src-tauri`（⚠️ 无 src-tauri/scripts/）；tsc `node node_modules/typescript/bin/tsc --noEmit`；打包 `build-release.sh --no-deploy`；回归 `scripts/regression/run.mjs`；**改守卫必跑** `scripts/audit/guard-mutation-check.py`。布局测试走 `layout_all_boxes_with()` 注入（不依赖测试机桌面）；迁移链 v1→v11 由 `cargo test --lib` 守。

## 2. 硬不变量（改前必读）
- **格子 = 呈现层**（V37）：归类/拖入**不移动文件**；整理后**接管桌面呈现**（隐藏 `SysListView32`）。V48 起 Rust 无 `fs::rename`。
- **接管与归还**：`grid_overlay_hide` 只收内容 + 恢复原生图标（**不**藏挂件窗，否则无入口=死路）。启动 `restore_overlay_if_visible` 不弹主窗；退出恢复三处，**强杀不触发**。
- **Z 序锚定法**（V47）：`anchor=GetWindow(host,GW_HWNDPREV)` 后 `SetWindowPos(overlay,anchor)`（= 放到 X **下面**）。
- **「常驻」与「盒子」互斥**（V60）：退出整理后还在 ⇒ 必须浮窗，引擎当**禁区**（右侧整列 400）。
- **外部唤起 = 入队+唤醒**（V60）：冷启动 emit 必丢 ⇒ `PENDING_ACTION` 入队（挂载 + 收到唤醒各取一次，**不采信载荷**）。**HKCU 能力必须有版本标记**（V60）：`install()` **整键重建**（只写不删 ⇒ 死按钮）。**一个跨线程状态只许一个记账人**（V61：两条写路即失同步）。
- ★★ **显隐唯一真源 `overlay_visible`：谁写谁广播**（V79）：三处写完必须 `emit_visibility`；托盘**不许**再自己发。前端 `contentHidden` 初值 **`true`**（fail-closed），**先注册监听、再查状态**。
- **「撤掉强制可交互」≠「立刻穿透」**：`let want = interactive || cursor_hit(&win)`（**或**）。
- **内部拖拽 = 指针拖拽**（V59）：wry 无 `CF_HDROP` 不写 `*pdwEffect` ⇒ 自算落点（5px）；**不许关 `drag_drop_enabled`**。
- ★★ **渲染几何 = 引擎几何**（V59/V70）：`height: box.height`、**不叠 `max-height`**（装不下交盒内滚动）；**常量差 1px 就少一行/列**；根画布永远 `overflow-hidden`、菜单必须 `fixed`。拖动链路（V57）：移动永远可用，锁只收编辑。
- ★★ **菜单不许有两个同名项**（V89）：注入前先摘原生同名（`CNewMenu` 无 view 必 E_FAIL）；摘除**倒序**、判据只认**开头**。
- ★★ **`run_on_main_thread` 只投递、不等结果**（V89）：弹菜单必配 `mpsc` 等回传（否则 Promise 早 resolve ⇒ 竞速判据必误判）。
- ★★ **「隐藏改名框」链路已删（V96）**：V92 取消→V93 判据→V94 确认→V95 还前台，七轮不收敛（ShellNew **要求隐藏视图在前台**，而能打字的改名框必然抢前台 ⇒ 互斥）。**别再往回加**：`LVM_CANCELEDITLABEL`/`VK_RETURN`/`EDIT_SEEN_TICK`/`EDIT_CANCEL_STAGE`/`grid_focus_desktop`（守卫已加反向断言）。
- ★★ **条目改名框必须全选默认名**（V96）：`autoFocus` 只聚焦不选中 ⇒ 打字变**追加**（实测「新建文件夹 (20)123」）。两个 input 都要 `onFocus={e => e.currentTarget.select()}`。
- **WinEvent `hwnd` 语义不许赌**（V82）：`MENUPOPUPSTART` 给的是菜单窗 `#32768` 自己（判据换 owner + 看压谁，留轮询兜底）。
- **复刻菜单 = 回退 + 条目菜单**（V58/V90）：`CMF_NORMAL|CMF_EXPLORE`（**不传 `CMF_CANRENAME`**）；`IContextMenu2/3` 消息**必须转发**。**层级**：盒子(auto)<参考线 35<工作台 38<面板 40<菜单 50<预览 95。改模式开关前 grep 调用点。
- ★★ **便签 contentEditable**（V67/V68）：`\n` 写进**光标所在文本节点** + 垫 ZWSP；「跳出」看「上一步是不是我们插的换行」（**不许**看末尾空行）；`applyHighlight` 每 400ms 重写 `innerHTML` ⇒ `reapplyZwsp` **必须在 `restoreCaretIn` 之前**；合成 `KeyboardEvent` 测不出回车。
- ★★ **压缩列高不许事后夹 `MIN_BOX_H`**（V68）：先缩放再夹会顶出可用区 ⇒ **二分求最大可行缩放比**。

## 3. 布局（用户口径 = 5 列）
**第1列 未归类竖条 → 第2/3列 归纳格子 → 第4列 便签 → 第5列 工作台**。收纳区右界 = `workstation_rect().x - ARRANGE_GAP_X`。
- **V69 按内容定尺寸**：尺寸只看条目数；常量 `CELL_EXTRA_W=32`、`BOX_CELL_EXTRA_H=36`（勿混竖条 30）、`BOX_HEADER_H=37`、`GRID_SCROLLBAR_W=4`、`BOX_FIT_SLACK=2`、`MIN_BOX_W=160/120`、`AUTO_MAX_W=520`、`AUTO_MAX_COLS=5`。
  - ★ 摆放序 = `(面积, 内容量, 高, 宽)` 降序（**内容量分量不可省**）。
  - ★★ **V95 分列 = 顺序填充**（用户原话「从右到左 从上到下 满了才换列」；LPT 最矮列废弃）：第一列自上往下塞满才换列；**物理装不下（有列越过 cap）退回 LPT 均衡**（顺序填充尾列爆炸，MIN_BOX_H 夹不动）。评分 `(-k, 自然宽优先, tallest, used_w)`：列数最少赢；**同 k 没夹宽的赢** —— 夹宽让格子变高，纵向判据下会反杀。V94 的 `(tallest, used_w)` 与 V84 `min(横,纵)` 都作废。
  - ★★ **带下分流（V94/V95）**：whole `overflowed||squeezed` 才进拆分；拆分候选 pa/pb 任一溢出跳过；收益「不更差就换」（压扁时底沿恒=上限）。
  - ★★ **V97 空白右键 = 前端自绘「Win11 同款」菜单**（`bgMenu` + `BgMenuRow`）：新式菜单**只能由 Explorer 自己渲染**（第三方弹出来必是经典样式）⇒ 自绘外壳逐项接真行为：查看›自动整理/显示桌面图标（勾选=contentHidden）、刷新、新建›（`desktop_create_new` 复用 `create_new_item` 同一落盘路径）、显示设置/个性化/终端（`shell_open_system`：explorer.exe 开 ms-settings；终端 wt 退回 powershell）、**显示更多选项 = 经典背景菜单**；Shift 右键直达经典扩展。刻意不做摆设项（排序方式/撤消/下一个背景）。
- ★★ **V85 落位右锚定 + 列内撑满**：列**从右往左**排（第一列贴便签/工作台侧）；窄格**撑到列宽**并按新宽重算高（只撑宽、**不夹窄**）。`content_plan_in` ④ 用**右沿递减**（摆完一列 `right = x - GAP`）——写成「x = 右沿−总宽」= 块**左**端 ⇒ 左溢。
- ★ **幂等是算出来的，不许几何去兜**（V69）：摆放序是内容的纯函数 ⇒ 尺寸没变 ⇒ 落位一字不差。
- ★★ **V70**：内部几何两边逐像素相等（差 1px ⇒ 提前出滚动条 ⇒ 少一列）；高度上限跟 zone_h；**满了不许再建**（`probe_room_for_another_box` 真插真排看 overflowed，出错放行）。
- **V50**：① 挂件由列规则安置；② 收纳格**不跨进挂件带**（`band_left` = 挂件列计划最小值）；③ 便签恒定一列。
- **工作台**（V60/V62，宽 400）：日历 + 快捷入口 + 按钮（便签/格子/**整理**/显示·收起）；`WORKSTATION_W==WST_BOX_W==400` 由 `test-desktop-constants.mjs` 锁。**动态整理**（V66）：`relayoutSoon()`（120ms 防抖）→ `gridRelayout()`。

## 4. 批次索引（细节见 PROJECT_STATUS §1.x；约定/踩坑见 CONVENTIONS）
- **V42–V71**：竖条·三面板·Z 序锚定·挂件分列·指针拖拽·工作台·列式填满（**V64/V65 作废**）。
- **V75–V80** 桌面日历；V80：`jumpTo` **夹 1900–2100 且带 selected**、写盘走 `patchSettings`（禁 `writeSettings`）。
- **V81/V82** 菜单期间还桌面 ⇒ **V89 起停用**（`HANDOFF_DISABLED`，`is_active()` 恒 false）。
- **V83–V85** 几何不持久化+**只算主屏**（`sync_overlay_bounds()`，变则广播 `grid:bounds-changed`；副屏全原生）；落位**右锚定**+**列内撑满**（§3）。
- **V87/V88** 背景菜单自弹（`CreateViewObject`；坑：`FOLDERID_Desktop`+`BindToObject` 必 `E_INVALIDARG`）；原生「新建」需 `IShellView` ⇒ 自注入；改名后本地先改 `items`/`loose` 再 `refresh`。
- **V89–V97 桌面右键：八轮迭代，V97 定稿「自绘 Win11 同款菜单」**。V89 抢空白右键⇒菜单残缺；V90/V91 试转发⇒双菜单 + `SetForegroundWindow` 让 `CNewMenu` 找不到 view⇒新建建不出；V92 改**穿透**（handoff 停用⇒不翻白，补偿：目录签名广播）；V93–V95 围着「隐藏改名框」打转；V96 收回自有菜单（穿透在隐藏视图下本就空转）；V97 用户对照截图嫌经典样式丑 ⇒ 自绘（见 §3）。
- **V93–V96 新建链路**（V96 收敛）：前端「改名/新建安静期」保留（重排/刷新挂起、重排优先补跑），`grid:desktop-changed` 走增量 `onDesktopChanged`（唯一新增 → `beginItemRename`）；判据/确认/还前台三块已删（见 §2）。守卫 shell-menu 123、变异 89。
- ★★ **B 方案（用户 10-10 拍板，未做）：重构为「不接管原生桌面」**，挂件保留为桌面浮窗。调研（LucidDesk/DeskBox/openFences/DesktopIconMover）**无一接管桌面**：不自绘，或用 `LVM_SETITEMPOSITION` 遥控原生图标（lParam 装坐标，**跨进程无需注入**）。① 不隐藏 `SysListView32`，关「自动排列/对齐网格」后 SETITEMPOSITION 摆位；② 格子改装饰底板+标题栏、内容区穿透 ⇒ `GridOverlay.tsx` 大瘦身。
- ⚠️ agent 会话启动不了本 GUI ⇒ 打包 + 装机即止，**不代启动**。

## 5. 协作与操作约定
- 偏好：先规划后执行；表格化；绝对路径；改文件前先读取。红线：禁对真实用户目录写（测试限 TEMP 沙箱）。
- **批次收尾**：打包 → 停旧版 → **归还桌面图标** → 装机 → `cmp -l` 取证 → 停手不启动。`cmp -l` **装机之后**做：**0/3 字节**=生效；大量差异=旧构建。
- ★ **接管期间装机必须先归还桌面**（V45）：查 DB → 停进程 → **立刻** `desktop-icon-restore.py` → `desktop-icon-probe.py` 复核 → `desktop_icons_hidden='0'` → 装机。**不能先恢复再杀**。
  ★★ **只置 `desktop_icons_hidden`，别动另两键**（V79）：前者是**事实**，后两者是**偏好/上次显隐意图** —— 一律清零 = 悄悄替用户关掉接管 ⇒ 下次启动「格子 + 原生图标」两份内容。
- ★ `taskkill` 用**单斜杠** `/IM handy.exe /F` + `MSYS_NO_PATHCONV=1`（`//IM` 报无效参数而**进程照样活着**）。
- ★ 跑打包脚本前必须 `export PATH="/usr/bin:/bin:/mingw64/bin:$PATH"`：否则跑去调 `wsl.exe` ⇒ 被安全策略硬拦。
- ★★ **NSIS `/S` 会被 SIGTERM 打断**（V90/V91，连单独跑两次也不生效）⇒ 兜底：无 `bundle.resources`（dist 已嵌 exe）⇒ `cp -f 构建exe 已装exe` **等价**，`cmp -l` 0 字节 = 生效。
- ★★ 被 `2>/dev/null` 包住的探针，不许用「空输出」当结论 ⇒ 一律 `tasklist | grep -qi handy`。
- 高频坑（详见 CONVENTIONS）：同文件多处 Edit **串行**；`npm.cmd` 被拦 → `node node_modules/<cli>/<entry>.js`；**打包中改源码 ⇒ 产物半新半旧，必须重打**。

## 6. 验证纪律
- agent 自报 “exit 0” 不可信 → 独立复跑、输出与 exit code 分文件落盘再 Read。
- 回归里算错的期望值比产品代码更危险 —— 逐条反问「失败场景下它会不会也成立」。
- 断言别打全文（会命中**注释** ⇒ 假通过）：打**调用点**或**行锚定**；顺序类用 `indexOf` 比位置。
- 已知预存问题（非回归）：`layout-audit` 0/84；`sample-smoke` 29/29。
- GUI 问题先用已知 good 旧产物对照；浮层不见 → 日志 + `window-probe.py`。
