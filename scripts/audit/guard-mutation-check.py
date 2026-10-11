#!/usr/bin/env python3
"""回归守卫的**自证非恒真**工具（V60 新增）。

# 为什么需要它

`scripts/regression/*.mjs` 里那批守卫全是**读源码 + 断言字符串**的。这类断言有一个
致命退化方式：正则写歪了、或者断言的字符串根本不在源码里 —— 它**永远 PASS**，
而人看到「74 PASS / 0 FAIL」只会以为一切正常。比没有这条守卫更糟：它给了虚假的安全感。

唯一的判别办法是**反向验证**：故意把源码改成「守卫本应该发现的样子」，看它是不是真的
变红。变红 → 这条断言有判别力；仍是绿 → 它就是个摆设。

# 用法

    python scripts/audit/guard-mutation-check.py [守卫文件…]

不带参数时跑下面 MUTATIONS 里登记的全部用例。每个用例：
  ① 备份目标文件；② 应用一处精确替换；③ 跑守卫；④ 断言**退出码非 0**；
  ⑤ 无论成败都还原（finally），最后再跑一次原样守卫确认回到全绿。

替换用**字面量精确匹配**（不做正则、不做模糊），替换不中就直接记 FAIL ——
「改了源码但守卫没变红」和「连替换都没生效」是两种不同的错误，不能混在一起。
"""
from __future__ import annotations

import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]

# 用例表：**按守卫文件分组**（一个用例只对某一个守卫有意义）。
# 键是相对项目根的守卫路径；值是 (用例名, 目标文件, 原文, 改成, 说明)。
_M = list[tuple[str, str, str, str, str]]
MUTATIONS: dict[str, _M] = {
    "scripts/regression/test-drag-pointer.mjs": [
        (
            "工作台被 contentHidden 门控",
            "src/modules/desktop-grid/GridOverlay.tsx",
            "      <DesktopWorkstation\n",
            "      {!contentHidden && (\n      <DesktopWorkstation\n",
            "退出整理时把工作台一起收走 = 用户再也没有入口打开整理",
        ),
        (
            "工作台不再收到 contentHidden（按钮文案永远不翻转）",
            "src/modules/desktop-grid/GridOverlay.tsx",
            "        hidden={contentHidden}\n",
            "        hidden={false}\n",
            "退出整理后工作台还显示「退出整理」",
        ),
        (
            "工作台宽度与 Rust 禁区宽度不一致",
            "src/modules/desktop-grid/DesktopWorkstation.tsx",
            "export const WORKSTATION_W = 400;",
            "export const WORKSTATION_W = 401;",
            "差 1 像素 = 格子压在工作台上，或右边白留一条缝",
        ),
        (
            "工作台内容区掉了 min-h-0",
            "src/modules/desktop-grid/DesktopWorkstation.tsx",
            '"flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-2 grid-scroll"',
            '"flex flex-1 flex-col gap-2.5 overflow-y-auto p-2 grid-scroll"',
            "flex 子项 min-height:auto 会把按钮条顶出屏幕",
        ),
        (
            "凭空多出一个不带 min-h-0 的滚动容器",
            "src/modules/desktop-grid/DesktopWorkstation.tsx",
            "      {collapsed ? null : (\n",
            '      <div className="flex-1 overflow-y-auto">占位</div>\n      {collapsed ? null : (\n',
            "白名单之外多一处漏掉 min-h-0 的滚动容器",
        ),
        (
            "Rust 发了一个前端没人接的动作",
            "src-tauri/src/lib.rs",
            'dispatch(app, "arrange");',
            'dispatch(app, "arrange-desktop");',
            "右键点「一键桌面整理」什么都没发生 = 假按钮",
        ),
        (
            "冷启动兜底：Rust 不再入队",
            "src-tauri/src/commands/grid.rs",
            "static PENDING_ACTION: Mutex<Option<String>> = Mutex::new(None);",
            "// 队列被删掉了",
            "冷启动时事件必丢，没有队列 = 用户点了右键菜单毫无反应",
        ),
        (
            "前端不再监听唤醒事件",
            "src/modules/desktop-grid/GridOverlay.tsx",
            "        unlisten = await getCurrentWindow().listen('handy://desktop-action', () => {",
            "        unlisten = await getCurrentWindow().listen('handy://no-such-action', () => {",
            "热路径（Handy 已在运行）点菜单后无反应",
        ),
        (
            "迁移 v11 没登记进 MIGRATIONS",
            "src-tauri/src/db/migrations.rs",
            "    (11, V11_GRID_DROP_CALENDAR),",
            "    // 忘了登记 v11",
            "老库升级后 grid_boxes 里还躺着 kind=calendar 的行",
        ),
        (
            "日历盒子的渲染分支复活",
            "src/modules/desktop-grid/GridOverlay.tsx",
            "            {box.kind === 'note' ? (",
            "            {box.kind === 'calendar' ? (null) : box.kind === 'note' ? (",
            "日历已并进工作台；这个盒子没有引擎几何，会压住别人",
        ),
        (
            "工作台底栏缺了「整理」按钮",
            "src/modules/desktop-grid/GridOverlay.tsx",
            "        onArrange={arrangeDesktop}\n",
            "",
            "用户点名要的操作按钮少一个",
        ),
        (
            "后台画布被改成可滚动容器（V59.1 那个 bug）",
            "src/modules/desktop-grid/GridOverlay.tsx",
            'className="fixed inset-0 select-none overflow-hidden"',
            'className="fixed inset-0 select-none overflow-y-auto grid-scroll"',
            "滚轮一动整个桌面跟着跑",
        ),
        # —— V61：双击失效（真 bug 的原文）+ 工作台观感 ——
        (
            "双击 bug 原样复活（无脑按参数设穿透）",
            "src-tauri/src/commands/grid.rs",
            "let want = interactive || cursor_hit(&win);",
            "let want = interactive;",
            "抬起鼠标那一刻窗口穿透 ⇒ 第二次点击落到下层桌面 ⇒ dblclick 永远凑不齐；"
            "用户 09-21：「双击打开我的电脑 打开某个文件夹现在都做不到了 双击没反应」",
        ),
        (
            "grid_set_interactive 改了窗口却不记账",
            "src-tauri/src/commands/grid.rs",
            "        POLLER_IGNORE.store(if want { 0 } else { 1 }, Ordering::SeqCst);\n",
            "",
            "命令路径改了窗口、轮询却以为没改 ⇒ 判「不用改」跳过 set ⇒ 窗口永久穿透（同一个 bug 的另一半）",
        ),
        (
            "force_ignore 不再让缓存失效",
            "src-tauri/src/commands/grid.rs",
            "    POLLER_IGNORE.store(IGNORE_UNKNOWN, Ordering::SeqCst);\n    apply_ignore(win, ignore);",
            "    apply_ignore(win, ignore);",
            "窗口重建 / 收起格子后沿用旧缓存 ⇒ 该穿透时不穿透、该可交互时不可交互",
        ),
        (
            "快捷入口改回 32px 图标磁贴",
            "src/modules/desktop-grid/GridOverlay.tsx",
            "flex h-3.5 w-3.5 shrink-0 items-center justify-center",
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
            "用户点名「不用那么大的图标占空间，本来空间就不够」",
        ),
        (
            "快捷入口改回 3 列方阵",
            "src/modules/desktop-grid/GridOverlay.tsx",
            '<div className="grid grid-cols-2 gap-1">',
            '<div className="grid grid-cols-3 gap-1">',
            "V61 起是两列胶囊（用户要的紧凑）；方阵正是「另一块面板贴上来」的观感来源",
        ),
        (
            "段头回到整条分隔线分段",
            "src/modules/desktop-grid/DesktopWorkstation.tsx",
            '<section aria-label="快捷入口">{children}</section>',
            '<section aria-label="快捷入口" className="border-t border-white/[0.06] pt-1.5">{children}</section>',
            "一条横线把卡片切成两块 —— 用户说的「一看就是拼接上去的」",
        ),
        (
            "工作台底栏按钮回到竖排块",
            "src/modules/desktop-grid/DesktopWorkstation.tsx",
            "        'group flex min-w-0 flex-1 items-center justify-center gap-1 rounded-lg px-1 py-1.5 transition',",
            "        'group flex min-w-0 flex-1 flex-col items-center gap-1 rounded-xl px-1 py-1.5 transition',",
            "竖排一格固定 44px、横排只要 26px —— 用户要的正是这段时间"
            "（V62 起这行 className 走 cn()，用例跟着被锁物一起更新）",
        ),
        (
            "我的快捷方式文件图标退回 22px",
            "src/modules/desktop-grid/GridOverlay.tsx",
            "<FileIcon path={link.value} size={14} />",
            "<FileIcon path={link.value} size={22} />",
            "把胶囊撑成大图标块",
        ),
        (
            "段头不再由工作台统一提供（两段各写各的）",
            "src/modules/desktop-grid/GridOverlay.tsx",
            "<WorkstationSectionLabel",
            '<div className="mb-1 text-[10px] opacity-60"',
            "两段的观感会各自漂移，又变成「几块板子」",
        ),
        (
            "日历外壳重新自带深色底 + 描边（工作台里套卡片）",
            "src/modules/desktop-grid/DesktopWidgets.tsx",
            "    shell: 'bg-black/[0.12] text-neutral-100',",
            "    shell: 'bg-neutral-950/72 text-neutral-100 ring-1 ring-white/10',",
            "「卡片里贴一张卡片」——用户说的「不够自然」有一半来自这里",
        ),
        # —— V62 立规 / V66 按用户口径改名：底栏「动作 vs 开关」的区分 + 日历随工作台自适应 ——
        (
            "模式开关也改叫「整理」（底栏又出现两颗含「整理」的按钮）",
            "src/modules/desktop-grid/DesktopWorkstation.tsx",
            "                label={hidden ? '显示格子' : '收起格子'}",
            "                label={hidden ? '显示整理' : '收起整理'}",
            "V66 口径：一次性动作 = 「整理」（唯一一颗），模式开关 = 「显示格子 / 收起格子」。"
            "两者都带「整理」⇒ 用户 09-21：「开启整理和整理两个让人懵逼 可以有一个更好的方式体现」",
        ),
        (
            "模式开关丢掉描边外观（与动作按钮同款）",
            "src/modules/desktop-grid/DesktopWorkstation.tsx",
            '                variant="toggle"\n',
            "",
            "开关与动作长得一样 ⇒ 用户分不清「再点一次会不会做同一件事」",
        ),
        (
            "日历网格又加回 288 限宽（把日期格锁回 41px）",
            "src/modules/desktop-grid/DesktopWidgets.tsx",
            '<div className="mx-auto w-full">',
            '<div className="mx-auto w-full max-w-[288px]">',
            "用户 09-21：「工作台太小了 日历等都不清晰」——限宽正是那个窄网格的来源",
        ),
        # —— V70：格子内部的「1px 几何账」+ 桌面满了不许再建 ——
        (
            "新建格子不再试探（桌面满了照建 ⇒ 又是一屏滚动条）",
            "src-tauri/src/commands/grid.rs",
            "if let Some(reason) = probe_room_for_another_box(",
            "if let Some(reason) = probe_room_for_another_box_disabled(",
            "用户 09-23：「如果放不下了就提醒用户…不能创建更多格子」——有函数没调用 = 假守卫",
        ),
        (
            "试探只插不回滚（每点一次「+ 格子」库里多一个幽灵格子）",
            "src-tauri/src/commands/grid.rs",
            '    let _ = conn.execute_batch(&format!("ROLLBACK TO {SP}; RELEASE {SP};"));',
            "    // 忘了回滚",
            "被拒的那条会真的留下来，下一次整理时冒出一个用户没建过的空格子",
        ),
        (
            "试探与真插入各走各的 SQL（量出来的不是真货）",
            "src-tauri/src/commands/grid.rs",
            "                        probe.execute(\n                            INSERT_BOX_SQL,",
            '                        probe.execute(\n                            "INSERT INTO grid_boxes (name) VALUES (?1)",',
            "两条语句字段不一致 ⇒ 试探说排得下、真插入却排不下",
        ),
        (
            "试探出错就拒绝（量尺子失败 ⇒ 用户永远建不出格子）",
            "src-tauri/src/commands/grid.rs",
            "        Err(_) => None,\n    }\n}",
            "        Err(e) => Some(e),\n    }\n}",
            "V70 立规：宁可放行，也不能因为「量」失败就把人挡在门外",
        ),
        (
            "提示条的时长不再随字数放宽（长理由读不完就没了）",
            "src/modules/desktop-grid/GridOverlay.tsx",
            "Math.min(9000, Math.max(HINT_DURATION_MS, message.length * 110))",
            "HINT_DURATION_MS",
            "V70 的拒绝理由带行动指引，固定 2.6 秒只够读半句",
        ),
        (
            "V71 真 bug 原样复活：夹宽又挪出列数循环（宽度一紧张就少开一列）",
            "src-tauri/src/commands/grid.rs",
            "        let (ch, cw) = capped_at(k);\n"
            "        if cw != natural_w {\n"
            "            trials.push((ch, cw, true));\n"
            "        }\n",
            "",
            "用户 09-23：「你看整体效果怎么还是补补丁一样的，三个图表最多的不应该 2 3 列上面开始"
            "平均放置」—— 真机 3 个格子（18 / 8 / 8 项）在 637 宽里会从 3 列掉回 2 列："
            "第一列空掉 501px、另外两个挤在第二列。Rust 用例 the_biggest_boxes_share_the_top_row"
            "_instead_of_piling_up 也钉了这条。",
        ),
        (
            "V71 真 bug 的另一种复活：夹宽排到自然之前（空间够也把格子挤窄）",
            "src-tauri/src/commands/grid.rs",
            "        let mut trials: Vec<(Vec<i64>, Vec<i64>, bool)> =\n"
            "            vec![(natural_h.to_vec(), natural_w.to_vec(), false)];\n"
            "        let (ch, cw) = capped_at(k);\n"
            "        if cw != natural_w {\n"
            "            trials.push((ch, cw, true));\n"
            "        }",
            "        let (ch, cw) = capped_at(k);\n"
            "        let mut trials: Vec<(Vec<i64>, Vec<i64>, bool)> = Vec::new();\n"
            "        if cw != natural_w {\n"
            "            trials.push((ch, cw, true));\n"
            "        }\n"
            "        trials.push((natural_h.to_vec(), natural_w.to_vec(), false));",
            "自然宽度明明放得下（372 + 24 + 232 = 628 ≤ 637），却先试夹宽 ⇒ 18 项的格子被压到 306 宽、"
            "每行少一个图标、行数变多（Rust 用例 a_roomy_zone_keeps_natural_box_widths 也钉了这条）",
        ),
        # —— V79：挂件显隐「谁写真源谁广播」（守卫 ⑮）——
        (
            "退出整理不再广播（格子收不起来）",
            "src-tauri/src/commands/grid.rs",
            "    let _ = write_overlay_visible(app, false);\n"
            "    // V79：**这里以前漏了广播** —— 桌面右键菜单「退出桌面整理」（`--hide-grid`）走的就是\n"
            "    // 这条路，没有前端的参与，于是库改了、界面不知道，桌面上的格子一直在。\n"
            "    emit_visibility(app, false);\n",
            "    let _ = write_overlay_visible(app, false);\n",
            "用户 09-25 原话「退出桌面整理也是格子一直都在桌面……整理没有退出」"
            "（handy.log 里连打四条 `收起挂件层`，界面纹丝不动）",
        ),
        (
            "广播又散回第二条路（托盘自己再发一份）",
            "src-tauri/src/tray.rs",
            "                        let _ = commands::grid::grid_overlay_hide(app2).await;\n",
            "                        let _ = commands::grid::grid_overlay_hide(app2.clone()).await;\n"
            '                        let _ = app2.emit_to(commands::grid::GRID_LABEL, "grid:visibility", false);\n',
            "两个记账人一回来，下一条「不由前端发起」的显隐路径就又会漏广播 —— "
            "这正是这次 bug 的成因",
        ),
        (
            "冷启动初值改回「摊开格子」（fail-open）",
            "src/modules/desktop-grid/GridOverlay.tsx",
            "const [contentHidden, setContentHidden] = useState(true);",
            "const [contentHidden, setContentHidden] = useState(false);",
            "挂件窗 show() 之后 React 立刻按初值画一屏格子，而 "
            "`grid_overlay_status()` 还没回来 ⇒ 用户「每次新打开 handy 后格子都摊在桌面上」",
        ),
        (
            "先按状态定态、后注册监听（在途广播会丢）",
            "src/modules/desktop-grid/GridOverlay.tsx",
            "        unlisten = await getCurrentWindow().listen('grid:visibility', (event) => {\n",
            "        void ipc.gridOverlayStatus();\n"
            "        unlisten = await getCurrentWindow().listen('grid:visibility', (event) => {\n",
            "顺序是这条不变量的一半：状态在监听存在之前就被定下来 ⇒ 查询在途时后端广播的"
            "那一次必然丢掉，界面自此停在初值、与后端长期不一致",
        ),
        # —— ⑯ 日历：年份可直接指定 + 纪念日可增删（V80）——
        (
            "年份输入框失焦不生效（只能一月一月点回去）",
            "src/modules/desktop-grid/DesktopWidgets.tsx",
            "              onBlur={applyYearDraft}",
            "              onBlur={() => undefined}",
            "用户输入 1988 却跳不过去 ⇒ 回到 1988 年又要点 456 次箭头",
        ),
        (
            "跳转不夹农历年表范围（跳到 1899 农历整列空白）",
            "src/modules/desktop-grid/DesktopWidgets.tsx",
            "    const y = Math.min(LUNAR_MAX_YEAR, Math.max(LUNAR_MIN_YEAR, Math.round(year)));",
            "    const y = Math.round(year);",
            "LUNAR_INFO[year - 1900] 越界取到 undefined：不报错、不崩溃，"
            "只是农历那一行整片空白 —— 最难查的那类坏法",
        ),
        (
            "跳转不带走选中日（计划区还指着出发那个月）",
            "src/modules/desktop-grid/DesktopWidgets.tsx",
            "    setSelected(defaultSelectedOf(y, month));\n",
            "",
            "翻到 1988 年 6 月、下面却还是 2026 年的计划与输入框 ⇒ "
            "用户以为在给 1988 年加生日，实际加到了今天",
        ),
        (
            "纪念日删除不写盘（列表看着删了，重启又回来）",
            "src/modules/desktop-grid/DesktopWidgets.tsx",
            "      void patchSettings({ anniversaries: next }).catch(() => undefined);",
            "      void Promise.resolve().catch(() => undefined);",
            "只改本地 state 不落盘 ⇒ 关掉应用再开，删掉的生日又回来了",
        ),
        (
            "面板展开不进高度上报的依赖（计划区被顶出盒子）",
            "src/modules/desktop-grid/DesktopWidgets.tsx",
            "    showPicker,\n    showAnniversaries,\n",
            "    showAnniversaries,\n",
            "盒高按旧值算 ⇒ 点开纪念日面板后下面的计划清单被裁掉，"
            "看着像「日历自己少了一截」",
        ),
        # —— ⑰ 系统菜单期间「把桌面暂时还给系统」（V81）——
        # ★ Step 4 换锚点：`reassert_takeover` 已整体空转（连「藏」这个动作都不存在了），
        # 旧锚点 `if handoff_active() { return; }` 随「借出期间让路」一起消失。
        # 那条断言现在的守护对象只有一个：**「函数体里没有 desktop_icons_apply」**。
        (
            "接管自愈又在巡视时去藏一次（每 3 秒按一次用户的原生图标）",
            "src-tauri/src/commands/grid.rs",
            "    let _ = app;\n    TAKEOVER_FIXES.store(0, Ordering::Relaxed);\n}",
            "    let _ = desktop_icons_apply(true);\n    TAKEOVER_FIXES.store(0, Ordering::Relaxed);\n}",
            "它由 25ms 轮询驱动 ⇒ 每 3 秒把用户的原生图标按回去：Explorer 每次重画都被我们"
            "盖掉，表现为「桌面图标一闪一闪、Win+D 之后图标再也不出现」"
            "（同一处源码在 test-icon-control 组也有一份用例 —— 两边证明的是**各自那条**"
            "断言的判别力，不是重复登记）",
        ),
        (
            "挂件窗不可见的自愈不跳过借出期（这层在菜单上头糊回来）",
            "src-tauri/src/commands/grid.rs",
            "                    if handoff_active() {\n                        continue;\n                    }\n                    hidden_ticks += 1;",
            "                    hidden_ticks += 1;",
            "被当成「被外部隐藏」自愈 show 回来 ⇒ 半透明格子重新压在原生桌面上，"
            "刚还回去的桌面又被盖住",
        ),
        (
            "收回前不复核接管态（点「退出桌面整理」后图标又被藏）",
            "src-tauri/src/platform/desktop_handoff.rs",
            "                if icons_taken() {\n                    let _ = ShowWindow(list, SW_HIDE);\n                }",
            "                let _ = ShowWindow(list, SW_HIDE);",
            "菜单里就有我们注入的「退出桌面整理」：用户点了它，图标刚还回来又被藏走 ⇒ "
            "表现为「点了没反应」，正是用户最不能忍的那类坏法",
        ),
        (
            "菜单收起不等「安静宽限」立刻收回（V84 宽限被拆掉）",
            "src-tauri/src/platform/desktop_handoff.rs",
            "            let since = quiet_since.get_or_insert_with(Instant::now);\n            if saw_edit || since.elapsed() >= HANDOFF_QUIET_GRACE {\n                break;\n            }",
            "            break;",
            "V84：原生「新建」是菜单关闭**之后**才建目录、再进改名的，编辑框从创建到出现有几百毫秒\n"
            "延迟；没有 1.5s 安静宽限（或「见过编辑框」的快路径），收回线程 200ms 一查就当结束，\n"
            "编辑框被一起藏回暗处 —— 用户看到的就是「点了新建没反应」（09-29 三次反馈）",
        ),
        (
            "前端不再跟着重扫（新建的文件迟迟不露面）",
            "src/modules/desktop-grid/GridOverlay.tsx",
            "unlisten = await getCurrentWindow().listen('grid:desktop-changed', () => {",
            "unlisten = await getCurrentWindow().listen('grid:nothing-here', () => {",
            "文件真的建好了、用户却只在未归类竖条里看不到它 ⇒ 结论必然是「新建没生效」",
        ),
        # —— ⑱ 借出机制在真机上一次都没触发过（V82）——
        (
            "菜单窗不换 owner 再认（回到 V81 那条认不出来的判据）",
            "src-tauri/src/platform/desktop_handoff.rs",
            "        let owner = GetWindow(hwnd, GW_OWNER).unwrap_or_default();",
            "        let owner = hwnd;",
            "EVENT_SYSTEM_MENUPOPUPSTART 的 hwnd 实测就是菜单窗 #32768 自己："
            "不换 owner，它的顶层与类名都认不出来 ⇒ 每次桌面右键静默判掉，"
            "日志里只有「旁听已启动」、一条借出都没有（V81 真机就是这个后果）",
        ),
        (
            "认桌面菜单时不再看前台窗口（挂件窗在前台时认不出来）",
            "src-tauri/src/platform/desktop_handoff.rs",
            "    let fg = GetForegroundWindow();",
            "    let fg = HWND(std::ptr::null_mut());",
            "用户在 Handy 挂件窗上点过之后前台就不是桌面了，少了这条兜底，"
            "桌面菜单照样认不出来",
        ),
        (
            "轮询兜底函数被改名（没了「直接问 #32768 在不在」这条路）",
            "src-tauri/src/platform/desktop_handoff.rs",
            "pub fn poll_menu() {",
            "pub fn poll_menu_disabled() {",
            "只信事件 ⇒ 事件语义一变整套借还就静默失效，正是 V81 在真机上发生的事",
        ),
        (
            "保险循环不再调用轮询兜底",
            "src-tauri/src/commands/grid.rs",
            "                crate::platform::desktop_handoff::poll_menu();",
            "                let _ = 0;",
            "兜底函数写了却没人调用 ⇒ 等于没写，机制又只剩那条认不出来的事件路",
        ),
        (
            "收回线程失去去重闸门（每 25ms spawn 一个）",
            "src-tauri/src/platform/desktop_handoff.rs",
            "    if TAKEBACK_PENDING.swap(true, Ordering::SeqCst) {",
            "    if false {",
            "菜单收起后几百个线程同时抢着收回桌面 ⇒ 反复 show/hide，桌面狂闪",
        ),
        # ⚠️ 2026-10-11 删除一条用例：「系统入口的右键又被排除在原生菜单之外（回到复刻菜单）」。
        #
        # 它的锚点（竖条条目菜单里的 `if (!event.ctrlKey) { setMenuLoose(null); … }`）随
        # Step 5「竖条退场」一起消失，连同 `entry` 这个标识符。而**没有 `entry`，退化就写不出来**：
        # 要触发 `test-drag-pointer.mjs` 那条 `!/!entry\.isSystem/` ，只能人为往源码里塞一个
        # 已不存在的标识符 —— 那种「变异」不反映任何真实退化，只会证明工具自己能塞串。
        #
        # 该断言保留为**结构反悔网**（零成本，专防有人把老代码整段抄回来），
        # 在此登记为「已知无变异证据」，不计入本组用例数。
        (
            "认桌面菜单时不再看「菜单压在谁身上」",
            "src-tauri/src/platform/desktop_handoff.rs",
            "        if let Some(under) = window_under_menu(hwnd) {",
            "        if let Some(under) = None::<HWND> {",
            "只靠前台窗口判 ⇒ 用户刚点过浏览器 / IDE 再回来右键桌面时前台还是那个应用，"
            "桌面菜单认不出来，那一下右键又白费",
        ),
        (
            "V86 编辑框借出被拆（Win11 上新建又藏回隐藏视图）",
            "src-tauri/src/platform/desktop_handoff.rs",
            "    if !HANDOFF.load(Ordering::SeqCst) && label_editing() {",
            "    if !HANDOFF.load(Ordering::SeqCst) {",
            "Win11 25H2 没恢复经典菜单 ⇒ 桌面背景右键是新式菜单宿主窗口，不是 #32768，"
            "轮询永远认不出菜单；唯一绕不过去的观测量就是「新建后弹出的原位改名编辑框」。"
            "删掉 ⇒ 新建回到「没反应 / 特别慢 / 要手动刷新」（09-30 三次反馈）",
        ),
        (
            "前端又把窗口几何写回数据库（V83 的根因复活）",
            "src/lib/ipc.ts",
            "  gridSetInteractive: (interactive: boolean): Promise<void> =>",
            "  gridGeometrySet: (interactive: boolean): Promise<void> =>",
            "写回去 ⇒ 换显示器 / 改缩放那次用的是**过期的** scaleFactor 换算，"
            "错值自此永久生效 —— 用户 09-28 的双屏截图就是这么来的",
        ),
        (
            "后端又从 DB 读窗口几何（脏记录一躺下它就永远错）",
            "src-tauri/src/commands/grid.rs",
            "fn drop_legacy_geometry(app: &AppHandle) {",
            "fn read_geometry(app: &AppHandle) -> Result<(), String> {",
            "开窗一旦能读到库里的旧尺寸，换显示器后就再也回不到「按主屏实时算」这条路",
        ),
        (
            "历史脏键不再被清理（META_KEY_GEOMETRY 从此长驻）",
            "src-tauri/src/commands/grid.rs",
            '            "DELETE FROM grid_meta WHERE key = ?1",\n'
            "            params![META_KEY_GEOMETRY],\n"
            "        );\n"
            "    }\n"
            "}",
            '            "SELECT 1 WHERE key = ?1",\n'
            "            params![META_KEY_GEOMETRY],\n"
            "        );\n"
            "    }\n"
            "}",
            "不清理 ⇒ 那条 1138×608 会一直躺在库里，后人一看还以为它有用",
        ),
        (
            "对齐窗口改用逻辑像素（丢掉物理像素这条唯一稳的路）",
            "src-tauri/src/commands/grid.rs",
            "        let _ = win.set_position(PhysicalPosition::new(x, y));",
            "        let _ = win.set_position(tauri::LogicalPosition::new(x as f64, y as f64));",
            "逻辑像素要按「窗口所在屏的缩放」换算，而窗口正是要被摆到那块屏上的 ——"
            "拿它的 DPI 算它自己的位置是循环论证，跨屏 / 改缩放时必然错位",
        ),
        (
            "对齐判定去掉容差、改回严格相等（瞬时死循环）",
            "src-tauri/src/commands/grid.rs",
            "    let off_pos = (cx - tx).abs() > BOUNDS_TOLERANCE || (cy - ty).abs() > BOUNDS_TOLERANCE;",
            "    let off_pos = (cx - tx).abs() != 0 || (cy - ty).abs() != 0;",
            "非整数缩放下两个 API 来回换算差 1–2px ⇒ 每秒「纠正」一次却永远纠不动："
            "窗口每秒闪一下、前端每秒重排一次（cargo test 的 "
            "`window_bounds_tolerance_swallows_rounding_noise` 也会同时变红）",
        ),
        (
            "复用窗口时不再先对齐（每次启动都走的那条路）",
            "src-tauri/src/commands/grid.rs",
            "        sync_overlay_bounds(app);\n        let _ = existing.show();",
            "        let _ = existing.show();",
            "窗口可能是在另一套显示器配置下建的 ⇒ 不重新对齐就一直是错的尺寸，"
            "而且只靠「新建窗口」那条路永远救不回来（窗口是复用的）",
        ),
        (
            "新建窗口在 show() 之后才对齐（用户会看到跳动）",
            "src-tauri/src/commands/grid.rs",
            "    sync_overlay_bounds(app);\n"
            "    // 先 show 再归位：顺序理由同上（`show()` 会把窗口顶到 Z 序顶层）\n"
            "    let _ = win.show();",
            "    let _ = win.show();\n"
            "    sync_overlay_bounds(app);",
            "先显示再改尺寸 ⇒ 用户看到窗口「先在错位置出现、再跳一下」",
        ),
        (
            "保险循环不再复核显示器配置（插上外接屏永远不会重新对齐）",
            "src-tauri/src/commands/grid.rs",
            "                if bounds_ticks % BOUNDS_CHECK_TICKS == 0 && sync_overlay_bounds(&app) {",
            "                if false {",
            "开窗只对齐那一次，而窗口是常驻的 —— 用户插上外接屏时没有任何人会再叫它一次，"
            "他也不会为此去点「整理」",
        ),
        (
            "几何变了不通知前端重排（窗口对了、格子还按旧尺寸摆着）",
            "src-tauri/src/commands/grid.rs",
            "                    let _ = app.emit_to(GRID_LABEL, EVENT_BOUNDS_CHANGED, ());",
            "                    let _ = 0;",
            "少一环 ⇒ 用户得自己去点一次「整理」才看得到新布局",
        ),
        (
            "布局尺寸改回「窗口优先」（接屏那一瞬间会抖一下）",
            "src-tauri/src/commands/grid.rs",
            "fn layout_work_size(app: &AppHandle) -> (i64, i64) {\n"
            "    // V83：**先问主显示器工作区**（真源），再退回窗口尺寸 —— 理由见函数头。\n"
            "    if let Ok(Some(monitor)) = app.primary_monitor() {",
            "fn layout_work_size(app: &AppHandle) -> (i64, i64) {\n"
            "    if let Some(_win) = app.get_webview_window(GRID_LABEL) {\n"
            "        return (1536, 864);\n"
            "    }\n"
            "    if let Ok(Some(monitor)) = app.primary_monitor() {",
            "窗口尺寸在「接上第二块屏」那一刻还是旧的 ⇒ 先按旧尺寸排一次、纠正后再排一次，"
            "用户看到格子抖一下",
        ),
        (
            "前端又开始自己取 scaleFactor 监听窗口几何",
            "src/modules/desktop-grid/GridOverlay.tsx",
            "  const relayoutTimer = useRef<number | null>(null);",
            "  const relayoutTimer = useRef<number | null>(null);\n"
            "  const geoProbe = (w: unknown): void => {\n"
            "    void (w as { onMoved: (f: () => void) => void }).onMoved(() => undefined);\n"
            "  };",
            "挂载时取一次的 scaleFactor 会过期 —— 那正是 V83 事故里的换算环节，"
            "只要它回来，「错值写库」就只是时间问题",
        ),
    ],
    "scripts/regression/test-desktop-constants.mjs": [
        (
            "工作台压到了面板之上（V60 真抓到的那个 bug 的另一种写法）",
            "src/modules/desktop-grid/DesktopWorkstation.tsx",
            "        'z-[38]',",
            "        'z-[45]',",
            "工作台浮在面板之上 → 铺满档面板右侧（滚动条 / 关闭按钮）点不动；"
            "这里刻意保留 `z-[N]` 形态，好让『面板 z > 工作台 z』这条**语义**断言自己变红，"
            "而不是被解析守卫提前拦下",
        ),
        (
            "工作台与面板同为 z-40（改写形态破坏了抽取 → 解析守卫也要响）",
            "src/modules/desktop-grid/DesktopWorkstation.tsx",
            "        'z-[38]',",
            "        'z-40',",
            "同 z 时 DOM 顺序让工作台抢到上层 —— 同时验证「解析为空即 FAIL」这条守卫还在",
        ),
        (
            "工作台宽度与 Rust 禁区宽度不一致",
            "src/modules/desktop-grid/DesktopWorkstation.tsx",
            "export const WORKSTATION_W = 400;",
            "export const WORKSTATION_W = 300;",
            "前端画的与引擎留的不是同一个矩形",
        ),
        (
            "工作台上边距没跟 Rust ARRANGE_MARGIN 对上",
            "src/modules/desktop-grid/DesktopWorkstation.tsx",
            "'fixed bottom-8 right-8 top-8 flex flex-col overflow-hidden rounded-2xl text-neutral-100',",
            "'fixed bottom-8 right-8 top-4 flex flex-col overflow-hidden rounded-2xl text-neutral-100',",
            "禁区矩形高度与浮窗高度对不上",
        ),
        (
            "工作台又长出高度上限",
            "src/modules/desktop-grid/DesktopWorkstation.tsx",
            "      style={{ pointerEvents: 'auto', background, width: WORKSTATION_W }}",
            "      style={{ pointerEvents: 'auto', background, width: WORKSTATION_W, maxHeight: 640 }}",
            "工作台是「整列」，有上限就会与右侧禁区对不上",
        ),
        (
            "面板不再让开工作台",
            "src/modules/desktop-grid/DesktopSidePanel.tsx",
            "`${box} right-[448px] w-[min(50vw,calc(100vw-460px))]`",
            "`${box} right-[120px] w-[min(50vw,calc(100vw-460px))]`",
            "半屏档面板压在工作台那一列上",
        ),
        # —— V70：格子内部的「1px 几何账」+ 滚动条槽位 ——
        (
            "V70 真 bug 原样复活：Rust 标题栏高度退回 36（漏算那 1px 边框）",
            "src-tauri/src/commands/grid.rs",
            "const BOX_HEADER_H: i64 = 37;",
            "const BOX_HEADER_H: i64 = 36;",
            "每个格子矮 1px ⇒ 条目区少一行 ⇒ 提前出滚动条 ⇒ 滚动条再吃掉 4px ⇒ 又少一列"
            "（真机 09-23：18 项的「文档」引擎按 5×4 算，前端画出 4×4，藏掉 2 个图标）",
        ),
        (
            "滚动条槽位不再恒留（`scrollbar-gutter` 被删）",
            "src/index.css",
            ".grid-scroll { scrollbar-gutter: stable; }",
            ".grid-scroll { }",
            "滚动条只在滚得动时占位 ⇒ 引擎算出来刚好排得下的格子，前端一渲染就少 4px ⇒ "
            "少一列 ⇒ 行数变多 ⇒ 反而真的滚起来（V70 的正反馈）",
        ),
        (
            "滚动条宽度与 Rust 记账用的数对不上",
            "src/index.css",
            ".grid-scroll::-webkit-scrollbar { width: 4px; height: 4px; }",
            ".grid-scroll::-webkit-scrollbar { width: 8px; height: 8px; }",
            "CSS 8px、Rust 按 4px 记账 ⇒ 每个格子实际能排的列数比引擎以为的少",
        ),
        (
            "Rust 不再把滚动条算进格子宽度（槽位白留 4px）",
            "src-tauri/src/commands/grid.rs",
            "const GRID_SCROLLBAR_W: i64 = 4;",
            "const GRID_SCROLLBAR_W: i64 = 0;",
            "每个格子白窄 4px，图标被藏进格子内部的滚动条里",
        ),
        (
            "Rust 把工作台宽度改回 320（用户诉求被回退）",
            "src-tauri/src/commands/grid.rs",
            "const WST_BOX_W: i64 = 400;",
            "const WST_BOX_W: i64 = 320;",
            "用户 09-21：「工作台太小了…最重要的工作台反而太小」——320 会让日历退回窄网格；"
            "同时前端 400 与引擎 320 也对不上（同一条用例把「宽度 ≥ 400」与「前后端一致」都验了）",
        ),
    ],

    # V87 新增：原生右键 / 背景菜单 / 改名 这一组归 test-shell-menu.mjs 管。
    # ⚠️ 分组别填错 —— MUTATIONS 是「守卫脚本 → 用例」的字典，填到别的组里会被拿去跑
    # 另一套守卫，结果是「改了源码守卫仍然全绿」的假通过（自检会直接点名它没判别力）。
    "scripts/regression/test-shell-menu.mjs": [
        (
            "V99 枚举数据源退回纯注册表全量扫（与原生「新建」列表对不上）",
            "src-tauri/src/platform/shell_menu.rs",
            "    let mut exts = read_discardable_shell_new_classes();",
            "    let mut exts: Vec<String> = Vec::new();",
            "用户 10-10 对照原生截图报「新建列表缺一半、还混进 CONTACT/库」。原生菜单的"
            "真实数据源是 Explorer 自己维护的 Discardable\\ShellNew\\Classes 缓存清单，"
            "纯注册表全量枚举会混入原生不显示的项、也配不上原生的过滤规则",
        ),
        (
            "V99 Win11 内置「文本文档/BMP 图像」被丢（原生有、注册表已无 ShellNew）",
            "src-tauri/src/platform/shell_menu.rs",
            '    for builtin in [".bmp", ".txt"] {',
            "    for builtin in [\".nomatch\"] {",
            "本机注册表 .txt/.bmp 的 ShellNew 已被清掉但原生菜单照样显示这两项（Win11 "
            "内置、建空文件）。丢了它们 = 菜单永远比原生少两行",
        ),
        (
            "V99 排序方式不做真（点了没反应，又成摆设项）",
            "src-tauri/src/commands/grid.rs",
            "    apply_loose_sort(&mut out, &sort);",
            "    let _ = &sort;",
            "用户 10-10 要求菜单跟原生一样，「排序方式」必须真排未归类竖条并持久化，"
            "否则就是 V97 明确砍掉的「点了没反应的摆设项」",
        ),
        (
            "V98 ShellNew 模板落地被绕开（新建子菜单只剩文件夹，Excel 等全消失）",
            "src-tauri/src/commands/grid.rs",
            "crate::platform::shell_menu::create_new_from_shell_new(&kind)",
            "None",
            "用户 10-10：「我各种新文件 excel 等各种都没有了哇」。desktop_create_new 必须把"
            "扩展名 kind 交给 create_new_from_shell_new 按注册表 ShellNew 模板落地",
        ),
        (
            "V97 空白右键退回经典菜单直弹（自绘 bgMenu 被拆掉）",
            "src/modules/desktop-grid/GridOverlay.tsx",
            "        setBgMenu({ x: event.clientX, y: event.clientY });",
            "        openDesktopBackgroundMenu(false);",
            "用户 10-10：「右键菜单跟原始的不一样」。普通空白右键必须弹**前端自绘的 "
            "Win11 同款菜单**（setBgMenu），退回直接弹经典菜单 = 自绘外壳白做",
        ),
        (
            "V87 背景菜单改用 BindToObject 取（拿不到「新建」/ 实测 E_INVALIDARG）",
            "src-tauri/src/platform/shell_menu.rs",
            "            .CreateViewObject(None)",
            "            .BindToObject(std::ptr::null())",
            "「新建」只有 CreateViewObject 给得出：BHID_SFUIObject/BindToObject 那类拿到的是"
            "**条目**菜单（实测 36 项里没有「新建」）；而 FOLDERID_Desktop 的 PIDL 就是根本身，"
            "走 BindToObject 必然 E_INVALIDARG —— 桌面空白右键直接什么也不弹",
        ),
        (
            "V87 改名不再拒绝路径分隔符（改名变成搬文件，回到 V36 老路）",
            "src-tauri/src/commands/grid.rs",
            '    if let Some(bad) = ILLEGAL.iter().find(|c| trimmed.contains(**c)) {\n'
            '        return Err(format!("名字里不能包含「{bad}」"));\n'
            "    }",
            "    let _ = ILLEGAL;",
            "「改名」与「搬文件」只隔一个反斜杠：放行它就会把条目挪到别的目录，"
            "正是 V37 起刻意废掉的 V36 行为",
        ),
        (
            "V87 改名后不同步 grid_items.file_path（幽灵条目）",
            "src-tauri/src/commands/grid.rs",
            "UPDATE grid_items SET file_path = ?1, display_name = ?2 WHERE file_path = ?3",
            "UPDATE grid_items SET display_name = ?2 WHERE file_path = ?3",
            "磁盘上叫新名字、格子里还按旧路径找 ⇒ 下一次刷新前用户看到的是旧名字，"
            "刷新后条目直接消失（登记与磁盘对不上）",
        ),
        # —— V88/V89：亲手把「新建」做成「一定成的那一个」 ——
        # 用户 10-08 两条报障：
        #   ①「第一次新建文件夹报错 / 每次都要卡 / 桌面整体刷新」—— 背景菜单的「新建」
        #      是 Shell 的 CNewMenu，需要 IShellView 才能落地，我们对无真实 view 的
        #      view-object 菜单执行它 → E_FAIL（V88 起自己注入）。
        #   ②「新建文件夹 文本文档都失效」—— V88 只「注入」没「摘除」，菜单顶上于是
        #      两个同名「新建(&W)」并存，用户点中原生那个就必报错（V89 先摘后插）。
        #   ③「新建完桌面翻白成原生样式」—— 借出桌面（V89 整体停用）。
        # 下面三条分别守住「摘除」「真的建」「前端读返回值」不被改回。
        (
            "V89 不摘原生「新建」（两个同名项并存，用户点中原生那个就 E_FAIL）",
            "src-tauri/src/platform/shell_menu.rs",
            "            strip_native_new_menu(hmenu);",
            "            // strip_native_new_menu(hmenu);",
            "原生 CNewMenu 在无 view 的菜单里必然 E_FAIL(0x80004005)；不摘掉 ⇒ 菜单顶上"
            "两个同名「新建(&W)」，用户随手一点就有一半概率吃到报错 —— 正是 10-08 报的"
            "「新建文件夹 / 文本文档都失效」",
        ),
        (
            "V89/V100 命中新建命令却不 return 结果（建了也不告诉前端）",
            "src-tauri/src/platform/shell_menu.rs",
            'if (cmd as u32) == CMD_NEW_FOLDER {\n            return Ok(match create_new_item("folder") {',
            'if (cmd as u32) == CMD_NEW_FOLDER {\n            let _ = create_new_item("folder");\n            return Ok(match create_new_item("folder") {',
            "分支还在、但建完把结果当无事发生（let _ 吞掉）⇒ 前端拿到 null 走全量 refresh 对账，"
            "新增项不进原地改名，「卡 + 整体刷新」复现（用户 10-08）",
        ),
        (
            "V100 经典菜单顶部「查看/排序方式/刷新」注入被拆掉（显示更多选项又缺顶组）",
            "src-tauri/src/platform/shell_menu.rs",
            'PWSTR(w!("查看(&V)").as_ptr() as *mut u16),',
            'PWSTR(w!("查看").as_ptr() as *mut u16),',
            "用户 10-10 对照原生截图：显示更多选项必须有 查看/排序方式/刷新 顶组 —— "
            "这三项是 DefView 视图层的，CreateViewObject 拿不到，丢了就没人能补",
        ),
        (
            "V89 前端不读命令返回值（又退回去靠对账认领）",
            "src/modules/desktop-grid/GridOverlay.tsx",
            "        created = await ipc.shellDesktopBackgroundMenu(extended);",
            "        created = null;\n        await ipc.shellDesktopBackgroundMenu(extended);",
            "不读返回值 ⇒ 复刻菜单回退路径拿不到 CreatedItem，新建项只能靠 diff 认领、"
            "且拿不到 name 无法精准进改名",
        ),
        # —— V92：不代理、不转发 —— 桌面空白右键**穿透**给 Explorer ——
        #
        # 「转发」这条路走死了：V90 拿 SendMessage 耗时当判据 ⇒ 每次误判「没弹出」⇒
        # 同屏两个菜单；V91 换「观测屏幕」判据 ⇒ 又因为转发前 SetForegroundWindow(我们
        # 的窗口)，Shell 的 CNewMenu 找不到目标 IShellView ⇒ 新建彻底建不出东西
        # （用户 10-10 00:12 原话，取证确认那一轮十几次右键一个文件都没建出来）。
        # 现在空白一律穿透，下面几条守住「穿透」与它的补偿措施不被改回。
        (
            "根画布回到有条件穿透（空白右键又落到我们窗口上）",
            "src/modules/desktop-grid/GridOverlay.tsx",
            "        pointerEvents: 'none',\n      }}\n      onContextMenu={(event) => {",
            "        pointerEvents: contentHidden ? 'none' : 'auto',\n      }}\n      onContextMenu={(event) => {",
            "Step 4 之前这里是「按模式切换」，现在模式是常量、根画布**恒定**穿透。改回带条件的"
            "形态，空白处的事件就重新落到我们窗口上：Explorer 那张原生右键菜单"
            "（查看 / 排序方式 / 刷新 / 新建）永远弹不出来。"
            "（test-icon-control 组也有一份同源用例，两边各自证明判别力）",
        ),
        (
            "又上报「整窗」命中区（Rust 命中轮询把整窗切回可交互 ⇒ 原生右键弹不出来）",
            "src/modules/desktop-grid/GridOverlay.tsx",
            "    void ipc.gridOverlayUpdateRegions(regions).catch(() => undefined);",
            "    regions.push({ x: 0, y: 0, width: window.innerWidth * scaleFactor, height: 1 });\n"
            "    void ipc.gridOverlayUpdateRegions(regions).catch(() => undefined);",
            "「根画布 pointerEvents:none」只解决窗口**内部**的转发；真正决定「这个点归谁」的"
            "是 Rust 那条 25ms 轮询。整窗命中区一报，桌面空白处就仍是我们的窗口吃点击 —— "
            "原生右键菜单弹不出来、框选也选不动。"
            "（test-icon-control 组也有一份同源用例，两边各自证明判别力）",
        ),
        (
            "V92 命令不等菜单收起（去掉 mpsc 的 recv）",
            "src-tauri/src/commands/grid.rs",
            "        let outcome = rx\n            .recv()",
            "        let outcome = rx\n            .try_recv().unwrap_or(crate::platform::shell_menu::MenuOutcome::None)",
            "`run_on_main_thread` 只投递就返回，真正的「等」全靠这个 recv —— "
            "去掉它 ⇒ 命令在菜单还没弹出时就 resolve ⇒ 前端对账 diff 不出东西 ⇒ "
            "新建的文件进不了竖条（V88 那个 bug 的原样复现）",
        ),
        (
            "V92 桌面目录变了不广播（穿透之后新建的文件凭空消失）",
            "src-tauri/src/commands/grid.rs",
            '                        let _ = app.emit("grid:desktop-changed", ());',
            '                        let _ = app.emit("grid:desktop-changed-v1", ());',
            "穿透之后原生「新建」落地的文件我们收不到任何通知，只能靠这条广播让前端重扫 —— "
            "没了它，用户点「新建文件夹」看到的就是「什么都没发生」",
        ),
        (
            "V93 前端安静期拆掉（新建后整层刷新冲掉刚打开的改名框）",
            "src/modules/desktop-grid/GridOverlay.tsx",
            "    if (isQuiet()) {\n      holdQuiet(1500);\n      pendingRefreshRef.current = true;\n      return;\n    }",
            "    if (false) {\n      holdQuiet(1500);\n      pendingRefreshRef.current = true;\n      return;\n    }",
            "安静期一拆，15 秒对账 / 新建触发的 refresh() 就会把刚 autoFocus 的改名框整层卸载 —— "
            "用户 10-10 原话：「我创建后应该聚焦到命名上，现在刷新，重命名都没有了」",
        ),
        (
            "V93 桌面变化退回整层 syncDesktop（新建 = 整张桌面刷一下）",
            "src/modules/desktop-grid/GridOverlay.tsx",
            "          void onDesktopChanged();",
            "          void syncDesktop();",
            "退回 syncDesktop() ⇒ gridDesktopSync() + 整层 refresh()：用户点「新建文件夹」看到的"
            "不是「名字上有了光标」，而是「整张桌面自己刷了一下、格子全跳一遍」——"
            "正是用户 10-10 说的「跟正常的桌面行为不一样」",
        ),
    ],

    # V102 新增：B 方案（不接管原生桌面）这一组归 test-icon-control.mjs 管。
    # 这一组挑的都是**「编译通过、类型正确、跑起来才炸」**或**「跑起来也不炸、只是
    # 图标悄悄跑偏」**的退化方式 —— 后者才是 B 方案最危险的失效形态（用户只说得出
    # 「看着不对」，说不出哪里不对）。
    #
    # ★★ 2026-10-11 Step 4/5 之后**整体换代**：旧版守的是「B 模式开关打开时让路」
    # （`icon_control_runtime` 镜像 + 开关闸门那一套），Step 4 把开关和「藏」这个动作
    # 一起删掉了 —— 那 9 条锚点在源码里已不存在（留着它们，「替换没生效」会被当 FAIL
    # 报出来，这正是本工具该有的行为）。
    #
    # 新选题的重心从「**加了一条约束吗**」移到「**能力删干净了没有**」。Step 4 的核心
    # 不是加约束，是把能力整个拿掉；所以这里多数用例是反着来的 —— **「把能力偷偷装回来」**。
    # 这类退化在代码评审里最不容易看出来（加的常是一行看着无害的恢复逻辑），
    # 却会把 V42–V101 那六十批的坑整套搬回来。
    "scripts/regression/test-icon-control.mjs": [
        # —— V102.8：单元格必须**就是** Explorer 的间距网格（格挡 == 图标落点）——
        (
            "单元格横向间距又回到「用纵向反推」（V102.3 老路：每列错 8px）",
            "src-tauri/src/commands/grid.rs",
            "        w: read(crate::commands::grid_icons::META_SPACING_X)?.max(16),",
            "        w: read(crate::commands::grid_icons::META_SPACING_Y)?.max(16) - 12,",
            "横向必须**实测**（真机 76）。拿纵向 88 减一个常数去凑，凑出来 84 ⇒ 每往右一列偏"
            "8px、第 5 列偏半格 —— 用户 10-11 看到的「图标散成密集网格」正是它",
        ),
        (
            "单元格之间又加一道缝（间距已含在槽位里，再加就把落点推离网格）",
            "src-tauri/src/commands/grid.rs",
            "        gap: 0,",
            "        gap: GRID_GAP,",
            "Explorer 的横向间距（76）本身已经把图标之间的空隙含进去了。再补一道 6px 的缝，"
            "格子挡位与槽位网格就不同源 —— 每一列再偏 6px",
        ),
        (
            "b_content_frame 的 cell_w 与 cell_h 混用（宽高各推各的）",
            "src-tauri/src/commands/grid.rs",
            "        cell_w: cell.w,\n        cell_h: cell.h,",
            "        cell_w: cell.h,\n        cell_h: cell.h,",
            "摆位按 cell_w 走。写成 cell.h 就是「横向按 88 逻辑摆、格子按 76 画」—— 每列偏"
            "12px、越排越歪，正是「底板与图标两套尺寸」的翻版",
        ),
        (
            "接管从后门回来（`takeover_icons` 真去藏图标）",
            "src-tauri/src/commands/grid.rs",
            "fn takeover_icons(app: &AppHandle, hidden: bool) -> bool {\n    let _ = hidden;",
            "fn takeover_icons(app: &AppHandle, hidden: bool) -> bool {\n"
            "    if hidden {\n        let _ = desktop_icons_apply(true);\n    }",
            "B 方案的根就是「图标归 Explorer」。它一旦真去藏：图标被我们藏起来、而我们的"
            "摆位是发给 Explorer 的（它画的图标却不可见）⇒ 桌面空白，只剩我们画的装饰底板；"
            "V45 装机实测的「桌面全空」当场复现",
        ),
        (
            "`grid_desktop_icons_set` 又能藏图标（留了一条绕开「恒不隐藏」的路）",
            "src-tauri/src/commands/grid.rs",
            "pub async fn grid_desktop_icons_set(app: AppHandle, hidden: bool) -> Result<bool, String> {\n"
            "    let _ = hidden;\n"
            "    let _ = write_icons_hidden(&app, false);\n"
            "    Ok(desktop_icons_apply(false).unwrap_or(false))",
            "pub async fn grid_desktop_icons_set(app: AppHandle, hidden: bool) -> Result<bool, String> {\n"
            "    let _ = write_icons_hidden(&app, hidden);\n"
            "    Ok(desktop_icons_apply(hidden).unwrap_or(false))",
            "Step 4 特意把这个「一次性藏一下」的入口降级成幂等恢复（`hidden` 参数被忽略）—— "
            "它是最后一个能藏图标的地方。放它回来 = 留了一条绕开 `takeover_icons` 那条"
            "「恒不隐藏」约束的路：**能力删掉比约束住更可靠**（约束靠人记得住，删掉不靠记忆）",
        ),
        (
            "`reassert_takeover` 又去藏一次 + 保险丝计数只增不减",
            "src-tauri/src/commands/grid.rs",
            "    let _ = app;\n    TAKEOVER_FIXES.store(0, Ordering::Relaxed);\n}",
            "    let _ = desktop_icons_apply(true);\n    TAKEOVER_FIXES.store(1, Ordering::Relaxed);\n}",
            "它由 25ms 轮询驱动 ⇒ 每 3 秒把用户的原生图标按回去 —— Explorer 每次重画都被我们"
            "盖掉，表现为「桌面图标一闪一闪、Win+D 之后图标再也不出现」。计数不减是另一头："
            "`TAKEOVER_FIXES` 只增不减，日志里永远在报「又修了一次」，真出故障时没人看得出"
            "那是常态还是异常",
        ),
        (
            "位置快照每次开启都重存（原始布局被我们摆过的那一版覆盖）",
            "src-tauri/src/commands/grid_icons.rs",
            "        if meta_get(&conn, META_POS_BACKUP).is_none() {",
            "        if true {",
            "用户「开 → 关 → 开」之后，快照里存的已经不是原始布局、而是**我们摆过的那一版**"
            "⇒「还原图标布局」变成「还原成 Handy 摆的样子」，原始布局永久丢失。"
            "快照只在 `is_none()` 时写，正是为了这个",
        ),
        (
            "FFlags 备份每次开启都重存（用户原本的桌面偏好被我们改过的那版覆盖）",
            "src-tauri/src/commands/grid_icons.rs",
            "        if meta_get(&conn, META_FFLAGS_BACKUP).is_none() {",
            "        if true {",
            "比上一条更隐蔽：备份里存的是**用户原本的**「自动排列 / 对齐网格」偏好。被我们"
            "清过的那一版覆盖之后，「还原图标布局」会把偏好还原成**我们改过的值** —— "
            "用户永远拿不回自己那份设置，而且看不出是我们干的",
        ),
        (
            "还原时硬编码成「开着自动排列」（不还原备份原值）",
            "src-tauri/src/commands/grid_icons.rs",
            "di::set_autoarrange(list, di::flags_autoarrange_on(flags));",
            "di::set_autoarrange(list, true);",
            "用户本来就没开自动排列（用第三方桌面工具前关过）⇒ 我们退出时反而**替他打开**了。"
            "决策 3 定的就是「原值还原」，不是「还原成默认值」",
        ),
        (
            "还原只还位置、不还偏好（「保留位置」这句承诺当场作废）",
            "src-tauri/src/commands/grid_icons.rs",
            "        if let Some(flags) = meta_get(&conn, META_FFLAGS_BACKUP).and_then(|v| v.parse::<u32>().ok())\n"
            "        {\n"
            "            di::set_autoarrange(list, di::flags_autoarrange_on(flags));\n"
            "            let _ = di::write_folder_flags(flags);\n"
            "        }",
            "        if false {\n            let _ = 0u32;\n        }",
            "决策 2 / 3 的合流点：位置与偏好必须绑定。只把图标摆回去、不恢复偏好，只要"
            "「自动排列」还是关着，下一次任何刷新都可能被 Explorer 重新打散 —— "
            "用户点了一次「还原」却眼看着它又散开，只会认为这个按钮坏了",
        ),
        (
            "底板内容原点写死数字（图标与框线错位）",
            "src-tauri/src/commands/grid.rs",
            "        origin_dy: BOX_HEADER_H + BOX_BORDER_H + GRID_PAD_Y,",
            "        origin_dy: 47,",
            "写死数字就与前端脱钩：只要标题栏高 / 边距 / 内边距任一改动，图标就会整体压到"
            "框线上或飘出格子（V59「渲染几何 = 引擎几何」的同一类错，只不过这次错在 B 模式）",
        ),
        (
            "LVS_AUTOARRANGE 位值写错成 0x0001（那是 LVS_REPORT）",
            "src-tauri/src/platform/desktop_icons.rs",
            "pub const LVS_AUTOARRANGE: u32 = 0x0100;",
            "pub const LVS_AUTOARRANGE: u32 = 0x0001;",
            "照着错的位判「自动排列」，永远读到「关着」（或永远读到「开着」）⇒ 该关的时候"
            "没关，`LVM_SETITEMPOSITION` 发出去被 Explorer 立刻拉回，表现为「摆了等于没摆」。"
            "取证探针第一版就栽在这里，结论**整个反了**（见 desktop-icons-pos-probe.py 抬头）",
        ),
        (
            "发消息退回裸 SendMessage（Explorer 一忙就把我们一起冻住）",
            "src-tauri/src/platform/desktop_icons.rs",
            "            SendMessageTimeoutW(\n",
            "            SendMessageW(\n",
            "裸 SendMessage 同步等 Explorer 的 UI 线程、且**没有超时**：它正在建文件 / 正在重画"
            "图标时，我们（以及整个应用）陪着一起卡；Explorer 真挂了就是永久冻死。"
            "跨进程发消息必须带 SMTO_ABORTIFHUNG + 超时",
        ),
        (
            "flags_cleared 顺手多清一位（不可逆地改掉用户桌面偏好）",
            "src-tauri/src/platform/desktop_icons.rs",
            "    flags & !(FLAG_AUTOARRANGE | FLAG_SNAPTOGRID)",
            "    flags & !(FLAG_AUTOARRANGE | FLAG_SNAPTOGRID | 0x0000_0002)",
            "备份只有一份：多清的位在用户点「还原」时还原不回去 —— 用户根本不知道是我们干的。"
            "「只动自己那两位」必须由单测 + 守卫同时锁死",
        ),
        (
            "命中区外扩 HIT_PADDING 大过内容区上内边距（啃掉第一行图标的最上面几像素）",
            "src-tauri/src/commands/grid.rs",
            "const HIT_PADDING: f64 = 4.0;",
            "const HIT_PADDING: f64 = 12.0;",
            "外扩是补「离散采样 vs 连续移动」的时间窗，代价是命中矩形四边各胖一圈。我们报的"
            "标题栏条**紧贴**内容区，这一圈一旦大过 `GRID_PAD_Y(8)`，第一行原生图标的最上面"
            "几像素就点不着 —— 用户看到的是「第一行点不动、下面几行都正常」，最难归因的那种坏。"
            "两边都是裸常量，谁调大一点都不会编译报错",
        ),
        (
            "布局又为已退场的竖条预留一列",
            "src-tauri/src/commands/grid.rs",
            "    let _ = loose_count;\n    let min_x = ARRANGE_MARGIN;",
            "    let min_x = ARRANGE_MARGIN;",
            "前端已经不画竖条了，还留位就是一条**白占一列宽**的空白 —— 所有格子被整体往右挤、"
            "右侧溢出到工作台下面。用户在真机上一眼能看到「右边怎么挤成一堆」，"
            "但很难想到是给一个已经不存在的面板留的位",
        ),
        (
            "前端又画一份图标（每个图标显示两遍）",
            "src/modules/desktop-grid/GridOverlay.tsx",
            "              {!iconControl && boxItems.map((item) => {",
            "              {boxItems.map((item) => {",
            "原生图标就在下面，我们再画一份 ⇒ 用户看到「重影」：上面那份点不动、下面那份"
            "才对 —— 表现为「图标点一下没反应，要点两下」",
        ),
        (
            "格子内容区不穿透（原生图标的双击 / 右键 / 拖拽全废）",
            "src/modules/desktop-grid/GridOverlay.tsx",
            "                  pointerEvents: 'none',\n                  ...(getBoxViewMode(box.id) === 'grid'",
            "                  pointerEvents: undefined,\n                  ...(getBoxViewMode(box.id) === 'grid'",
            "内容区吃点击就是「看得见、点不着」：用户双击图标没反应、右键出的是我们的菜单"
            "而不是原生的。B 方案的全部价值（原生行为一字不改）都建立在穿透上",
        ),
        (
            "根画布回到有条件穿透（空白右键不再落到 Explorer 的原生菜单）",
            "src/modules/desktop-grid/GridOverlay.tsx",
            "        pointerEvents: 'none',\n      }}\n      onContextMenu={(event) => {",
            "        pointerEvents: contentHidden ? 'none' : 'auto',\n      }}\n      onContextMenu={(event) => {",
            "空白处的事件重新落到我们窗口上 ⇒ Explorer 那张原生右键菜单（查看 / 排序方式 / "
            "刷新 / 新建）永远弹不出来。★ 这条**必须**锚定到根画布**那一处**：本文件另有 3 处 "
            "`pointerEvents: 'none'`（内容区 / 提示外框 / 预览），写成「文件里存在这个串」"
            "会永远绿 —— 上一版就是这么写的，被本次换代的变异自检当场揪出来",
        ),
        (
            "「未归类」竖条渲染被加回来",
            "src/modules/desktop-grid/GridOverlay.tsx",
            "      {/* ★ Step 5（B 方案收尾）：左侧「未归类」竖条已退场",
            "      <div ref={looseRef} className=\"hidden\" />\n"
            "      {/* ★ Step 5（B 方案收尾）：左侧「未归类」竖条已退场",
            "竖条一回来，布局里那条白占一列宽的位（见上）也跟着回来，而且它与 B 方案的前提"
            "直接冲突：原生图标一直看得见，「未归类」的文件本来就在桌面上排着，"
            "再抄一份到竖条就是同一批图标显示两遍",
        ),
        (
            "又上报「整窗」命中区（原生图标看得见、点不动）",
            "src/modules/desktop-grid/GridOverlay.tsx",
            "    void ipc.gridOverlayUpdateRegions(regions).catch(() => undefined);",
            "    regions.push({ x: 0, y: 0, width: window.innerWidth * scaleFactor, height: 1 });\n"
            "    void ipc.gridOverlayUpdateRegions(regions).catch(() => undefined);",
            "「根画布 pointerEvents:none」只解决窗口**内部**的转发；真正决定「这个点归谁」的"
            "是 Rust 那条 25ms 命中轮询（`let want = interactive || cursor_hit(&win)`）。"
            "整窗命中区一报，窗口就一直吃点击 ⇒ 桌面空白处仍是我们的：原生右键菜单弹不出来、"
            "框选也选不动",
        ),
        (
            "格子整块报成命中区（内容区吃掉了原生图标）",
            "src/modules/desktop-grid/GridOverlay.tsx",
            "          height: (BOX_HEADER_H + BOX_BORDER_H) * scaleFactor,",
            "          height: box.height * scaleFactor,",
            "内容区被报成命中区 ⇒ 光标一进格子（也就是一进图标那一整片区域）窗口就恢复吃点击"
            "⇒ 格子里所有原生图标全部点不着 —— 而「格子里的图标点不着」正是用户会第一眼"
            "看到、却最难归因的那种坏",
        ),
        (
            "摆位不再挂在重排之后（按新格子算坐标、按旧底板放图标）",
            "src/modules/desktop-grid/GridOverlay.tsx",
            "        .then(() => ipc.desktopIconLayoutApply())",
            "        .then(() => null)",
            "少了这一脚，拖动格子之后底板挪了、图标还停在旧位置 —— 直到下一次偶然的重排才"
            "跟上。表现为「拖完格子图标乱飞一下又回到原位」",
        ),
        (
            "还原入口摆到快照判断之外（没快照也显示）",
            "src/modules/desktop-grid/GridManagerView.tsx",
            "      {iconControl.snapshot > 0 && (",
            "      {true && (",
            "没存过快照也摆一个「还原图标布局」按钮，点下去报「没有可还原的快照」——"
            "用户视角就是「按钮是个摆设」，正是 V97 明确砍掉的那类项（宁缺毋滥）",
        ),
        (
            "管理页又出现「接管开关」（撤掉接管的功能性反悔）",
            "src/modules/desktop-grid/GridManagerView.tsx",
            "  const [iconControl, setIconControl] = useState<IconControlStatus>(ICON_CONTROL_OFF);",
            "  const toggleIconControl = async (): Promise<void> => {};\n"
            "  const [iconControl, setIconControl] = useState<IconControlStatus>(ICON_CONTROL_OFF);",
            "开关一回来，用户就有办法把摆位关掉 —— 而前端那套「自己画图标」的渲染已经删了 ⇒ "
            "桌面上的图标不受我们管、格子里的图标又没人画，一排空框。"
            "这正是 Step 4 删掉开关（而不是把开关默认关）的原因",
        ),
        (
            "命令注册又多了 `desktop_icon_control_set`",
            "src-tauri/src/lib.rs",
            "            commands::grid_icons::desktop_icon_control_get,",
            "            commands::grid_icons::desktop_icon_control_set,\n"
            "            commands::grid_icons::desktop_icon_control_get,",
            "命令一旦注册，前端（或任何脚本）就能调它 —— Rust 侧那个「只恢复不隐藏」的实现"
            "只是当下的克制，注册表上多一条就是一条能被接回去的线。守卫同时锁 lib.rs 与 "
            "ipc.ts 两端，缺一条就是「后端还留着、前端随时能复活」",
        ),
        (
            "启动装配被拿掉（间距没测到，格子高与 Explorer 间距脱钩）",
            "src-tauri/src/lib.rs",
            "            commands::grid_icons::ensure_native_layout(app.handle());",
            "            let _ = app.handle();",
            "装配那一步采集了 Explorer 的真实图标间距（`icon_spacing_y`）并关掉自动排列"
            "（否则 `LVM_SETITEMPOSITION` 发出去会被立刻拉回）。没了它：格子高按默认值算 ⇒ "
            "底板格子与图标各排各的，「格子套图标」当场对不上；而且没有任何报错",
        ),
        (
            "迁移 v12 顺手清了还要用的键（把「唯一真源」一起删掉）",
            "src-tauri/src/db/migrations.rs",
            "DELETE FROM grid_meta WHERE key IN ('desktop_takeover', 'desktop_icons_hidden', 'icon_control');",
            "DELETE FROM grid_meta WHERE key IN ('desktop_takeover', 'desktop_icons_hidden', 'icon_control', 'overlay_visible');",
            "v12 的职责只有一个：清掉**接管时代**的键。`overlay_visible` 是显隐的唯一真源"
            "（V79：谁写谁广播，前端 fail-closed 依赖它）、`icon_pos_backup` 是「还原图标布局」"
            "的凭据、`fflags_backup` 是自动排列的原值 —— 顺手清掉其中之一，功能就静默少一块",
        ),
        # —— V102.2「整理失效」（2026-10-11）：摆位必须有 Rust 端这条腿 ——
        (
            "一键整理又不含摆位（底板重排了、图标原地不动）",
            "src-tauri/src/commands/grid.rs",
            "    crate::commands::grid_icons::apply_after_relayout(&app);\n    Ok(report)",
            "    Ok(report)",
            "2026-10-11 事故本体：摆位只靠前端 relayoutSoon 那条链，一键整理跑完格子重排、"
            "图标却停在自动排列时代的密集网格位置 —— 用户看到的就是「整理失效」，且零报错",
        ),
        (
            "增量重排又不含摆位（便签一加、图标就跟格子对不齐）",
            "src-tauri/src/commands/grid.rs",
            "        \"重排（不扫描·增量）：挪动 {} 个 / 按内容调整 {} 个尺寸 / 挂件归位 {} 个 / 空间不足 {} 个\",\n"
            "        outcome.moved, outcome.resized, outcome.anchored, outcome.overflowed\n"
            "    ));\n"
            "    crate::commands::grid_icons::apply_after_relayout(&app);",
            "        \"重排（不扫描·增量）：挪动 {} 个 / 按内容调整 {} 个尺寸 / 挂件归位 {} 个 / 空间不足 {} 个\",\n"
            "        outcome.moved, outcome.resized, outcome.anchored, outcome.overflowed\n"
            "    ));",
            "grid_relayout 是挂件 / 新格子 / 拖动后最常走的重排路 —— 少这一脚，"
            "每次增量重排都让底板与图标错开一点，攒几次就「看着不对却说不出哪次开始错的」",
        ),
        (
            "启动装配的最后一脚摆位被拿掉（开机后图标停回密集网格）",
            "src-tauri/src/commands/grid_icons.rs",
            "    // ⑤ 启动即摆位：自动排列已经关掉，图标停在关掉那一刻的密集网格位置 ——\n"
            "    //    不在这里摆一次，格子底板和图标就一直是两张皮，直到用户碰巧触发一次重排\n"
            "    //    （2026-10-11「整理失效」事故的另一半根因）。\n"
            "    apply_after_relayout(app);",
            "    let _ = app;",
            "关掉自动排列不会重新摆放图标 —— 它们停在关掉那一刻的位置。启动不摆位 ⇒ "
            "从启动到第一次重排之间，桌面永远是「空格子底板 + 密集网格图标」两张皮",
        ),
        # —— V102.3（10-11 深夜）：摆位必须量化到 Explorer 槽位网格 ——
        # ★ V102.9 更新：量化用的「步长 / 锚点」改名为 `step_x/step_y`、`phase_x/phase_y`，
        #   锚点不再从现有图标反推而是实测（`di::snap_grid`）。替身字符串同步。
        (
            "摆位坐标不再量化（发任意像素 ⇒ Explorer 0.3s 内把图标吸到别处）",
            "src-tauri/src/commands/grid_icons.rs",
            "            let slot_x = quantize(screen_x, step_x, phase_x);\n"
            "            let slot_y = quantize(screen_y, step_y, phase_y);\n"
            "            placements.push((\n"
            "                index,\n"
            "                slot_x - client_x,\n"
            "                slot_y - client_y,\n"
            "            ));",
            "            placements.push((\n"
            "                index,\n"
            "                screen_x as i32 - client_x,\n"
            "                screen_y as i32 - client_y,\n"
            "            ));",
            "真机实测（Win11 125%）：Explorer 会把非槽位坐标吸到最近槽位；表现就是用户截图里"
            "「格子底板在、图标全散成密集网格」",
        ),
        (
            "槽位锚点不再实测（退回按现有图标坐标反推 ⇒ 整体偏一格）",
            "src-tauri/src/commands/grid_icons.rs",
            "    let snapped = di::snap_grid(list);",
            "    let snapped: Option<((i32, i32), (i32, i32))> = None;",
            "锚点**必须实测**：真机上「按现有图标坐标 mod 步长」推得 (0,5)，而实测是别的值 —— "
            "每列偏 18 物理像素，用户看到的就是「图标没进格子」。"
            "反推之所以不成立，是因为图标坐标里还叠着一层与槽位无关的偏移",
        ),
        (
            "摆位不再按格内容量截断（图标被摆到格子外 / 屏幕外）",
            "src-tauri/src/commands/grid_icons.rs",
            "        let capacity = (frame.cols * frame.max_rows).max(0) as usize;",
            "        let capacity = usize::MAX;",
            "B 模式下图标是 Explorer 画的、**不随格子滚动** —— 溢出格底就是永久看不见。"
            "真机实测 50/75 个条目的坐标落在物理 y = 1200~2400，而屏幕只有 1080",
        ),
        (
            "box_height_at 又开始谎报（夹紧值当可行性判据）",
            "src-tauri/src/commands/grid.rs",
            "    box_height_needed(items, w, cell).clamp(MIN_BOX_H, max_h.max(MIN_BOX_H))",
            "    let _ = max_h;\n    box_height_needed(items, w, cell)",
            "夹紧后的值只能用来落库，不能拿来判可行性 —— 一旦谎报，"
            "`tallest > zone_h` 永远不触发，「1 列装 34 条」这种解会被选中，图标全摆到屏幕外",
        ),
    ],
}


def run_guard(guard: pathlib.Path) -> tuple[int, str]:
    proc = subprocess.run(
        ["node", str(guard)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def main() -> int:
    if len(sys.argv) > 1:
        guards = [pathlib.Path(arg).resolve() for arg in sys.argv[1:]]
        # 显式指定守卫时必须登记过用例，否则「跑完 0 个用例 → 全绿」是假的
        unknown = [g for g in guards if str(g.relative_to(ROOT)).replace("\\", "/") not in MUTATIONS]
        if unknown:
            print("这些守卫还没登记破坏用例，请补 MUTATIONS：")
            for item in unknown:
                print(f"  · {item.relative_to(ROOT)}")
            return 1
    else:
        guards = [ROOT / rel for rel in MUTATIONS]

    failures: list[str] = []
    total_cases = 0
    for guard in guards:
        rel = str(guard.relative_to(ROOT)).replace("\\", "/")
        cases = MUTATIONS[rel]
        total_cases += len(cases)
        print(f"\n=== {rel} ===")
        code, out = run_guard(guard)
        baseline = out.strip().splitlines()[0] if out.strip() else "(无输出)"
        print(f"[基线] exit={code} · {baseline}")
        if code != 0:
            failures.append(f"{guard.name} 基线就是红的，先修好它：\n{out}")
            continue

        for name, rel_target, find, repl, why in cases:
            target = ROOT / rel_target
            if not target.exists():
                failures.append(f"{name}：目标文件不存在 {rel_target}")
                continue
            original = target.read_text(encoding="utf-8")
            if find not in original:
                failures.append(
                    f"{name}：替换没生效（源码里找不到待替换的字符串，请更新本工具的用例）\n"
                    f"  文件 {rel_target}\n  期望找到 {find!r}"
                )
                continue
            if find == repl:
                failures.append(f"{name}：用例本身是空操作")
                continue

            with tempfile.TemporaryDirectory() as tmp:
                backup = pathlib.Path(tmp) / target.name
                shutil.copy2(target, backup)
                try:
                    target.write_text(original.replace(find, repl, 1), encoding="utf-8")
                    mutated_code, mutated_out = run_guard(guard)
                finally:
                    shutil.copy2(backup, target)

            restored = target.read_text(encoding="utf-8") == original
            if not restored:
                failures.append(f"{name}：还原失败！{rel_target} 已被改动，请手工检查")
                continue
            if mutated_code == 0:
                failures.append(
                    f"{name}：**改了源码守卫仍然全绿** —— 这条断言没有判别力\n"
                    f"  破坏方式：{rel_target} 里把 {find!r} 改成 {repl!r}\n"
                    f"  后果：{why}\n  守卫输出：{mutated_out.strip()[:400]}"
                )
                print(f"[用例] {name} → 仍是绿 ✗（无判别力）")
            else:
                first_fail = next(
                    (
                        line.strip()
                        for line in mutated_out.splitlines()
                        if line.strip().startswith("✗")
                    ),
                    "(未列出明细)",
                )
                print(f"[用例] {name} → 变红 ✓ {first_fail}")

        code, out = run_guard(guard)
        if code != 0:
            failures.append(f"{guard.name} 还原后不绿了：\n{out}")
            print(f"[还原] exit={code} ✗")
        else:
            print(f"[还原] exit=0 ✓ {out.strip().splitlines()[0]}")

    print()
    if failures:
        print(f"自证非恒真失败 {len(failures)} 项：")
        for item in failures:
            print(f"  ✗ {item}")
        return 1
    print(
        f"自证非恒真通过：{len(guards)} 个守卫 / {total_cases} 个破坏用例全部被捕获，且源码已还原"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
