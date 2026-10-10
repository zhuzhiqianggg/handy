/**
 * 「桌面整理 = 遥控原生图标」的回归守卫（V102 新增，**Step 4 全面改写**）。
 *
 * # 为什么必须锁
 *
 * V42–V101 六十批全耗在「接管桌面」这一条路线上（藏 `SysListView32` + 自绘图标 +
 * 复刻 Explorer 的 Z 序 / Win+D / 自愈 / ShellNew / 就地改名）。这条路线的每一环都
 * **没有公开接口**，只能靠事件嗅探 + 轮询 + 竞速去猜，于是「修一个、坏一个」，
 * 六十批没收敛（用户 10-10：我们修复优化了太多次数了）。
 *
 * 现在换根：**图标永远归 Explorer**，我们只做「算坐标 + 画装饰底板 + 遥控位置」。
 * 这条路线的正确性不靠「跑起来看着对」，而是靠三条**必须显式**的性质：
 *
 *   ① **图标不被我们藏** —— 一旦还能藏，就回到「自己扮 Explorer」，全套坑原样搬回来。
 *      Step 4 起这条被推到极致：`takeover_icons` 恒不隐藏、`reassert_takeover` 空转、
 *      连 `grid_desktop_icons_set`（那个「一次性藏一下」的入口）都降级成幂等恢复 ——
 *      **能力删掉比约束住更可靠**（约束靠人记得，删掉不靠任何人的记忆）；
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
const MIGRATIONS = 'src-tauri/src/db/migrations.rs';
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

/**
 * 读文件；读不到直接记 FAIL 并把内容当空串，后续断言会连带暴露。
 *
 * ⚠️ **必须把 CRLF 归一化成 LF**：本仓源码是 `\r\n`（Windows 检出），而 JS 的 `.` 不匹配
 * `\r`、`$` 不带 `m` 时只认整串末尾 —— 于是 `\/\/.*$` 这类「去行注释」的正则**一条都匹配不上**，
 * 注释里的样本会带进断言（本次就踩到：`desktop_icons_apply(true)` 明明在注释里，
 * 却被当成真代码命中）。归一化之后所有断言面对的都是同一种换行。
 */
function read(rel) {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
  } catch (err) {
    ok(`能读到 ${rel}`, false, String(err.message));
    return '';
  }
}

/** 去掉行注释，避免断言命中注释里的样本（假通过 / 假失败都来自这里）。 */
function stripLineComments(src) {
  return src
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

const diSrc = read(DESKTOP_ICONS);
const giSrc = read(GRID_ICONS);
const giCode = stripLineComments(giSrc);
const cmdSrc = read(RUST_CMD);
const cmdCode = stripLineComments(cmdSrc);
const libSrc = read(LIB_RS);
const migSrc = read(MIGRATIONS);
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

// 只清我们拥有的两位 —— 多清一位就是「悄悄改用户的桌面偏好」，而备份只有一份。
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
 * ③ 接管退场：**没有任何路径能把图标藏起来**（Step 4 的核心不变量）
 * ================================================================== */

// 这一组是 Step 4 的题眼。旧版本守的是「B 模式开关打开时让路」，现在是**根本没有开关、
// 也根本没有「藏」这个动作** —— 断言必须跟着从「有条件让路」升级到「无条件不存在」。
{
  // 全仓唯一允许「隐藏/恢复」图标的地方是 `desktop_icons_apply`，而它**只允许以 false 调用**。
  // `apply(true)` 一旦出现，就是接管从后门回来了。
  const applyTrue = cmdCode.match(/desktop_icons_apply\(true\)/g) ?? [];
  ok('全仓没有 `desktop_icons_apply(true)`（接管从后门回来 = 全套坑原样搬回）',
    applyTrue.length === 0,
    `命中 ${applyTrue.length} 处`);
  ok('`desktop_icons_apply(false)` 还在（它是「工具」本身：把历史残留的隐藏恢复掉）',
    (cmdCode.match(/desktop_icons_apply\(false\)/g) ?? []).length >= 2,
    '全删掉的话，老库里被藏过的图标就没人恢复得了');
}

ok('takeover_icons 恒返回 false（图标永远不被我们藏）',
  /fn takeover_icons\(app: &AppHandle, hidden: bool\) -> bool \{[\s\S]{0,900}?\n    false\n\}/.test(cmdSrc));
ok('takeover_icons 不再引用 icon_control 镜像（开关已退场）',
  !/fn takeover_icons[\s\S]{0,900}?icon_control_runtime/.test(cmdSrc));
ok('reassert_takeover 已空转（体里没有「再去藏一次」）',
  /fn reassert_takeover\(app: &AppHandle\) \{[\s\S]{0,900}?\n\}/.test(cmdSrc) &&
    !/fn reassert_takeover\(app: &AppHandle\) \{[\s\S]{0,900}?desktop_icons_apply/.test(cmdSrc),
  '漏掉的话会每 3 秒把用户的原生图标藏一次 —— 正是 V45 那类「桌面全空」事故');
ok('reassert_takeover 清掉保险丝计数（否则计数只增不减）',
  /fn reassert_takeover\(app: &AppHandle\) \{[\s\S]{0,500}?TAKEOVER_FIXES\.store\(0/.test(cmdSrc));
ok('`grid_desktop_icons_set` 降级成「只恢复不隐藏」（它是最后一个能藏图标的入口）',
  /pub async fn grid_desktop_icons_set\(app: AppHandle, hidden: bool\)[\s\S]{0,600}?desktop_icons_apply\(false\)/.test(cmdSrc),
  '★ 能力删掉比约束住更可靠：留一个能藏的入口，V45「桌面全空」随时能从这儿回来');
ok('`apply_takeover_pref` 不再依偏好隐藏（只剩「确保可见」）',
  /fn apply_takeover_pref\(app: &AppHandle\) \{[\s\S]{0,500}?takeover_icons\(app, false\)/.test(cmdSrc) &&
    !/fn apply_takeover_pref[\s\S]{0,500}?takeover_icons\(app, true\)/.test(cmdSrc));
ok('一键整理不再顺手藏图标（`report.icons_hidden = false`）',
  /report\.icons_hidden = false;/.test(cmdSrc) &&
    !/report\.icons_hidden = takeover_icons/.test(cmdCode));
ok('启动自愈 heal_desktop_icons 仍在（老库被藏过的图标要有人还回去）',
  /pub fn heal_desktop_icons\(app: &AppHandle\)/.test(cmdSrc));
ok('启动自愈按**实际可见性**兜底（标记被迁移清掉时也恢复得了）',
  /fn heal_desktop_icons\(app: &AppHandle\) \{[\s\S]{0,900}?desktop_icons_visible\(\)/.test(cmdSrc));

{
  // 迁移 v12：三个「接管时代」的键退场；三个「还要用」的键一个都不许碰。
  ok('迁移 v12 存在并挂进 MIGRATIONS',
    /V12_DROP_TAKEOVER_KEYS/.test(migSrc) && /\(12, V12_DROP_TAKEOVER_KEYS\)/.test(migSrc));
  ok('v12 清掉 desktop_takeover / desktop_icons_hidden / icon_control',
    /DELETE FROM grid_meta WHERE key IN \('desktop_takeover', 'desktop_icons_hidden', 'icon_control'\);/.test(migSrc));
  const v12 = migSrc.slice(migSrc.indexOf('pub const V12_DROP_TAKEOVER_KEYS'));
  const v12Body = v12.slice(0, v12.indexOf('";', v12.indexOf('= "')));
  for (const keep of ['overlay_visible', 'icon_pos_backup', 'fflags_backup']) {
    ok(`v12 **不许**清 ${keep}（它还有用）`,
      !v12Body.includes(keep),
      'overlay_visible = 唯一真源；icon_pos_backup = 「还原图标布局」的凭据；fflags_backup = 自动排列原值');
  }
}

/* ================================================================== *
 * ④ 启动装配：幂等、只写一次、顺序对
 * ================================================================== */

ok('`ensure_native_layout` 存在且是 pub（lib.rs 启动路径要调它）',
  /pub fn ensure_native_layout\(app: &AppHandle\)/.test(giCode));
{
  const iEnsure = libSrc.indexOf('grid_icons::ensure_native_layout(app.handle())');
  const iRestore = libSrc.indexOf('grid::restore_overlay_if_visible(app.handle())');
  ok('lib.rs 启动期调了 ensure_native_layout',
    iEnsure > 0);
  ok('装配在 `restore_overlay_if_visible` **之前**（那一步会让前端重排，重排要读间距）',
    iEnsure > 0 && iRestore > iEnsure,
    `ensure@${iEnsure} restore@${iRestore}`);
  ok('装配在 `heal_desktop_icons` **之后**（先把历史残留的隐藏还回去，再谈摆位）',
    iEnsure > libSrc.indexOf('grid::heal_desktop_icons(app.handle())'));
}
{
  const at = (needle) => giCode.indexOf(needle);
  const snap = at('if meta_get(&conn, META_POS_BACKUP).is_none()');
  const ffbak = at('if meta_get(&conn, META_FFLAGS_BACKUP).is_none()');
  const setaa = at('di::set_autoarrange(list, false);');
  const wrff = at('di::write_folder_flags(cleared)');
  const spac = at('meta_set(&conn, META_SPACING_Y');
  ok('装配顺序：快照 → 备份 FFlags → 关自动排列 → 写注册表 → 记间距',
    snap > 0 && ffbak > snap && setaa > ffbak && wrff > setaa && spac > wrff,
    `snap@${snap} ffbak@${ffbak} setaa@${setaa} wrff@${wrff} spac@${spac}`);
  ok('先动当前视图（立刻生效）再写注册表（重启后仍生效）',
    setaa > 0 && wrff > setaa);
}
ok('快照只在「还没有」时存（反复启动不许覆盖掉原始布局）',
  /if meta_get\(&conn, META_POS_BACKUP\)\.is_none\(\)/.test(giCode));
ok('FFlags 备份也只在「还没有」时存（同理）',
  /if meta_get\(&conn, META_FFLAGS_BACKUP\)\.is_none\(\)/.test(giCode));
ok('找不到桌面图标视图时**不算失败**、静默返回（Explorer 没跑也可能）',
  /pub fn ensure_native_layout\(app: &AppHandle\) \{[\s\S]{0,400}?let Ok\(list\) = listview\(\) else \{\s*return;/.test(giCode));
ok('装配同时兜底「把历史残留的隐藏还给系统」',
  /pub fn ensure_native_layout\(app: &AppHandle\) \{[\s\S]{0,2400}?restore_desktop_icons\(app\)/.test(giCode));

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
ok('b_icon_arg **不再**看 `icon_control`（开关退场，只看「间距测到没有」）',
  !/fn b_icon_arg\(conn: &Connection\)[\s\S]{0,600}?icon_control/.test(cmdSrc));

/* ================================================================== *
 * ⑥ 摆位与还原：什么时候动、动多少、还原什么
 * ================================================================== */

ok('摆位命令**不再**用开关做闸门（Step 4 起恒生效）',
  !/fn desktop_icon_layout_apply\(app: AppHandle\)[\s\S]{0,500}?META_ICON_CONTROL/.test(giCode));
ok('restore 在没快照时**拒绝**（并说清原因）',
  /没有可还原的快照/.test(giSrc));
ok('restore 用的是快照里的原坐标（`(idx, *x, *y)` 原样回填）',
  /\.map\(\|\(idx, \(x, y\)\)\| \(idx, \*x, \*y\)\)/.test(giSrc));
ok('restore **同时**还原「自动排列」偏好（只还原位置 ⇒ 偏好一开、图标立刻被打散）',
  /fn desktop_icon_layout_restore[\s\S]{0,2000}?set_autoarrange\(list, di::flags_autoarrange_on\(flags\)\)/.test(giSrc),
  '决策 2 / 3 的合流点：位置与偏好必须绑定 —— ' +
    '单独恢复偏好会立刻把图标打散、「保留位置」这句承诺自动作废');
ok('还原的是**备份的原值**（不是硬编码 true —— 决策 3：原值还原）',
  /set_autoarrange\(list, di::flags_autoarrange_on\(flags\)\)/.test(giSrc) &&
    /fn flags_autoarrange_on\(/.test(diSrc),
  '硬编码 `true` 会把「本来就没开自动排列」的用户改成开着');
ok('名字匹配同时登记「带扩展名」与「不带扩展名」（显示名取决于用户偏好）',
  /if let Some\(\(stem, _\)\) = key\.rsplit_once\('\.'\)/.test(giSrc) &&
    /key\.rsplit_once\('\.'\)[\s\S]{0,300}?index_of\.get\(stem\)/.test(giSrc));
ok('对不上的条目只计数、不算失败（`unmatched` 透给 UI 说实话）',
  /unmatched \+= 1;\s*continue;/.test(giSrc) && /unmatched/.test(typesSrc));

/* ================================================================== *
 * ⑦ 命令注册与前端接线
 * ================================================================== */

ok('lib.rs 注册了 3 条（get / apply / restore）——**没有** set',
  ['desktop_icon_control_get', 'desktop_icon_layout_apply', 'desktop_icon_layout_restore']
    .every((name) => libSrc.includes(`commands::grid_icons::${name}`)) &&
    !libSrc.includes('commands::grid_icons::desktop_icon_control_set'));
ok('ipc.ts 有 3 个方法，**没有** desktopIconControlSet',
  ['desktopIconControlGet', 'desktopIconLayoutApply', 'desktopIconLayoutRestore']
    .every((name) => new RegExp(`${name}:`).test(ipcSrc)) &&
    !/desktopIconControlSet/.test(ipcSrc));
ok('types/grid.ts 有 IconControlStatus', /export interface IconControlStatus/.test(typesSrc));
ok('前端读不到状态时给安全默认（fail-safe）',
  /const ICON_CONTROL_OFF: IconControlStatus = \{/.test(managerSrc) &&
    /setIconControl\(ICON_CONTROL_OFF\)/.test(managerSrc));
ok('管理页**没有**开关按钮（没有 toggleIconControl）',
  !/toggleIconControl/.test(managerSrc),
  '★ 关掉 = 既无原生摆位、也无前端图标（那套渲染已删）⇒ 一排空框。所以不留开关');
ok('管理页只做**状态告知**（说清「图标由系统绘制」）',
  /原生桌面 · 图标由系统绘制/.test(managerSrc));
ok('管理页有「还原图标布局」手动入口（决策 2：快照不能只是躺在库里的一串数字）',
  /const restoreIconLayout = useCallback/.test(managerSrc) &&
    /ipc\.desktopIconLayoutRestore\(\)/.test(managerSrc));
ok('还原入口只在**确实存过快照**时出现（没快照还摆一个点了报错的按钮更糟）',
  /\{iconControl\.snapshot > 0 && \(/.test(managerSrc));
ok('还原也要二次确认（它会动桌上每一个图标的位置）',
  /const restoreIconLayout = useCallback\(async \(\): Promise<void> => \{[\s\S]{0,900}?await confirmAction\(/.test(managerSrc));
ok('还原确认文案说清了「同时恢复自动排列偏好」',
  /同时把「自动排列 \/ 对齐网格」恢复成进入前的那份偏好/.test(managerSrc));
ok('还原后不再调用任何「设置开关」的命令（开关已不存在）',
  !/const restoreIconLayout[\s\S]{0,1200}?desktopIconControlSet/.test(managerSrc));

ok('GridOverlay 的 iconControl 是**常量 true**（Step 4：唯一模式，没有切换）',
  /const iconControl = true;/.test(overlaySrc));
ok('GridOverlay 不再轮询 B 模式状态（模式是常量，没有「切换后要跟上」）',
  !/desktopIconControlGet\(\)/.test(overlaySrc));
ok('GridOverlay 在 B 模式下不画图标（原生图标就在下面，重复画两份）',
  /\{!iconControl && boxItems\.map\(/.test(overlaySrc));
// ⚠️ 这两条**必须锚定到具体那一处**：`pointerEvents: 'none',` 在本文件里出现 4 次
// （根画布 / 格子内容区 / 提示外框 / 预览），写成「文件里存在这个串」就等于**任何一处**
// 穿透都能让两条断言同时变绿 —— 守卫的判别力会被稀释成 0（变异自检当场暴露）。
ok('GridOverlay 在 B 模式下格子内容区穿透（双击 / 右键 / 拖拽原生图标全可用）',
  /getBoxViewMode\(box\.id\) === 'list'[\s\S]{0,900}?pointerEvents: 'none',/.test(overlaySrc),
  '内容区吃点击 =「看得见、点不着」：双击没反应、右键出的是我们的菜单 —— ' +
    'B 方案的全部价值（原生行为一字不改）都建立在穿透上');
ok('根画布整层穿透（空白右键交给 Explorer 原生菜单）',
  /className="fixed inset-0 select-none overflow-hidden"[\s\S]{0,2000}?pointerEvents: 'none',/.test(overlaySrc) &&
    !/pointerEvents: contentHidden \|\| iconControl/.test(overlaySrc),
  '根画布一旦回到「有条件穿透」，空白处的事件就重新落到我们窗口上 —— ' +
    '原生右键菜单（查看 / 排序 / 刷新 / 新建）永远弹不出来');
ok('「未归类」竖条**已不渲染**（Step 5：原生图标一直看得见，竖条纯冗余、白占一列）',
  !/ref=\{looseRef\}/.test(overlaySrc) &&
    /左侧「未归类」竖条已退场/.test(overlaySrc));
// ★ 下面三条是「原生图标可点」的**另一条腿**：`pointerEvents:none` 只解决窗口**内部**的
// 转发，真正决定「这个点归谁」的是 Rust 那条 25ms 命中轮询
// （`let want = interactive || cursor_hit(&win)`）。命中区不收窄，窗口就一直吃点击。
ok('不上报「整窗」命中区（报了 ⇒ Rust 把整窗切回可交互 ⇒ 原生图标点不着）',
  !/width: window\.innerWidth \* scaleFactor/.test(overlaySrc),
  '整窗命中区还在 ⇒ 桌面空白处仍是我们的窗口吃点击 ⇒ 原生右键菜单永远弹不出来');
ok('每个格子只报**标题栏**那一条（内容区整片交还桌面）',
  /height: \(BOX_HEADER_H \+ BOX_BORDER_H\) \* scaleFactor,/.test(overlaySrc),
  '多报 1px 就有一个像素点的原生图标点不着');
ok('不再报格子的整块矩形（`continue` 那条老分支已删）',
  !/if \(iconControl\) \{[\s\S]{0,1200}?continue;/.test(overlaySrc));
ok('regionsKey 里不再有模式位（模式恒定，不可能变）',
  !/\|ic=\$\{iconControl/.test(overlaySrc));
ok('命中区依赖数组里不再有 iconControl',
  !/\[regionsKey, scaleFactor, contentHidden, iconControl\]/.test(overlaySrc) &&
    /\[regionsKey, scaleFactor, contentHidden\]/.test(overlaySrc));
// 拖文件进格子的落点只剩标题栏（内容区已交还桌面），必须告诉用户 ——
// 否则按老习惯往格子中间拖，文件被 Explorer 当成「丢到桌面空白处」，看起来像没反应。
ok('标题栏提示写明了「拖到这里 = 登记进格子」（落点只剩这条，不说用户会以为坏了）',
  /'把文件拖到这条标题栏上 = 登记进这个格子/.test(overlaySrc));
// 命中区外扩（`cursor_hit_windows` 里的 ±HIT_PADDING）也必须算进来：它补的是
// 「离散采样 vs 连续移动」的时间窗，但代价是命中矩形四边各胖一圈。我们报的标题栏条
// **紧贴**内容区，这一圈如果大过内容区上内边距，就会啃掉第一行图标的最上面几像素。
// 不变量：HIT_PADDING < GRID_PAD_Y（外扩一圈必须落在内边距里）—— 两边都是裸常量，
// 谁调大一点都不会编译报错，只能靠这条守。
ok('命中区外扩 HIT_PADDING 小于内容区上内边距 GRID_PAD_Y（否则会啃到第一行图标）',
  rustF64Const(cmdSrc, 'HIT_PADDING') < rustI64Const(cmdSrc, 'GRID_PAD_Y'),
  `HIT_PADDING=${rustF64Const(cmdSrc, 'HIT_PADDING')} GRID_PAD_Y=${rustI64Const(cmdSrc, 'GRID_PAD_Y')}`
    + ' —— 标题栏条 (BOX_HEADER_H+BOX_BORDER_H) 下面还有这一圈外扩，'
    + '它必须小于内容区上内边距，否则第一行原生图标的最上面几像素点不着');
ok('Rust 侧确实还在用外扩矩形做命中测试（说明上一条不是空断言）',
  /rel_x >= r\.x - HIT_PADDING[\s\S]{0,200}?rel_y <= r\.y \+ r\.height \+ HIT_PADDING/.test(cmdSrc));
{
  // 摆位必须**挂在重排之后** —— 反过来就是「按新格子算坐标、按旧格子画底板」。
  const idx = overlaySrc.indexOf('desktopIconLayoutApply()');
  const thenIdx = overlaySrc.lastIndexOf('.then(', idx);
  ok('摆位调用挂在上次重排（relayoutSoon）之后',
    idx > 0 && thenIdx > 0 && idx - thenIdx < 200,
    `then@${thenIdx} apply@${idx}`);
  ok('摆位**无条件**调用（不再有 `iconControl ? … : Promise.resolve(null)` 的三元）',
    /\.then\(\(\) => ipc\.desktopIconLayoutApply\(\)\)/.test(overlaySrc));
}

/* ================================================================== *
 * ⑧ Step 5：「未归类」竖条退场 —— 布局不许再为它预留一列
 * ================================================================== */

ok('布局不再为竖条预留（`let _ = loose_count; let min_x = ARRANGE_MARGIN;`）',
  /let _ = loose_count;\s*\n\s*let min_x = ARRANGE_MARGIN;/.test(cmdSrc),
  '留位的话那条空白列会把所有格子整体往右挤（前端已经不画它了）');
ok('`layout_all_boxes` 里不再调 loose_strip_rect（白算一遍桌面扫描）',
  !/fn layout_all_boxes\([\s\S]{0,900}?loose_strip_rect\(/.test(cmdSrc));
{
  const iFn = cmdSrc.indexOf('fn content_boxes_ignore_the_retired_loose_strip');
  ok('有单测锁「落位不随未归类条目数变化」（旧那条「不压竖条」已因巧合通过，必须换掉）',
    iFn > 0 &&
      /fn content_boxes_ignore_the_retired_loose_strip/.test(cmdSrc) &&
      !/fn content_boxes_stay_clear_of_the_left_loose_strip/.test(cmdSrc));
}

/* ================================================================== *
 * ⑨ 红线：整理的是**位置**，不是文件
 * ================================================================== */

// V37 / V48：整条链路不允许动文件。这里把新增的两个文件单独再锁一遍
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
