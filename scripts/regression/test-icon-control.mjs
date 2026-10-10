/**
 * 「B 方案：不接管原生桌面」的回归守卫（V102 新增）。
 *
 * # 为什么必须锁
 *
 * V42–V101 六十批全耗在「接管桌面」这一条路线上（藏 `SysListView32` + 自绘图标 +
 * 复刻 Explorer 的 Z 序 / Win+D / 自愈 / ShellNew / 就地改名）。这条路线的每一环都
 * **没有公开接口**，只能靠事件嗅探 + 轮询 + 竞速去猜，于是「修一个、坏一个」，
 * 六十批没收敛（用户 10-10：我们修复优化了太多次数了）。
 *
 * B 方案换根：**图标永远归 Explorer**，我们只做「算坐标 + 画装饰底板 + 遥控位置」。
 * 这条路线的正确性不靠「跑起来看着对」，而是靠三条**必须显式**的性质：
 *
 *   ① **图标不被我们藏** —— 否则又回到「自己扮 Explorer」，全套坑原样搬回来
 *      （B 模式下 `takeover_icons` / `reassert_takeover` 都必须让路；后者若漏，
 *       会每 3 秒把用户的原生图标藏一次 ⇒ V45 那类「桌面全空」事故）；
 *   ② **底板与图标共用一份几何** —— 分开算过一次就知道，差 1px 就是「图标压框线」；
 *   ③ **不写文件** —— 「整理位置，不是整理文件」的项目红线（V37 / V48）。
 *
 * 外加一串**静默失效点**：`LVS_AUTOARRANGE` 的位值（`0x0100`，`0x0001` 是 `LVS_REPORT`
 * —— 取证探针第一版就写错过，结论整个反了）、`SendMessage` 不许裸用（会挂死 Explorer）、
 * 跨进程内存必须配对释放、`LVITEMW` 的 x64 偏移（pszText@24 / cchTextMax@32）……
 * 这些编译通过、类型正确、单测全绿，只能靠源码断言守住。
 *
 * **解析不到即 FAIL**（不是跳过）：正则没匹配上时本套件必须变红，否则它静默退化成
 * 「永远 PASS」，比没有它更糟（CONVENTIONS「审计脚本解析为空即 FAIL」）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

const DESKTOP_ICONS = 'src-tauri/src/platform/desktop_icons.rs';
const GRID_ICONS = 'src-tauri/src/commands/grid_icons.rs';
const RUST_CMD = 'src-tauri/src/commands/grid.rs';
const LIB_RS = 'src-tauri/src/lib.rs';
const IPC = 'src/lib/ipc.ts';
const TYPES = 'src/types/grid.ts';
const OVERLAY = 'src/modules/desktop-grid/GridOverlay.tsx';
const MANAGER = 'src/modules/desktop-grid/GridManagerView.tsx';

let pass = 0;
let fail = 0;
const bad = [];

function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    bad.push(extra ? `${name} —— ${extra}` : name);
  }
}

/** 读文件；读不到直接记 FAIL 并把内容当空串，后续断言会连带暴露。 */
function read(rel) {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch (err) {
    ok(`能读到 ${rel}`, false, String(err.message));
    return '';
  }
}

const diSrc = read(DESKTOP_ICONS);
const giSrc = read(GRID_ICONS);
const cmdSrc = read(RUST_CMD);
const libSrc = read(LIB_RS);
const ipcSrc = read(IPC);
const typesSrc = read(TYPES);
const overlaySrc = read(OVERLAY);
const managerSrc = read(MANAGER);

/** 取 Rust 里某个 `const X: u32 = 0x...;` 的数值；取不到返回 null（= 断言会红）。 */
function rustU32Const(src, name) {
  const m = src.match(new RegExp(`const ${name}: u32 = (0x[0-9a-fA-F_]+);`));
  return m === null ? null : Number.parseInt(m[1].replace(/_/g, ''), 16);
}

/** 取 Rust 里某个 `const X: f64 = 4.0;` 的数值；取不到返回 NaN（= 断言会红）。 */
function rustF64Const(src, name) {
  const m = src.match(new RegExp(`const ${name}: f64 = ([0-9.]+);`));
  return m === null ? Number.NaN : Number.parseFloat(m[1]);
}

/** 取 Rust 里某个 `const X: i64 = 8;` 的数值；取不到返回 NaN（= 断言会红）。 */
function rustI64Const(src, name) {
  const m = src.match(new RegExp(`const ${name}: i64 = (-?[0-9]+);`));
  return m === null ? Number.NaN : Number.parseInt(m[1], 10);
}

/* ================================================================== *
 * ① 位与常量：写错一个位值，整个功能静默反向
 * ================================================================== */

// ★ 探针第一版把 LVS_AUTOARRANGE 按 0x0001 读，判定「自动排列关着」，结论**完全反了**：
//   0x0001 是 LVS_REPORT（报表视图），LVS_AUTOARRANGE 是 0x0100。这个教训写进断言。
ok('desktop_icons.rs 有 LVS_AUTOARRANGE = 0x0100（**不是** 0x0001，那是 LVS_REPORT）',
  rustU32Const(diSrc, 'LVS_AUTOARRANGE') === 0x0100);
ok('LVS_AUTOARRANGE 没有被写成 0x0001',
  rustU32Const(diSrc, 'LVS_AUTOARRANGE') !== 0x0001);
ok('FLAG_AUTOARRANGE = 0x1（FOLDERFLAGS 的自动排列位）',
  rustU32Const(diSrc, 'FLAG_AUTOARRANGE') === 0x1);
ok('FLAG_SNAPTOGRID = 0x4（FOLDERFLAGS 的对齐网格位）',
  rustU32Const(diSrc, 'FLAG_SNAPTOGRID') === 0x4);

// 只清我们拥有的两位 —— 多清一位就是「悄悄改用户的桌面偏好」，而且不可逆（备份只有一份）。
ok('flags_cleared 只清自己那两位（`& !(FLAG_AUTOARRANGE | FLAG_SNAPTOGRID)`）',
  /fn flags_cleared\(flags: u32\) -> u32 \{[\s\S]{0,200}?flags & !\(FLAG_AUTOARRANGE \| FLAG_SNAPTOGRID\)/.test(diSrc),
  '改成 `& !FLAG_AUTOARRANGE` 就会把「对齐网格」也清掉');
ok('有单测锁「只清这两位」（`flags_cleared_only_touches_the_two_bits_we_own`）',
  /fn flags_cleared_only_touches_the_two_bits_we_own/.test(diSrc));
ok('有单测锁「其余位原样保留」（只清位不够，还得证明没清别的）',
  /assert_eq!\(\s*cleared,\s*real & !0x5,\s*"只许动 0x1\|0x4 两位/.test(diSrc),
  '断言写成「只检查被清的位」就漏掉了「顺手清了别的偏好」这种错');
ok('单测用的是**本机实测真值** 0x40200225（不是编一个整齐的数）',
  /let real = 0x4020_0225u32;/.test(diSrc));
ok('有单测锁 pack_point / unpack_point 往返（`MAKELPARAM` 两个 i16）',
  /fn pack_point_roundtrips/.test(diSrc) && /unpack_point\(pack_point\(/.test(diSrc));
ok('有单测锁 pack_point 的位序（`(y << 16) | x` —— 写反了图标会飞）',
  /fn pack_point_matches_makelparam_bit_layout/.test(diSrc) &&
    /pack_point\(0x1234, 0x5678\)\)?,? ?0x5678_1234/.test(diSrc));
ok('desktop_icons.rs 单测数 ≥ 4', (diSrc.match(/#\[test\]/g) ?? []).length >= 4);

/* ================================================================== *
 * ② 跨进程：每一步都有「不这么写就静默挂死 / 泄漏」的理由
 * ================================================================== */

ok('发消息走 SendMessageTimeoutW（不是裸 SendMessageW）',
  /SendMessageTimeoutW\(/.test(diSrc) && !/[^A-Za-z]SendMessageW\(/.test(diSrc),
  '裸 SendMessage 会同步等 Explorer 的 UI 线程 —— 它一忙，我们的窗口一起冻住');
ok('带 SMTO_ABORTIFHUNG（Explorer 挂起时立刻放弃，不陪着一起挂）',
  /SMTO_ABORTIFHUNG/.test(diSrc));
ok('远端内存有 impl Drop（否则每次快照泄漏一块 Explorer 进程内存）',
  /impl Drop for RemoteMem/.test(diSrc));
ok('Drop 里 VirtualFreeEx + CloseHandle 配对释放',
  /impl Drop for RemoteMem \{[\s\S]{0,400}?VirtualFreeEx\(/.test(diSrc) &&
    /impl Drop for RemoteMem \{[\s\S]{0,400}?CloseHandle\(/.test(diSrc));
ok('LVITEMW 的 x64 偏移写清楚了（pszText@24 / cchTextMax@32）',
  /pszText@24 \/ cchTextMax@32/.test(diSrc),
  '偏移错一个字段，拿到的是别的内存 —— 不报错，只是名字变成乱码或空串');
ok('LVM_SETITEMPOSITION 用 pack_point 打包（lParam 是**纯值**，不是指针 ⇒ 才能跨进程）',
  /let packed = pack_point\(x, y\);[\s\S]{0,400}?LVM_SETITEMPOSITION/.test(diSrc),
  '★ 顺序不能反：必须先打包再发消息；写成「先发消息再打包」等于把上一条的数据发出去');
ok('LVM_GETITEMPOSITION 走远端内存（lParam 是指针 ⇒ 必须跨进程分配）',
  /LVM_GETITEMPOSITION/.test(diSrc) &&
    /LVM_GETITEMPOSITION[\s\S]{0,400}?RemoteMem|RemoteMem[\s\S]{0,600}?LVM_GETITEMPOSITION/.test(diSrc));

/* ================================================================== *
 * ③ 单写路：一个跨线程状态只许一个记账人（V61 教训）
 * ================================================================== */

// V61：两条写路 ⇒ 双击失效（右键好使、左键不好使）。B 模式开关同理：
// 「库里开了、内存里还没开」的窗口期就是「开关点了没反应」。
ok('镜像有「未知」哨兵（避免每 25ms 轮询都开一次 SQLite）',
  /const ICON_CONTROL_UNKNOWN: u8 = 255;/.test(cmdSrc) &&
    /AtomicU8::new\(ICON_CONTROL_UNKNOWN\)/.test(cmdSrc));
ok('icon_control_runtime 首次调用从库里懒加载一次',
  /fn icon_control_runtime\(app: &AppHandle\) -> bool \{[\s\S]{0,400}?ICON_CONTROL_UNKNOWN =>/.test(cmdSrc));
ok('写库路径同步更新镜像（set_icon_control_runtime 在改库那里被调用）',
  /set_icon_control_runtime\(true\)/.test(giSrc) &&
    /set_icon_control_runtime\(false\)/.test(giSrc));
{
  // 全仓只有 grid_icons.rs 一个记账人（这条是 V61 的直接产物）。
  // grid.rs 里出现 2 次：一次是 `fn set_icon_control_runtime` 定义，一次是
  // `icon_control_runtime` 懒加载分支里的自调 —— 两处都在**同一个模块内**，仍然是单写路。
  const acct = (src) => (src.match(/set_icon_control_runtime\(/g) ?? []).length;
  ok('全仓只有 grid_icons.rs 写 B 模式镜像（单一记账人）',
    acct(giSrc) === 2 && acct(cmdSrc) === 2,
    `grid_icons 调用 ${acct(giSrc)} 次（应为 2：开 / 关）/ grid.rs 出现 ${acct(cmdSrc)} 次（应为 2：定义 + 懒加载自调）`);
  // 反过来也要锁：不许出现「另一条绕过镜像、直接写库」的路。
  ok('没有第二条绕过镜像直写 META_ICON_CONTROL 的路（只许 grid_icons.rs 写）',
    (giSrc.match(/meta_set\(&conn, META_ICON_CONTROL/g) ?? []).length === 1 &&
      (cmdSrc.match(/meta_set\([^)]*META_ICON_CONTROL/g) ?? []).length === 0);
}

/* ================================================================== *
 * ④ 让路：B 模式下图标**绝不**被我们藏起来
 * ================================================================== */

ok('takeover_icons 在 B 模式下直接返回 false（不隐藏图标）',
  /fn takeover_icons\(app: &AppHandle, hidden: bool\) -> bool \{[\s\S]{0,600}?if hidden && icon_control_runtime\(app\) \{\s*return false;/.test(cmdSrc));
ok('reassert_takeover 在 B 模式下直接 return（漏了会每 3 秒藏一次用户图标）',
  /fn reassert_takeover\(app: &AppHandle\) \{[\s\S]{0,400}?if icon_control_runtime\(app\) \{[\s\S]{0,200}?return;/.test(cmdSrc));
ok('reassert_takeover 让路时清掉保险丝计数（否则计数只增不减）',
  /fn reassert_takeover\(app: &AppHandle\) \{[\s\S]{0,400}?TAKEOVER_FIXES\.store\(0/.test(cmdSrc));
{
  // 顺序：B 模式判断必须在**真正去隐藏**之前 —— 反了就等于没拦。
  const fnAt = cmdSrc.indexOf('fn takeover_icons(app: &AppHandle, hidden: bool) -> bool {');
  const guardAt = cmdSrc.indexOf('if hidden && icon_control_runtime(app)', fnAt);
  const applyAt = cmdSrc.indexOf('desktop_icons_apply(hidden)', fnAt);
  ok('takeover_icons 里「B 模式让路」在「执行隐藏」**之前**',
    fnAt >= 0 && guardAt > fnAt && applyAt > guardAt,
    `fn@${fnAt} guard@${guardAt} apply@${applyAt}`);
}
ok('开启 B 模式时立刻把图标还给系统（保险：上一版可能还藏在接管态）',
  /set_icon_control_runtime\(true\);[\s\S]{0,600}?restore_desktop_icons\(/.test(giSrc));

/* ================================================================== *
 * ⑤ 几何共用一份：底板画到哪 == 图标摆到哪
 * ================================================================== */

ok('b_icon_arg_for_spacing = spacing_y - BOX_CELL_EXTRA_H（这样 cell_h 恰好等于 Explorer 间距）',
  /fn b_icon_arg_for_spacing\(spacing_y: i32\) -> i64 \{\s*\(i64::from\(spacing_y\) - BOX_CELL_EXTRA_H\)\.max\(16\)/.test(cmdSrc));
ok('b_content_frame 的 origin_dy 用常量表达式（写死数字就与前端脱钩）',
  /origin_dy: BOX_HEADER_H \+ BOX_BORDER_H \+ GRID_PAD_Y,/.test(cmdSrc),
  '前端装不下时按同一条式子算内容区，任一处改成字面量就会错位');
ok('b_content_frame 的 cell_h 直接用 Explorer 间距（不是自己拍一个常数）',
  /cell_h: i64::from\(spacing_y\)\.max\(CELL_EXTRA_H\),/.test(cmdSrc));
ok('b_content_frame 的 cell_w 只宽不窄（`arg.clamp(16,256) + CELL_EXTRA_W`）',
  /cell_w: arg\.clamp\(16, 256\) \+ CELL_EXTRA_W,/.test(cmdSrc));
ok('两处半径常数不相等这件事写在注释里（免得后人想「顺手对齐」）',
  /CELL_EXTRA_W[\s\S]{0,400}BOX_CELL_EXTRA_H[\s\S]{0,200}不相等/.test(cmdSrc) ||
    /两个常数（\[`CELL_EXTRA_W`\] \/ \[`BOX_CELL_EXTRA_H`\]）又不相等/.test(cmdSrc));
ok('摆位从 b_icon_arg_for_spacing 取基准（与布局引擎同源）',
  /let arg = crate::commands::grid::b_icon_arg_for_spacing\(spacing\.1\);/.test(giSrc));
ok('摆位用 b_content_frame 算格内网格（不许自己算一套）',
  /let frame = crate::commands::grid::b_content_frame\(bw, bh, arg, spacing\.1\);/.test(giSrc));
ok('图标坐标 = 工作区 + 格子位置 + 内容原点（与底板同一条式子）',
  /i64::from\(work_x\) \+ bx \+ frame\.origin_dx \+ col \* frame\.cell_w/.test(giSrc) &&
    /i64::from\(work_y\) \+ by \+ frame\.origin_dy \+ row \* frame\.cell_h/.test(giSrc));
ok('图标坐标换算到列表框客户区（图标坐标是相对它的）',
  /screen_x - i64::from\(client_x\)/.test(giSrc) && /window_client_origin\(list\)/.test(giSrc));
ok('布局引擎真的读了 B 模式的 icon 基准（否则底板与图标两套尺寸）',
  /b_icon_arg\(conn\)/.test(cmdSrc));

/* ================================================================== *
 * ⑥ 开 / 关的副作用：顺序 + 只写一次 + 原值还原
 * ================================================================== */

{
  const at = (needle) => giSrc.indexOf(needle);
  const snap = at('if meta_get(&conn, META_POS_BACKUP).is_none()');
  const ffbak = at('if meta_get(&conn, META_FFLAGS_BACKUP).is_none()');
  const setaa = at('di::set_autoarrange(list, false);');
  const wrff = at('di::write_folder_flags(cleared)');
  ok('开启顺序：快照 → 备份 FFlags → 关自动排列 → 写注册表',
    snap > 0 && ffbak > snap && setaa > ffbak && wrff > setaa,
    `snap@${snap} ffbak@${ffbak} setaa@${setaa} wrff@${wrff}`);
  ok('先动当前视图（立刻生效）再写注册表（重启后仍生效）',
    setaa > 0 && wrff > setaa);
}
ok('快照只在「还没有」时存（反复开关不许覆盖掉原始布局）',
  /if meta_get\(&conn, META_POS_BACKUP\)\.is_none\(\)/.test(giSrc));
ok('FFlags 备份也只在「还没有」时存（同理）',
  /if meta_get\(&conn, META_FFLAGS_BACKUP\)\.is_none\(\)/.test(giSrc));
{
  const at = (needle) => giSrc.indexOf(needle);
  const setaa = at('di::set_autoarrange(list, di::flags_autoarrange_on(flags));');
  const wrff = at('let _ = di::write_folder_flags(flags);');
  ok('关闭顺序：先恢复 LVS_AUTOARRANGE 位，再写回备份 FFlags',
    setaa > 0 && wrff > setaa, `setaa@${setaa} wrff@${wrff}`);
}
ok('关闭时还原的是**备份的原值**（不是硬编码 true —— 决策 3：原值还原）',
  /set_autoarrange\(list, di::flags_autoarrange_on\(flags\)\)/.test(giSrc) &&
    /flags_autoarrange_on\(flags\)/.test(giSrc),
  '硬编码 `true` 会把「本来就没开自动排列」的用户改成开着');
ok('关闭时清掉开关与间距（否则下次启动还以为在 B 模式）',
  /meta_clear\(&conn, META_ICON_CONTROL\);/.test(giSrc) &&
    /meta_clear\(&conn, META_SPACING_Y\);/.test(giSrc));
ok('apply 在未开启时**拒绝**（不许悄悄动用户桌面）',
  /fn desktop_icon_layout_apply\(app: AppHandle\)[\s\S]{0,400}?META_ICON_CONTROL\)\.as_deref\(\) != Some\("1"\)[\s\S]{0,200}?return Err\(/.test(giSrc));
ok('restore 在没快照时**拒绝**（并说清原因）',
  /META_POS_BACKUP\)[\s\S]{0,200}?没有可还原的快照/.test(giSrc) ||
    /ok_or_else\(\|\| "没有可还原的快照（从未开启过 B 模式）"\.to_string\(\)\)/.test(giSrc));
ok('restore 用的是快照里的原坐标（`(idx, *x, *y)` 原样回填）',
  /\.map\(\|\(idx, \(x, y\)\)\| \(idx, \*x, \*y\)\)/.test(giSrc));
ok('名字匹配同时登记「带扩展名」与「不带扩展名」（显示名取决于用户偏好）',
  /if let Some\(\(stem, _\)\) = key\.rsplit_once\('\.'\)/.test(giSrc) &&
    /key\.rsplit_once\('\.'\)[\s\S]{0,300}?index_of\.get\(stem\)/.test(giSrc));
ok('对不上的条目只计数、不算失败（`unmatched` 透给 UI 说实话）',
  /unmatched \+= 1;\s*continue;/.test(giSrc) && /unmatched/.test(typesSrc));

/* ================================================================== *
 * ⑦ 命令注册与前端接线
 * ================================================================== */

ok('lib.rs 注册了 4 条 B 模式命令',
  ['desktop_icon_control_get', 'desktop_icon_control_set',
    'desktop_icon_layout_apply', 'desktop_icon_layout_restore']
    .every((name) => libSrc.includes(`commands::grid_icons::${name}`)));
ok('ipc.ts 有 4 个方法',
  ['desktopIconControlGet', 'desktopIconControlSet',
    'desktopIconLayoutApply', 'desktopIconLayoutRestore']
    .every((name) => new RegExp(`${name}:`).test(ipcSrc)));
ok('types/grid.ts 有 IconControlStatus', /export interface IconControlStatus/.test(typesSrc));
ok('前端读不到状态时按「关」处理（fail-safe：默认保持旧行为）',
  /const ICON_CONTROL_OFF: IconControlStatus = \{/.test(managerSrc) &&
    /setIconControl\(ICON_CONTROL_OFF\)/.test(managerSrc));
ok('开关**必须**二次确认（开启会写图标位置 + 改注册表，不能不问就动）',
  /const toggleIconControl = useCallback\(async \(\): Promise<void> => \{[\s\S]{0,600}?await confirmAction\(/.test(managerSrc));
ok('确认文案里说清了「文件一个字节都不会动」',
  /文件本身\*\*一个字节都不会动\*\*/.test(managerSrc));
ok('确认文案里说清了「会自动排列 / 对齐网格」且「退出时还原原值」',
  /自动排列 \/ 对齐网格[\s\S]{0,80}?退出时会还原原值/.test(managerSrc));
ok('确认文案里说清了「有快照可一键还原」',
  /存一份快照\*\*，随时可一键还原/.test(managerSrc));
ok('管理页有「还原图标布局」手动入口（决策 2：快照不能只是躺在库里的一串数字）',
  /const restoreIconLayout = useCallback/.test(managerSrc) &&
    /ipc\.desktopIconLayoutRestore\(\)/.test(managerSrc));
ok('还原入口只在**确实存过快照**时出现（没快照还摆一个点了报错的按钮更糟）',
  /\{iconControl\.snapshot > 0 && \(/.test(managerSrc));
ok('还原也要二次确认（它会动桌上每一个图标的位置）',
  /const restoreIconLayout = useCallback\(async \(\): Promise<void> => \{[\s\S]{0,700}?await confirmAction\(/.test(managerSrc));
ok('还原**不动**开关状态（用户可能只想看一眼原样，再让我们摆回去）',
  /还原\*\*不动\*\* B 模式开关/.test(managerSrc) &&
    !/const restoreIconLayout[\s\S]{0,900}?desktopIconControlSet/.test(managerSrc));
ok('关闭开关的提示不说谎（只说还原偏好，不说还原位置）',
  /自动排列 \/ 对齐网格还原成原值；图标位置会保留/.test(managerSrc));

ok('GridOverlay 在 B 模式下不画图标（原生图标就在下面，重复画两份）',
  /\{!iconControl && boxItems\.map\(/.test(overlaySrc));
ok('GridOverlay 在 B 模式下格子内容区穿透（双击 / 右键 / 拖拽原生图标全可用）',
  /pointerEvents: iconControl \? 'none' : undefined,/.test(overlaySrc));
ok('GridOverlay 在 B 模式下不渲染「未归类」竖条（原生图标本来就看得见，纯冗余）',
  /\{!contentHidden && takeover\?\.enabled === true && !iconControl && loose !== null/.test(overlaySrc));
// ★ 下面三条是「原生图标可点」的**另一条腿**：`pointerEvents:none` 只解决窗口**内部**的
// 转发，真正决定「这个点归谁」的是 Rust 那条 25ms 命中轮询
// （`let want = interactive || cursor_hit(&win)`）。命中区不收窄，窗口就一直吃点击。
ok('B 模式下不上报「整窗」命中区（否则 Rust 把整窗切回可交互 ⇒ 原生图标点不着）',
  /if \(!contentHidden\) \{[\s\S]{0,900}?if \(!iconControl\) \{[\s\S]{0,300}?width: window\.innerWidth \* scaleFactor,/.test(overlaySrc),
  '整窗命中区还在 ⇒ 桌面空白处仍是我们的窗口吃点击 ⇒ 原生右键菜单永远弹不出来');
ok('B 模式下每个格子只报**标题栏**那一条（内容区整片交还桌面）',
  /height: \(BOX_HEADER_H \+ BOX_BORDER_H\) \* scaleFactor,/.test(overlaySrc),
  '多报 1px 就有一个像素点的原生图标点不着');
ok('B 模式下不再报格子的整块矩形（内容区必须穿透）',
  /if \(iconControl\) \{[\s\S]{0,1200}?continue;/.test(overlaySrc));
ok('regionsKey 含 iconControl（切换模式必须重报命中区，否则切完还是点不着）',
  /\|ic=\$\{iconControl \? '1' : '0'\}/.test(overlaySrc));
ok('命中区依赖数组含 iconControl',
  /\[regionsKey, scaleFactor, contentHidden, iconControl\]/.test(overlaySrc));
// B 模式下「拖文件进格子」的落点只剩标题栏（内容区已交还桌面），必须告诉用户 ——
// 否则按老习惯往格子中间拖，文件被 Explorer 当成「丢到桌面空白处」，看起来像没反应。
ok('B 模式下标题栏提示写明了「拖到这里 = 登记进格子」（落点只剩这条，不说用户会以为坏了）',
  /iconControl\s*\?\s*'把文件拖到这条标题栏上 = 登记进这个格子/.test(overlaySrc));
// 命中区外扩（`cursor_hit_windows` 里的 ±HIT_PADDING）也必须算进来：它补的是
// 「离散采样 vs 连续移动」的时间窗，但代价是命中矩形四边各胖一圈。B 模式下我们报的
// 标题栏条**紧贴**内容区，这一圈如果大过内容区上内边距，就会啃掉第一行图标的最上面几像素。
// 不变量：HIT_PADDING < GRID_PAD_Y（外扩一圈必须落在内边距里）—— 两边都是裸常量，
// 谁调大一点都不会编译报错，只能靠这条守。
ok('命中区外扩 HIT_PADDING 小于内容区上内边距 GRID_PAD_Y（否则会啃到第一行图标）',
  rustF64Const(cmdSrc, 'HIT_PADDING') < rustI64Const(cmdSrc, 'GRID_PAD_Y'),
  `HIT_PADDING=${rustF64Const(cmdSrc, 'HIT_PADDING')} GRID_PAD_Y=${rustI64Const(cmdSrc, 'GRID_PAD_Y')}`
    + ' —— 标题栏条 (BOX_HEADER_H+BOX_BORDER_H) 下面还有这一圈外扩，'
    + '它必须小于内容区上内边距，否则第一行原生图标的最上面几像素点不着');
ok('Rust 侧确实还在用外扩矩形做命中测试（说明上一条不是空断言）',
  /rel_x >= r\.x - HIT_PADDING[\s\S]{0,200}?rel_y <= r\.y \+ r\.height \+ HIT_PADDING/.test(cmdSrc));
ok('GridOverlay 轮询读 B 模式状态（管理页是另一个窗口，没有通用事件总线）',
  /desktopIconControlGet\(\)/.test(overlaySrc));
ok('GridOverlay 初值是 false（读不到就按 V101 的老行为跑，不许默认接管）',
  /const \[iconControl, setIconControl\] = useState\(false\);/.test(overlaySrc));
{
  // 摆位必须**挂在重排之后** —— 反过来就是「按新格子算坐标、按旧格子画底板」。
  const idx = overlaySrc.indexOf('desktopIconLayoutApply()');
  const thenIdx = overlaySrc.lastIndexOf('.then(', idx);
  ok('摆位调用挂在上次重排（relayoutSoon）之后',
    idx > 0 && thenIdx > 0 && idx - thenIdx < 200,
    `then@${thenIdx} apply@${idx}`);
  ok('摆位受 B 模式开关约束（没开就完全不调）',
    /iconControl \? ipc\.desktopIconLayoutApply\(\) : Promise\.resolve\(null\)/.test(overlaySrc));
}

/* ================================================================== *
 * ⑧ 红线：整理的是**位置**，不是文件
 * ================================================================== */

// V37 / V48：整条链路不允许动文件。这里把 B 模式新增的两个文件单独再锁一遍
// （grid.rs 那边已有专门的断言，但新文件容易忘了自己也在红线内）。
ok('desktop_icons.rs / grid_icons.rs 里没有 fs::rename',
  !/fs::rename/.test(diSrc) && !/fs::rename/.test(giSrc));
ok('desktop_icons.rs / grid_icons.rs 里没有删文件 / 删目录',
  !/remove_file|remove_dir/.test(diSrc) && !/remove_file|remove_dir/.test(giSrc));
ok('desktop_icons.rs / grid_icons.rs 里没有复制文件',
  !/fs::copy/.test(diSrc) && !/fs::copy/.test(giSrc));
ok('遥控只动位置：没有 LVM_DELETEITEM / LVM_INSERTITEM（那是「动内容」）',
  !/LVM_DELETEITEM|LVM_INSERTITEM/.test(diSrc));
ok('写入桌面列表框的只有 LVM_SETITEMPOSITION 与 SetWindowLongPtrW（改样式位）',
  /set_positions[\s\S]{0,600}?LVM_SETITEMPOSITION/.test(diSrc) &&
    /SetWindowLongPtrW\(list, GWL_STYLE/.test(diSrc));

/* ================================================================== *
 * 结果
 * ================================================================== */

console.log(`PASS ${pass} / FAIL ${fail}`);
if (bad.length > 0) {
  console.log('--- 失败明细 ---');
  for (const item of bad) {
    console.log('  ✗ ' + item);
  }
}
process.exit(fail === 0 ? 0 : 1);
