# Handy · 顺手 — 项目长期记忆

> 续接必读：批次明细 → PROJECT_STATUS.md；详细约定/踩坑 → CONVENTIONS.md；逐日 → YYYY-MM-DD.md。
> **曾超限被注入截断而失效**（截断点 ~13.4KB）⇒ 只留跨会话最小集，**上限 ~12.5KB**；加内容前先删等量旧内容。

## 1. 标识与路径
- Handy · 顺手；identifier `com.handy.desktop`；`productName` 必须 `Handy`（禁中文/间隔号）。
- 栈 Tauri 2 + React 18 + TS + Vite + Tailwind + shadcn/ui + cmdk + Zustand；SQLite + tauri-plugin-store。窗口 6：main/note/settings/organizer/grid-overlay/workstation-bar。
- 根 `D:\_Projects\ops\handy`；参考 `D:\_Projects\ops\ops-tools`（只读）；权威文档 `docs/{01,02,03}-*`；桌面层定义 `docs/02-architecture/DESKTOP-LAYER.md`（六区 + `overlay_visible` 唯一真源）。
- 真实库 `%APPDATA%\com.handy.desktop\handy.db`（接管态看 `grid_meta` 三键）；日志/程序 `%LOCALAPPDATA%\Handy\`。
- 命令：Rust `source scripts/rust-env.sh && cd src-tauri`（⚠️ **没有** `src-tauri/scripts/`）；tsc `node node_modules/typescript/bin/tsc --noEmit`；打包 `bash scripts/build-release.sh --no-deploy`；回归 `scripts/regression/run.mjs`（21 套）；自检 `scripts/audit/`：`tool-audit`/`layout-audit`/`sample-smoke`/`guard-mutation-check.py`（**改守卫必跑**）+ 桌面图标三件套。
- 端到端布局测试用 `layout_all_boxes_with(loose_count)` 注入，**不依赖跑测试机器的桌面**；迁移链 v1→v11 由 `cargo test --lib` 守。

## 2. 硬不变量（改前必读）
- **格子 = 呈现层**（V37）：归类/拖入**不移动文件**；整理后**接管桌面呈现**（隐藏 `SysListView32`）。V48 起 Rust 无 `fs::rename`。
- **接管与归还**：`grid_overlay_hide` 只收内容 + 恢复原生图标（**不**隐藏挂件窗，否则无入口=死路）。启动 `restore_overlay_if_visible` 不弹主窗；退出恢复三处，**强杀不触发**。
- **Z 序锚定法**（V47）：`anchor=GetWindow(host,GW_HWNDPREV)` 后 `SetWindowPos(overlay,anchor)`（`SetWindowPos(hwnd,X)` = 放到 X **下面**）。V46「单步 `HWND_BOTTOM`」作废。
- **桌面层保险**：250ms 检测、判到就纠、退避上限 5s；`Off⇒原生图标可见`、`On⇒窗口可见`，纠正后复验。
- **「常驻」与「盒子」互斥**（V60）：退出整理后还在 ⇒ 必须浮窗，引擎当**禁区**（`workstation_rect` 右侧整列，宽 **400**，相交者横向让开）。
- **外部唤起 = 入队+唤醒，以队列为准**（V60）：冷启动 `setup` emit 必丢 ⇒ `PENDING_ACTION` 入队；前端挂载时 + 收到唤醒时各调一次 `grid_take_pending_action`，**不采信事件载荷**。
- **装进系统（HKCU）的能力必须有版本标记**（V60）：`Version` + `MENU_VERSION` 比对（版本号最后写）；`install()` **整键重建**（只写不删 ⇒ 死按钮）。
- **一个跨线程可变状态只许一个记账人**（V61）：曾两条写路 ⇒ 永久穿透 ⇒ 双击失效（指纹：**右键好使、左键不好使**）。
- **「撤掉强制可交互」≠「立刻穿透」**：`let want = interactive || cursor_hit(&win)`（**或**）。
- **内部拖拽 = 指针拖拽**（V59）：wry 对无 `CF_HDROP` 载荷不写 `*pdwEffect` ⇒ 自算落点（`DRAG_THRESHOLD=5px`）。**不许为修它关 `drag_drop_enabled`**（互斥）。
- **渲染几何 = 引擎几何**（V59/V70）：`height: box.height`、**不叠 `max-height`**；装不下交盒内滚动（`flex-1 min-h-0 overflow-y-auto`）。**两边常量差 1px 就会少一行/少一列**（见 §3）。
- **根画布 `fixed inset-0` 永远 `overflow-hidden`**（V59.1）：子元素撑大滚动溢出区 ⇒ 整层可滚；菜单必须 `fixed`。
- **拖动链路**（V57）：移动永远可用，锁只收编辑；三档 `unlockAllBoxes`/`lockAllBoxes`/`unlockBox(id)`（`setEditMode(true)` 是空操作）；`onUp` 判「真动过」才落库。
- **原生右键菜单是我们复刻的**（V58，细节 CONVENTIONS §31）：`CMF_NORMAL|CMF_EXPLORE`（**不传 `CMF_CANRENAME`**）；`IContextMenu2/3` 消息**必须转发**；Shift+右键让回系统、我们挂 Ctrl+右键。诊断 `menu_dump`。第三方扩展可能只认 `explorer.exe` 宿主（360压缩实证）。
- **层级阶梯**：盒子(auto) < 参考线 35 < 工作台 38 < 面板 40 < 菜单 50 < 拖拽预览 95；同 z 时 DOM 顺序说了算。
- ⚠️ 改「XX 模式」开关前先 grep 调用点（V52）；**UI 状态要落盘**；改 `place_widget_columns` 别丢 `cursor_right` 更新（V49）。
- **contentEditable 换行写进光标所在文本节点 + `\n` 后垫 ZWSP**（V67）：`insertNode(createTextNode('\n'))` 会让 Chrome 把「独立 `\n` 节点开头 / 以 `\n` 收尾的节点末尾」当**上一行行尾**（回车没用、两行粘一起）。
- ★★ **合成 `KeyboardEvent` 测不出回车**（V67）：不受信任按键不触发默认编辑动作 ⇒ 会**误报**「回车无效」。必须 `agent-browser press Enter`；`screenshot <path>` 会挂死。
- ⚠️ 「跳出/收尾」判据不许看「文本末尾是不是空行」（V67，库里读回的围栏以 `\n` 收尾）⇒ 看「上一步是不是我们插的那次换行」。
- ★★ **高亮重建会吞掉行的 ZWSP 锚**（V68，`applyHighlight` 每 400ms 重写 `codeEl.innerHTML`）：① 重建前 `zwspOffsets(text)` 记锚位；② `reapplyZwsp` **必须在 `restoreCaretIn` 之前**（赋 `nodeValue` 会把选区重置到节点开头 ⇒ 文本倒着写）；③ `restoreCaretIn` 只数**可见字符**。
- ★★ **压缩列高不许事后夹 `MIN_BOX_H`**（V68）：先缩放再夹最小高度会把总高再顶出可用区（真机差 14px ⇒ 越界 ⇒ 整层滚动条）⇒ **二分求最大可行缩放比**。
- ⚠️ 已作废：①「便签列放不下往左再开一列」；②「Fill=不重叠不越界就保留」；③「流式行铺收纳区」（V65，V66 列式已取代）。

## 3. 布局（用户口径 = 5 列）
**第1列 未归类竖条 → 第2/3列 归纳格子 → 第4列 便签 → 第5列 工作台**。挂件带/收纳区右界 = `workstation_rect().x - ARRANGE_GAP_X`。
- **V69：按内容定尺寸 + LPT 最短列填充**（`content_plan_in` ← `placement_order` + `pack_columns`）：尺寸只看自己条目数 ⇒ 面积与内容正比；常量 `CELL_EXTRA_W=32`、`BOX_CELL_EXTRA_H=36`（勿混竖条 `CELL_EXTRA_H=30`）、`BOX_HEADER_H=37`、`BOX_BORDER_H=2`、`GRID_SCROLLBAR_W=4`、`BOX_FIT_SLACK=2`、`MIN_BOX_W=160`、`MIN_BOX_H=120`、`AUTO_MAX_W=520`、`AUTO_MAX_COLS=5`。
  - ★ 摆放序 = `(面积, 内容量, 高, 宽)` 降序；**内容量分量不可省**（面积被分档吃掉差别 ⇒ 退化成登记顺序）。
  - ★ 每个格子放进**当前最矮的那一列**（并列取最左）=「大格子先占位、小格子找空隙插入」。
  - 列数 k（**V71 改**）：`k` 从大到小，**每个 k 内先试自然宽度、再试夹到 `zone_w/k`** ⇒ 能多铺一列就多铺一列、**尺寸去适配列宽**（旧写法把夹宽放在所有 k 失败之后 ⇒ 真机 3 格掉回 2 列、第 1 列空 501px = 用户说的「补丁」）。夹宽必须**同时按新宽重算高**；最后 `fit_column_heights` 二分压列高。
- ★ **幂等是算出来的，不许几何去兜**（V69）：摆放序是内容的纯函数 ⇒ 尺寸没变 ⇒ 落位一字不差。
- ★ **V70：格子内部几何两边逐像素相等**。根因：引擎 `BOX_HEADER_H=36` vs 前端 `h-9`+`border-b`=**37** ⇒ 每格矮 1px ⇒ 提前出滚动条 ⇒ 经典滚动条吃 4px ⇒ **少一列** ⇒ 行数变多 ⇒ 更溢出（正反馈）。修法：`BOX_HEADER_H=37`、`GRID_SCROLLBAR_W=4`、`BOX_FIT_SLACK=2`，CSS `.grid-scroll{scrollbar-gutter:stable}`。
- **V70**：高度上限跟 `zone_h`（删固定 `CONTENT_MAX_H=460`）⇒ 删完格子空出来盒子自动长高把图标全摆出来；**满了不许再建**：`probe_room_for_another_box` 在立刻回滚的 `SAVEPOINT` 里真插 + 真排看 `overflowed`，**出错一律当放行**，试探与真插入共用 `INSERT_BOX_SQL`。
- `manual` 只是信息性指标；`nearest_free_slot` 已删。
- **V50 不变量**：① 挂件一律由列规则安置；② 收纳格**不跨进挂件带**（`band_left` 取挂件列计划最小值）；③ 便签恒定一条列。
- **工作台**（V60/V62，宽 400）：日历 + 快捷入口 + 按钮（便签/格子/**整理**/显示·收起格子）；`WORKSTATION_W == WST_BOX_W == 400` 由 `test-desktop-constants.mjs` 锁。
- **动态整理**（V66）：前端 `relayoutSoon()`（120ms 防抖）→ `gridRelayout()`。

## 4. 批次索引（细节见 PROJECT_STATUS §1.x）
- **V42–44** 未归类竖条·镜像流布·Dock/搜索。**V45–47** 三面板合并·桌面右键菜单·Z 序锚定法。**V48–50** 挂件分列 + Full/Fill·删「移动到整理目录」·挂件带硬左界·`manual`+迁移 v10。**V56** 前后端度量锁。**V57** 修「格子拖不动」。**V58** 复刻原生右键菜单。**V59** 指针拖拽/几何一致/根画布 overflow。**V60** 工作台浮窗·右侧禁区·`PENDING_ACTION`·迁移 v11。**V61** 修双击失效。**V62** 工作台 320→400。**V63** 主窗口退场（桌面右侧面板=唯一外壳）。**V64/V65** 已作废。**V66** 列式填满 + 动态整理接线。
- **V67** 便签 markdown：换行写进光标节点 + ZWSP；收尾判据改「上一步是不是我们插的换行」；新增 `scripts/smoke-richmarkdown-enter.sh`。
- **V68** ZWSP 锚被高亮重建吞掉；回收挂件带下方空间（无挂件时收纳区右沿 = `right_edge`）；`overflowed` 与 `squeezed` 分家。
- **V69** 摆放序 `(面积,内容量,高,宽)` 降序 + LPT（CONVENTIONS §38）。
- **V70** ① 1px 几何账 + 滚动条槽位；② 高度上限跟 `zone_h`；③ 满了拒绝新建（SAVEPOINT 试探）。新用例 5 条（含**真机那一组**：文档 18/其他 8/文件夹 8 + 2 便签 ⇒ 一个图标都不藏）；守卫 +2 段，变异 33→41。
- **V71** 修「还是补补丁一样」：`pick_columns` 把「自然宽度放不下」误当「列数不可行」⇒ 真机 3 格只开 2 列。改成每个 k 内**先自然、后夹宽**（宽度是软约束，列数才是用户看得见的）。新用例 3 条；守卫 +⑭ 段，变异 41→43。还债：`DESKTOP-LAYER.md` 新增 §1.1、修掉过时的「镜像流布」。详见 CONVENTIONS §40。
- ⚠️ agent 会话启动不了本 GUI（挂死启动早期）⇒ 打包 + `/S` 静默装即止，**不代启动**。便签 markdown 调试入口 `?demo=richmarkdown`。

## 5. 协作与操作约定
- 偏好：先规划后执行；表格化；绝对路径；改文件前先读取；目录扁平。
- 红线：禁对真实用户目录（Desktop/Documents/Downloads）写（测试限 TEMP 沙箱）。
- **批次收尾**：功能完成 → 打包 → 停旧版 → **归还桌面图标** → NSIS `/S` 静默装 → `cmp -l` 取证（只应差 3 字节 `_VAR_UNK`→`_NSS`）→ 停手不启动。
- ★ **接管期间装机必须先归还桌面**（V45）：查 DB → 停进程 → **立刻** `desktop-icon-restore.py` → `desktop-icon-probe.py` 复核 `vis=True` → `desktop_icons_hidden='0'` → 装机。**不能先恢复再杀**（自愈会重新藏）；别用 PowerShell `Add-Type`（被拦），用 Python `ctypes`。
- ★ `taskkill` 在 Git Bash 要带 `MSYS_NO_PATHCONV=1`（写 `//IM` 会报无效参数而**进程照样活着**）。
- ★ **跑打包脚本前必须 `export PATH="/usr/bin:/bin:/mingw64/bin:$PATH"`**：否则跑去调 `wsl.exe` ⇒ 被安全策略硬拦（前兆 `dirname: command not found`）。别绕黑名单，改 PATH 才是正解。
- ★★ 被 `2>/dev/null` 包住的探针，不许用「空输出」当结论 ⇒ 一律 `tasklist | grep -qi handy`。
- 高频坑（完整版 CONVENTIONS）：同文件多处 Edit 串行；`npm.cmd` 被拦 → `node node_modules/<cli>/<entry>.js`；输出落盘再 Read；**打包开始后不许再改源码**；`vite build` 前先 `rmtree('dist')`；`Get-Process -Name handy` 假阴性，只用 `tasklist`。

## 6. 验证纪律
- agent 自报 “exit 0” 不可信 → 独立复跑、输出与 exit code 分文件落盘再 Read。
- 回归里算错的期望值比产品代码更危险 —— 逐条反问「失败场景下它会不会也成立」。
- 已知预存问题（非回归）：`layout-audit` 0/84；`sample-smoke` 29/29（V70 修掉两条**过期/自错**探针，见 CONVENTIONS §39.7）。
- GUI 问题先用已知 good 旧产物对照（分离「代码回归」与「环境坏了」）；浮层不见 → 应用日志 + `window-probe.py zlist`。
