# Handy · 顺手 — 项目长期记忆

> 续接必读：批次明细 → PROJECT_STATUS.md；约定/踩坑 → CONVENTIONS.md；逐日 → YYYY-MM-DD.md。
> **超限会被注入截断而失效** ⇒ 只留跨会话最小集，**上限 ~12.5KB**；加内容前先删等量旧内容。

## 1. 标识与路径
- Handy · 顺手；identifier `com.handy.desktop`；`productName` 必须 `Handy`（禁中文/间隔号）。
- 栈 Tauri 2 + React 18 + TS + Vite + Tailwind + shadcn/ui + cmdk + Zustand；SQLite + tauri-plugin-store。窗口 6：main/note/settings/organizer/grid-overlay/workstation-bar。
- 根 `D:\_Projects\ops\handy`；参考 `D:\_Projects\ops\ops-tools`（只读）；权威文档 `docs/{01,02,03}-*`；桌面层定义 `docs/02-architecture/DESKTOP-LAYER.md`。
- ★ Git：远端 `git@github.com:zhuzhiqianggg/handy.git`（**必须 SSH**，HTTPS 超时）；分支 main。推送前看 `size-pack`（正常 ~2MB，暴涨=`target/` 漏进）。
- 真实库 `%APPDATA%\com.handy.desktop\handy.db`（接管态看 `grid_meta` 三键）；日志/程序 `%LOCALAPPDATA%\Handy\`。
- 命令：Rust `source scripts/rust-env.sh && cd src-tauri`（⚠️ 无 src-tauri/scripts/）；tsc `node node_modules/typescript/bin/tsc --noEmit`；打包 `build-release.sh --no-deploy`；回归 `scripts/regression/run.mjs`；**改守卫必跑** `scripts/audit/guard-mutation-check.py`。布局测试用 `layout_all_boxes_with(loose_count)` 注入，**不依赖测试机桌面**；迁移链 v1→v11 由 `cargo test --lib` 守。

## 2. 硬不变量（改前必读）
- **格子 = 呈现层**（V37）：归类/拖入**不移动文件**；整理后**接管桌面呈现**（隐藏 `SysListView32`）。V48 起 Rust 无 `fs::rename`。
- **接管与归还**：`grid_overlay_hide` 只收内容 + 恢复原生图标（**不**藏挂件窗，否则无入口=死路）。启动 `restore_overlay_if_visible` 不弹主窗；退出恢复三处，**强杀不触发**。
- **Z 序锚定法**（V47）：`anchor=GetWindow(host,GW_HWNDPREV)` 后 `SetWindowPos(overlay,anchor)`（= 放到 X **下面**）。
- **「常驻」与「盒子」互斥**（V60）：退出整理后还在 ⇒ 必须浮窗，引擎当**禁区**（右侧整列 400）。
- **外部唤起 = 入队+唤醒**（V60）：冷启动 emit 必丢 ⇒ `PENDING_ACTION` 入队（挂载 + 收到唤醒各取一次，**不采信载荷**）。**HKCU 能力必须有版本标记**（V60）：`install()` **整键重建**（只写不删 ⇒ 死按钮）。**一个跨线程状态只许一个记账人**（V61 ⇒ 两条写路就双击失效：右键好使、左键不好使）。
- ★★ **显隐唯一真源 `overlay_visible`：谁写谁广播**（V79）：三处写完必须 `emit_visibility`；托盘**不许**再自己发。前端 `contentHidden` 初值 **`true`**（fail-closed），**先注册监听、再查状态**。
- **「撤掉强制可交互」≠「立刻穿透」**：`let want = interactive || cursor_hit(&win)`（**或**）。
- **内部拖拽 = 指针拖拽**（V59）：wry 对无 `CF_HDROP` 载荷不写 `*pdwEffect` ⇒ 自算落点（`DRAG_THRESHOLD=5px`）；**不许为修它关 `drag_drop_enabled`**。
- ★★ **渲染几何 = 引擎几何**（V59/V70）：`height: box.height`、**不叠 `max-height`**；装不下交盒内滚动。**常量差 1px 就少一行/列**。根画布永远 `overflow-hidden`（V59.1），菜单必须 `fixed`。拖动链路（V57）：移动永远可用，锁只收编辑；`onUp` 判「真动过」才落库。
- ★★ **菜单不许有两个同名项**（V89）：注入前先摘原生同名（`CNewMenu` 无 view 必 E_FAIL）；摘除**倒序**、判据只认**开头**。
- ★★ **`run_on_main_thread` 只投递、不等结果**（V89）：弹菜单用它 ⇒ Promise 在菜单弹出前就 resolve ⇒ 前端「超时/竞速」判据必误判。要结果就配 `std::sync::mpsc` 等回传。
- ★★ **隐藏改名框：判据 `LVM_GETEDITCONTROL`，动作必须是「回车确认」不是「取消」**（V94）：判据错（`FindWindowEx("Edit")` 恒真）曾致 138 条刷屏；V92/V93 的「取消」更致命 —— **原生新建语义 = 取消改名就删刚建的文件** ⇒「只能建一个、第二个建不出」+ 桌面重绘。V94：仅接管态、检测到就投 `VK_RETURN`（默认名保留），600/1200ms 有限重试，改名交我们自己的框。
- ★★ **WinEvent 的 `hwnd` 语义不许赌**（V82）：`EVENT_SYSTEM_MENUPOPUPSTART` 实测给的是**菜单窗 `#32768` 自己** ⇒ 判据要**换 owner + 看菜单压谁**，并留轮询兜底。
- **复刻菜单只剩回退 + 条目菜单**（V58/V90）：`CMF_NORMAL|CMF_EXPLORE`（**不传 `CMF_CANRENAME`**）；`IContextMenu2/3` 消息**必须转发**。**层级**：盒子(auto)<参考线 35<工作台 38<面板 40<菜单 50<预览 95。改模式开关前 grep 调用点（V52）。
- ★★ **便签 contentEditable**（V67/V68）：`\n` 写进**光标所在文本节点** + 垫 ZWSP；「跳出」看「上一步是不是我们插的换行」（**不许**看末尾空行）；`applyHighlight` 每 400ms 重写 `innerHTML` ⇒ `reapplyZwsp` **必须在 `restoreCaretIn` 之前**；合成 `KeyboardEvent` 测不出回车。
- ★★ **压缩列高不许事后夹 `MIN_BOX_H`**（V68）：先缩放再夹会顶出可用区 ⇒ **二分求最大可行缩放比**。

## 3. 布局（用户口径 = 5 列）
**第1列 未归类竖条 → 第2/3列 归纳格子 → 第4列 便签 → 第5列 工作台**。挂件带/收纳区右界 = `workstation_rect().x - ARRANGE_GAP_X`。
- **V69 按内容定尺寸**：尺寸只看条目数；常量 `CELL_EXTRA_W=32`、`BOX_CELL_EXTRA_H=36`（勿混竖条 30）、`BOX_HEADER_H=37`、`GRID_SCROLLBAR_W=4`、`BOX_FIT_SLACK=2`、`MIN_BOX_W=160/120`、`AUTO_MAX_W=520`、`AUTO_MAX_COLS=5`。
  - ★ 摆放序 = `(面积, 内容量, 高, 宽)` 降序（**内容量分量不可省**）。
  - ★★ **V95 分列 = 顺序填充**（用户原话「从右到左 从上到下 满了才换列」；LPT 最矮列废弃）：第一列自上往下塞满才换列；**物理装不下（有列越过 cap）退回 LPT 均衡**（顺序填充尾列爆炸，MIN_BOX_H 夹不动）。评分 `(-k, 自然宽优先, tallest, used_w)`：列数最少赢；**同 k 没夹宽的赢** —— 夹宽让格子变高，纵向判据下会反杀。V94 的 `(tallest, used_w)` 与 V84 `min(横,纵)` 都作废。
  - ★★ **带下分流（V94/V95）**：whole `overflowed||squeezed` 才进拆分；拆分候选 pa/pb 任一溢出跳过；收益「不更差就换」（压扁场景底沿恒=上限，严格 < 永远落空）。
  - ★★ **V95 还前台**：Explorer 的 CNewMenu **要求 view 在前台** —— 我们 setFocus 抢前台 ⇒ 下一次原生新建静默失败（V91 死法换入口复发）。改名框关闭时 `grid_focus_desktop`（SetForegroundWindow(GetAncestor(list,GA_ROOT))，仅接管态）。涉及原生新建的改动先问「此时前台是谁」。
- ★★ **V85 落位右锚定 + 列内撑满**：列**从右往左**排（第一列贴便签/工作台侧）；窄格**撑到列宽**并按新宽重算高（只撑宽、**不夹窄**）。`content_plan_in` ④ 用**右沿递减**（摆完一列 `right = x - GAP`）——写成「x = 右沿−总宽」= 块**左**端 ⇒ 左溢。
- ★ **幂等是算出来的，不许几何去兜**（V69）：摆放序是内容的纯函数 ⇒ 尺寸没变 ⇒ 落位一字不差。
- ★★ **V70**：内部几何两边逐像素相等（差 1px ⇒ 提前出滚动条 ⇒ 少一列 ⇒ 更溢出）；高度上限跟 zone_h；**满了不许再建**（`probe_room_for_another_box` 真插真排看 overflowed，出错当放行）。
- **V50**：① 挂件由列规则安置；② 收纳格**不跨进挂件带**（`band_left` = 挂件列计划最小值）；③ 便签恒定一列。
- **工作台**（V60/V62，宽 400）：日历 + 快捷入口 + 按钮（便签/格子/**整理**/显示·收起）；`WORKSTATION_W == WST_BOX_W == 400` 由 `test-desktop-constants.mjs` 锁。**动态整理**（V66）：`relayoutSoon()`（120ms 防抖）→ `gridRelayout()`。

## 4. 批次索引（细节见 PROJECT_STATUS §1.x；约定/踩坑见 CONVENTIONS）
- **V42–V71**：竖条·三面板·桌面右键·Z 序锚定·挂件分列·指针拖拽·工作台·列式填满；**V64/V65 已作废**。
- **V75–V80** 桌面日历（自适应行数、三行 38px）；V80 选年+纪念日：`jumpTo` **夹 1900–2100 且带 selected**、写盘走 `patchSettings`（禁 `writeSettings`）。
- **V81/V82** 「菜单期间把桌面还给系统」**V89 起整体停用**（`HANDOFF_DISABLED`，`is_active()` 恒 false）。
- **V83–V85** 几何不持久化+**只算主屏**（`sync_overlay_bounds()`，变则广播 `grid:bounds-changed`；副屏全原生）；新建慢=收回竞速；落位**右锚定**+**列内撑满**（§3）。
- **V87/V88** 空白右键自己弹**背景菜单**（`CreateViewObject`；坑：`FOLDERID_Desktop`+`BindToObject` 必 `E_INVALIDARG`）；原生「新建」E_FAIL = `CNewMenu` 需 `IShellView` ⇒ 自注入「新建」；改名后 UI 不刷新 ⇒ 本地先改 `items`/`loose` 再 `refresh`。
- **V89–V92 桌面右键：五次迭代，最终结论「不代理」**。V89 抢空白右键⇒菜单残缺；V90 转发 `WM_CONTEXTMENU`+耗时判据⇒双菜单；V91 换「观测屏幕」判据⇒仍因转发前 `SetForegroundWindow(我们的窗)` 让 `CNewMenu` 找不到 view⇒**新建彻底建不出**（10-10 取证：十几次右键 0 文件）。V92：**空白右键穿透给 Explorer**（根画布 `pointerEvents` 仅拖拽时 `'auto'`），它那张菜单天然带查看/排序/刷新+ShellNew 新建（都不经过 `IContextMenu`，复刻不出来）；handoff 停用⇒不翻白；删转发 206 行。补偿：目录签名广播 `grid:desktop-changed` 让新文件进竖条。
- **V93/V94 新建链路**（用户 10-10 四次报障收敛）：① 判据 `LVM_GETEDITCONTROL`；② 动作改**回车确认**（V94，见 §2）；③ 前端「**改名/新建安静期**」（`relayoutSoon`/`syncDesktop` 挂起；重排与刷新分开记、重排优先补跑），`grid:desktop-changed` 走增量 `onDesktopChanged`（唯一新增项 → `setFocus()` + `beginItemRename`）。守卫 shell-menu 116、变异 18+65。
- ★★ **B 方案（用户 10-10 拍板）：重构为「不接管原生桌面」**，挂件保留为桌面浮窗。开源调研（LucidDesk/DeskBox/openFences/DesktopIconMover）**无一接管桌面**：不自绘，或用 `LVM_SETITEMPOSITION` 遥控原生图标（lParam 装坐标，**跨进程无需注入**）。后续：① 不隐藏 `SysListView32`，关「自动排列/对齐网格」后 SETITEMPOSITION 摆位；② 格子改装饰底板+标题栏、内容区穿透 ⇒ `GridOverlay.tsx` 大瘦身。
- ⚠️ agent 会话启动不了本 GUI ⇒ 打包 + 装机即止，**不代启动**。

## 5. 协作与操作约定
- 偏好：先规划后执行；表格化；绝对路径；改文件前先读取。红线：禁对真实用户目录写（测试限 TEMP 沙箱）。
- **批次收尾**：打包 → 停旧版 → **归还桌面图标** → 装机 → `cmp -l` 取证 → 停手不启动。`cmp -l` **装机之后**做：**0/3 字节**=生效；大量差异=旧构建。
- ★ **接管期间装机必须先归还桌面**（V45）：查 DB → 停进程 → **立刻** `desktop-icon-restore.py` → `desktop-icon-probe.py` 复核 → `desktop_icons_hidden='0'` → 装机。**不能先恢复再杀**。
  ★★ **只置 `desktop_icons_hidden`，别动另两键**（V79）：前者是**事实**，后两者是**偏好/上次显隐意图** —— 一律清零 = 悄悄替用户关掉接管 ⇒ 下次启动「格子 + 原生图标」两份内容。
- ★ `taskkill` 用**单斜杠** `/IM handy.exe /F` + `MSYS_NO_PATHCONV=1`（`//IM` 报无效参数而**进程照样活着**）。
- ★ 跑打包脚本前必须 `export PATH="/usr/bin:/bin:/mingw64/bin:$PATH"`：否则跑去调 `wsl.exe` ⇒ 被安全策略硬拦（前兆 `dirname: command not found`）。
- ★★ **NSIS `/S` 会被 SIGTERM 打断**（V90/V91，连单独跑两次也不生效）⇒ 兜底：无 `bundle.resources`（dist 已嵌 exe）⇒ `cp -f 构建exe 已装exe` **等价**，`cmp -l` 0 字节 = 生效。
- ★★ 被 `2>/dev/null` 包住的探针，不许用「空输出」当结论 ⇒ 一律 `tasklist | grep -qi handy`。
- 高频坑（详见 CONVENTIONS）：同文件多处 Edit **串行**；`npm.cmd` 被拦 → `node node_modules/<cli>/<entry>.js`；**打包中改源码 ⇒ 产物半新半旧，必须重打**。

## 6. 验证纪律
- agent 自报 “exit 0” 不可信 → 独立复跑、输出与 exit code 分文件落盘再 Read。
- 回归里算错的期望值比产品代码更危险 —— 逐条反问「失败场景下它会不会也成立」。
- 断言别打全文（会命中**注释** ⇒ 假通过）：打**调用点**或**行锚定**；「顺序」类断言用 `indexOf` 比位置。
- 已知预存问题（非回归）：`layout-audit` 0/84；`sample-smoke` 29/29。
- GUI 问题先用已知 good 旧产物对照；浮层不见 → 日志 + `window-probe.py`。
