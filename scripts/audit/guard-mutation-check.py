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
