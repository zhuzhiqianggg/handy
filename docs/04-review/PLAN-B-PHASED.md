# B 方案落地实施方案（v1 · 基线 V101 · 2026-10-10）

> 配套文档：[`REVIEW-2026-10-10.md`](REVIEW-2026-10-10.md)（复评结论与根因诊断）。
> 本文只回答「**具体怎么改、分几步、每步怎么回滚、用户会看到什么变化**」。
> **动代码前请先看 §0 —— 有 4 条必须由你拍板的前置决策。**

---

## 0. 前置决策（需要你拍板，未拍板不动工）

> **进展（2026-10-10）**：决策 1–4 **按推荐选项已锁定并实施**（A2-full 遥控图标位置 / 首次
> 接管快照 + 提供手动还原 / FFlags 原值还原 / 放弃「撤消删除」与「下一个桌面背景」）。
> Step 0–3 已完成，见 §3 顶部「实施进展」。**Step 4/5/6 未动** —— 见该节末尾的待确认项。

### 决策 1 ⭐ 图标位置是否由我们遥控？

这是整个 B 方案唯一真正的岔路口。

| 选项 | 做法 | 好处 | 代价 |
| --- | --- | --- | --- |
| **A2-full（推荐）** | 计算目标坐标 → `LVM_SETITEMPOSITION` 把**原生图标**摆进分组 | 保住「按格子分组摆放」这个核心卖点；同一个摆位引擎，图标仍归 Explorer 画 | **会写你的桌面图标布局**（见决策 2）；需先关掉「自动排列/对齐网格」 |
| A2-lite | 完全不移动图标；格子只画**装饰底板 + 标题栏**浮在图标区上方 | **零磁盘/零注册表副作用**，最安全 | 失去自动分组摆放；格子只是"围栏框"，位置全靠你自己拖 |

> 腾讯桌面整理、Fences、DeskBox 走的都是 A2-full 路线。**A2-lite 会更安全，但产品力弱一档。**

### 决策 2 ⭐ 退出 Handy 后，图标位置要还原吗？

`LVM_SETITEMPOSITION` 的结果会**被 Explorer 写进注册表**（`Bags\1\Desktop` 的图标布局），
也就是说 —— **摆位是"半永久"的，推倒 Handy 图标也不会自己弹回去**（Fences 也是这个行为）。

- 选项 A：**保持不还原**（同 Fences / 腾讯桌面整理）+ 提供「还原桌面图标布局」按钮。
- 选项 B：退出时**自动还原**到进入前的布局（需要我们在首次接管时备份一份图标位置表）。

> ⚠️ 这条**推翻了 V37 立的「一个字节都不动」** 那条不变量的一半 —— 文件仍然一个字节不动，
> 但**图标位置会被我们写**。必须你明确同意，否则不动工。

### 决策 3 「自动排列 / 对齐网格」被我们关闭 —— 退出时还原吗？

遥控位置的前提是这两个开关**必须关掉**（开着 Explorer 会把图标拉回自己的网格）。
它同样是注册表里的**用户偏好**。

- 建议：进入时记录原值 → 关闭 → 退出时**还原原值**（比图标位置更该还原，它是"偏好"不是"结果"）。

### 决策 4 确认放弃这两项（做不成真）

「撤消 删除」与「下一个桌面背景」依赖 Explorer 内部撤销栈与幻灯片引擎，**无公开接口**。
B 方案下它们会直接出现在原生右键菜单里，**由系统提供**（比我们自绘的还正确）。
—— 若走 A2-full，这两条自动解决，无需再讨论。

---

## 1. 目标架构

```
┌─ 桌面（Explorer 拥有）────────────────────────────┐
│  SysListView32  ← 图标永远由它画、由它响应右键      │
│     ↑ LVM_SETITEMPOSITION（我们只遥控坐标）         │
└──────────────────────────────────────────────────┘
        ↑ 上方叠一层
┌─ Handy 装饰层（我们的浮窗）───────────────────────┐
│  分组底板 + 标题栏（纯装饰，pointer-events 分区域）  │
│  便签 / 日历 / 工作台（独立普通浮窗）               │
└──────────────────────────────────────────────────┘
```

**核心变化**：「谁拥有图标」从**我们**变回 **Explorer**。
我们只保留两件事：**算坐标** 和 **画框**。其余原生行为（右键 / 新建 / 改名 / 排序 / 刷新 /
回收站 / 拖拽 / 图标尺寸 / Win+D / Z 序）**全部免费回来**，一行代码都不用写。

---

## 2. 逐项对照：保留 / 改造 / 删除

| 现有能力 | 处置 | 说明 |
| --- | --- | --- |
| 布局引擎（`content_plan*` / `pack_columns` / `fit_column_heights` / `FlowPlacer` …） | ✅ **保留** | 纯算法，输出 `(x, y, w, h)` —— 现在喂给前端画，B 方案喂给 `LVM_SETITEMPOSITION` |
| 格子数据模型（`grid_boxes` / `grid_items`） | ✅ **保留** | 仍是"登记"，零迁移 |
| `desktop_icon_view()`（拿 `SysListView32` 句柄） | ✅ **保留** | 正好是遥控的目标窗口 |
| 窗口穿透轮询（`ensure_poller` / `cursor_hit`） | 🔧 **改造** | 只服务"装饰层"命中区，区域大幅缩小 |
| 挂件窗贴桌面层（`place_above_desktop` / `apply_attach`） | 🔧 **改造** | 仍要贴，但不再需要"防 Win+D 消失"的自愈 |
| **隐藏 `SysListView32`**（`desktop_icons_apply(true)`） | ❌ **删除** | 整个"接管"概念的根 |
| Z 序自检 / 重排（`z_verdict` / `classify_chain` / `reassert_attach`） | ❌ **删除** | 只为"我们画的图标别被盖住"而存在 |
| 驻留自愈 / Win+D 还原（`restore_if_minimized` / `REASSERT`） | ❌ **删除** | 图标归 Explorer 后无此问题 |
| 接管自检（`reassert_takeover` / `heal_desktop_icons` / 保险丝） | ❌ **删除** | 不再有"藏没藏住"这件事 |
| 桌面目录签名轮询（`desktop_dir_signature`） | ❌ **删除** | 原生新建会自己刷图标，我们无需知情（竖条若保留则另说，见 §3 Step 5） |
| 自绘右键菜单（`shell_menu.rs` 1,313 行 + `bgMenu`/`BgMenuRow`） | ❌ **删除** | 原生菜单本来就是对的 |
| 经典菜单注入（V100 的顶部三项 + 全量 ShellNew） | ❌ **删除** | 同上 |
| `desktop_handoff.rs`（684 行，已停用） | ❌ **删除** | 死重 |
| `desktop_menu.rs`（431 行） | ❌ **删除**（若仍有引用则并入） | 与上重叠 |
| 「改名 / 新建安静期」（`renamingRef` / `quietUntilRef` …） | ❌ **删除** | 那是为了压制我们自己的重排，原生改名不需要 |
| 前端图标绘制（`FileIcon` 调用点 3 处 / `LooseIcon` / 条目网格） | ❌ **删除** | 原生图标就在下面 |
| 竖条「未归类」（`loose` 渲染） | 🔧 **改造** | 见 §3 Step 5：要么改由遥控原生图标站成一条，要么整个删掉 |
| 便签 / 日历（`DesktopWidgets.tsx` 1,252 行） | ✅ **保留** | 改普通浮窗 |

---

## 3. 分步实施（6 步，每步独立可回滚）

### 实施进展（2026-10-10）

| 步骤 | 状态 | 提交 / 产物 | 备注 |
| --- | --- | --- | --- |
| Step 0 预备 | ✅ 完成 | `699038d` · tag `v101-baseline` · 分支 `b-plan` | 只读探针 `scripts/audit/desktop-icon-pos-probe.py`。**实测**：`FFlags=0x40200225`、`LVS_AUTOARRANGE=0x0100` 开着、127 条目、间距 `76×88`、跨进程读写**通** |
| Step 1 遥控模块 | ✅ 完成 | `a62faf3` · `src-tauri/src/platform/desktop_icons.rs` | 纯函数 + 4 条单测（`pack_point` 往返 / 位序 / 只清两位 / 本机真值判读） |
| Step 2 接入 + 开关 | ✅ 完成 | `a62faf3` · `src-tauri/src/commands/grid_icons.rs` | 4 条命令；`grid_meta` 键名取 `icon_control` / `icon_spacing_y`（非方案里的 `icontrol_enabled`） |
| Step 3 前端装饰化 | ✅ 完成 | 见本次提交 · `GridOverlay.tsx` / `GridManagerView.tsx` | 含 Step 3 里原先漏掉的那条**功能性**要求：B 模式下命中区收窄到标题栏（详见下方注） |
| Step 4 切断接管 | ⏸ **未动** | — | 等确认，见本节末尾 |
| Step 5 竖条取舍 | ⏸ **未动** | — | 方案自己写了「需要你在实施时再确认一次」 |
| Step 6 拆模块 + 清死代码 | ⏸ **未动** | — | 纯删除，等 Step 4/5 定下来再一次做 |

**Step 3 补的那条**（方案 v1 只写了「区域上报同步缩小」一句，实现时才发现它其实是**
「原生图标能不能点」的决定性一环**）：

`pointerEvents: none` 只解决**窗口内部**的转发 —— 点击落在我们窗口上、穿过 DOM
之后仍然停在我们这层窗，到不了 Explorer。真正决定「这个点归谁」的是 Rust 那条
25ms 命中轮询：`let want = interactive || cursor_hit(&win)`，只要光标命中上报的
任一矩形就 `set_ignore_cursor_events(false)`（窗口吃点击）。所以 B 模式下：

- **不报整窗**（V96 那条整窗命中区必须让路）；
- **每个格子只报标题栏那一条**（`BOX_HEADER_H + BOX_BORDER_H`），内容区整片交还桌面；
- `regionsKey` 与依赖数组都加上 `iconControl`（切模式必须重报命中区）。

配套不变量：命中区外扩 `HIT_PADDING = 4.0` **必须小于**内容区上内边距 `GRID_PAD_Y = 8`
（否则标题栏下面那一圈外扩会啃掉第一行原生图标的最上面几像素）。已进守卫。

**Step 4/5/6 的两个待确认项**：

1. **Step 5 竖条「未归类」**：5a 保留（改由遥控原生图标站成一列，代价是持续写图标
   位置）/ **5b 删掉**（我更倾向）。目前实现是「B 模式下不渲染竖条、代码保留」。
2. **Step 4 的「开关翻转」**：方案 v1 写的是「函数保留但恒不执行隐藏」= 接管彻底作废。
   一旦翻转，`iconControl` 关掉时就会**既没有原生摆位、也没有前端图标**（Step 3 已把
   前端绘制删掉），格子变成空框。所以**先要一个「B 模式在你的机器上确实可用」的验收**，
   再翻这个开关 —— 这也是方案 §6 那句「Step 2 / Step 3 各装一次机给你看效果」的由来。

### Step 0 — 预备（不改行为，1 次提交）

1. `git tag v101-baseline`（`simplify` 分支现 HEAD = `8bf3100`）。
2. 新分支 `b-plan`（不直接在 `simplify` 上动，`simplify` 保留为随时可回退的已知 good 点）。
3. 写一个**只读探针** `scripts/audit/desktop-icon-pos-probe.py`：
   打印 `SysListView32` 的 `LVS_AUTOARRANGE` 位、`Bags\1\Desktop\FFlags` 原值、
   前 10 个图标的当前位置（供 Step 2/3 对照）。
4. **备份**用户当前桌面图标布局（导出 `Bags\1\Desktop` 的 `IconLayouts`/`IconStreams` 到文件）。

> 回滚点：无需回滚（无行为变化）。

### Step 1 — 新增「图标遥控」能力，与旧逻辑并行（默认不启用）

- 新增 `src-tauri/src/platform/desktop_icons.rs`：
  - `fn autoarrange_state() -> bool` / `fn set_autoarrange(off: bool) -> Result<bool, String>`
    （读/写 `Bags\1\Desktop\FFlags`，**具体位值在 Step 2 用探针实测确认后再写死**，
    并在文件头记录取证过程 —— 不靠记忆里的位值猜）；
  - `fn position_item(list: HWND, index: usize, x: i32, y: i32)`（`LVM_SETITEMPOSITION`，
    lParam = `MAKELPARAM(x, y)`）；
  - `fn apply_layout(placements: &[Placement])`（批量摆位 + 失败计数）；
  - `fn snapshot_positions() -> Vec<(usize, i32, i32)>` / `fn restore_positions(&[…])`
    （决策 2 选"还原"时用）。
- **不接入任何调用点**，先落文件 + 单元测试（坐标换算纯函数可测）。
- 探针实跑一次，把「关掉自动排列前 / 后」的图标位置差异贴进提交信息 → 确认遥控真的生效。

> 回滚点：删文件，零影响。

### Step 2 — 接入遥控，用**独立开关**控制（默认关）+ 关闭自动排列

- `grid_meta` 新增 `icontrol_enabled`（默认 `0`）。
- 开启时：备份原 `FFlags` 与图标位置 → 关闭自动排列 → 调 `apply_layout`。
- 关闭 / 应用退出时：**还原 `FFlags`**（决策 3），图标位置按决策 2 处理。
- 此时**旧接管逻辑仍然在**（仍然会藏 `SysListView32`）—— 本步只验证「遥控能否把图标摆到指定坐标」，
  在**手工把自动排列关掉、并且不启用接管**的条件下测。

> 回滚点：把 `icontrol_enabled` 置 0，行为回到 V101。

### Step 3 — 前端：格子改「装饰底板 + 标题栏」，删掉内容绘制

- `GridOverlay.tsx`：删除 `FileIcon` 在**格子内容区**与**竖条**的调用；保留 `FileIcon` 只用于
  标题栏小图标（若仍需要）。
- 底板区域 `pointer-events: none`（**让原生图标可见可点**）+ 标题栏 `pointer-events: auto`
  （可拖动/右键/改名格子本身）。
- 区域上报（`grid_overlay_update_regions`）同步缩小到"标题栏 + 底板边框"。
- 删除 `FileIcon` / `LooseIcon` / 条目网格布局相关代码。

> 回滚点：`git checkout` 本步提交。

### Step 4 — 切断接管（本步是"开关翻转"）

- `apply_takeover_pref` / `takeover_icons` / `reassert_takeover` / `heal_desktop_icons`
  **不再隐藏** `SysListView32`（函数保留但恒不执行隐藏；删留给 Step 6）。
- `restore_desktop_icons` 改为「无条件恢复」（退出路径保留，防旧状态残留）。
- 迁移：把用户库里的 `desktop_icons_hidden` / `takeover` 强制清 0（**只清这两个"意图/瞬时"键，
  不动 `overlay_visible`** —— 沿用 V79 纪律）。
- 启动时执行一次 `restore_desktop_icons`（把历史接管态还回去）。

> 回滚点：本步单独一个 commit，`git revert` 即可。

### Step 5 — 竖条「未归类」的取舍（⚠️ 需要你在实施时再确认一次）

两条路：

- **5a 保留竖条**：竖条区域由 `apply_layout` 把**未登记的原生图标**摆成一条竖列，
  **不再由前端绘制**。代价：竖条要参与布局引擎（已具备），但会持续写图标位置。
- **5b 删掉竖条**：未登记图标就留在桌面默认位置（Explorer 自己排），
  格子只管已登记的。**更简单、副作用更小**，但少了「未归类一览」。

> 我倾向 **5b**：竖条的价值本来就来自"原生图标被藏了所以看不见"，
> 不接管之后原生图标一直在，竖条变成纯冗余。

### Step 6 — 拆模块 + 清死代码（收尾）

- `grid.rs` 拆为 `grid/{db,layout,desktop,commands}.rs`；**`layout.rs` 不得出现 `windows::`**。
- 删除：`shell_menu.rs` · `desktop_menu.rs` · `desktop_handoff.rs` · `itemDragging` ·
  `ensure_dir` · `NoteWindow.tsx` / `NoteListView.tsx` / `MarkdownEditor.tsx`。
- 守卫同步：`test-shell-menu.mjs` 删除（150 断言）；`test-drag-pointer.mjs` 白名单收敛；
  `guard-mutation-check.py` 的 shell-menu 组移除；`test-desktop-constants.mjs` 复核。
- `cargo test --lib` 预期从 86 条降一批（Z 序 / 接管类测试随代码一起删），**新增遥控与
  FFlags 还原的测试**。

---

## 4. 行为变化清单（用户可见 —— 这是验收重点）

| 变化 | 方向 | 说明 |
| --- | --- | --- |
| 桌面右键菜单 | ✅ 变好 | **原生菜单**，含「撤消 删除」「下一个桌面背景」「排序方式」全集 |
| 新建 / 改名 / 刷新 | ✅ 变好 | 全部原生，**不再有安静期、不再有改名框丢失** |
| 桌面图标 | ✅ 变好 | 由 Explorer 画，**尺寸/间距/叠层/拖拽/回收站**全原生 |
| Win+D / 显示桌面 | ✅ 变好 | 图标本来就是桌面的，**没有再"消失/慢 1-2 秒"的问题** |
| 图标位置 | ⚠️ **变了** | 会被我们摆进分组（**决策 1/2 的核心**） |
| 「自动排列/对齐网格」 | ⚠️ **变了** | 进入时被关闭、退出时还原（决策 3） |
| 竖条「未归类」 | ⚠️ 可能消失 | 见 Step 5 |
| 「隐藏/显示桌面图标」开关 | ❌ 移除 | 不再有意义（图标永远在） |
| 格子内条目不能再点开 | ⚠️ **变了** | 改为点**原生图标**打开 —— 行为回到系统标准 |
| 拖文件进格子 | 🔧 保留 | 仍是「只登记」，用格子标题栏作为投放目标（细节在 Step 3 定） |

---

## 5. 风险与不做项

| 风险 | 缓解 |
| --- | --- |
| 遥控位置在**上百个图标**时可能卡顿 / Explorer 抖动 | 批量摆位后统一 `RedrawWindow`；上限保护 + 失败计数落盘 |
| 「自动排列」位值/FFlags 语义我记忆里不确定 | **Step 1 用探针实测取证**，不猜；取证过程写进文件头注释 |
| 用户已习惯「格子 = 桌面上那份」的视觉 | 行为变化清单提前给你确认；Step 2/3 可分两次装让你看效果 |
| 删掉 150 条菜单守卫后回归网变薄 | 删除的都是"我们复刻原生"的守卫，**原生由系统保证**；新增遥控/还原的守卫补上 |

**明确的不可做项**：撤消删除、下一个桌面背景（无公开接口）—— B 方案下由系统自带，无需我们做。

---

## 6. 工程量与顺序（不含等待与装机）

| 步骤 | 规模 | 依赖 |
| --- | --- | --- |
| Step 0 预备 + 备份 | 小 | — |
| Step 1 遥控模块（新文件 + 单测 + 探针取证） | 中 | Step 0 |
| Step 2 接入 + 开关 + FFlags 还原 | 中 | Step 1 |
| Step 3 前端装饰化 | **大** | Step 2 验证通过 |
| Step 4 切断接管 | 小（开关翻转） | Step 3 |
| Step 5 竖条取舍 | 小 | Step 4 |
| Step 6 拆模块 + 清债 + 守卫 | 中 | Step 5 |

> **每步一个 commit，每步可独立回滚。** Step 2 / Step 3 建议各装一次机给你看效果，再继续。

---

## 7. 交付前必跑（沿用现有纪律）

`tsc --noEmit` · `node scripts/regression/run.mjs` · `source scripts/rust-env.sh && cargo test --lib` ·
`python scripts/audit/guard-mutation-check.py`（改过守卫必跑） ·
打包 `bash scripts/build-release.sh --no-deploy` → 接管态装机**必须先归还桌面图标** → `cmp -l` 取证 → 不代启动。

---

*本文件为实施方案 v1，随实施进展更新。任何与 §0 决策相关的变更，先回写本文件再动代码。*
