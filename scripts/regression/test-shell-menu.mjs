/**
 * 「右键菜单不许改变原生行为」的回归守卫（V58 新增）。
 *
 * # 为什么必须锁
 *
 * 用户 09-21：「为什么我们的整理把桌面图标原始的右键行为改变了…我们只是整理位置，
 * 不能改变桌面默认行为」。查下来的根因**全是静默的**——源码读起来完全合理：
 *
 *   ① `QueryContextMenu(hmenu, 0, 1, 0x7FFF, 0)` —— `uFlags` 传 0，而 Explorer 传的是
 *      `CMF_NORMAL | CMF_EXPLORE`。少一个标志位不会报错、不会 panic，只是菜单里
 *      **默默少几项**；
 *   ② 从不转发 `WM_INITMENUPOPUP` —— Shell 与第三方扩展的子菜单是**懒加载**的，
 *      实测「发送到」只剩一项「蓝牙设备」、「包含到库中」直接显示占位文案
 *      「正在检索库...」；
 *   ③ Shift + 右键被我们自己的 React 菜单抢走 —— 而 Shift + 右键在 Explorer 里是
 *      「扩展菜单」（在此处打开 PowerShell 窗口…），**属于系统语义**。
 *
 * 这三条编译通过、类型正确、单测全绿，只能靠**源码断言**守住。这里锁的就是它们，
 * 外加一条**反向**断言：不许传 `CMF_CANRENAME`。原因是那条「重命名」是 Explorer 的
 * 视图（DefView）自己实现的原位改名，不是菜单命令；我们不是它的视图，传了只会得到
 * 一个点了没反应的项 —— 宁缺毋滥（理由写在 `platform/shell_menu.rs` 顶部）。
 *
 * **解析不到即 FAIL**（不是跳过）：正则没匹配上时本套件必须变红，否则它静默退化成
 * 「永远 PASS」，比没有它更糟（CONVENTIONS「审计脚本解析为空即 FAIL」）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

const SHELL_MENU = 'src-tauri/src/platform/shell_menu.rs';
const RUST_CMD = 'src-tauri/src/commands/grid.rs';
const IPC = 'src/lib/ipc.ts';
const OVERLAY = 'src/modules/desktop-grid/GridOverlay.tsx';

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

const shellMenuSrc = read(SHELL_MENU);
const rustCmdSrc = read(RUST_CMD);
const ipcSrc = read(IPC);
const overlaySrc = read(OVERLAY);

/* ================================================================== *
 * ① 标志位：按 Explorer 的口径传，且不许谎报能改名
 * ================================================================== */

/** 取 Rust 里某个 `const X: u32 = 0x...;` 的数值；取不到返回 null（= 断言会红）。 */
function rustU32Const(src, name) {
  const m = src.match(new RegExp(`const ${name}: u32 = (0x[0-9a-fA-F_]+);`));
  return m === null ? null : Number.parseInt(m[1].replace(/_/g, ''), 16);
}

ok('shell_menu.rs 有 CMF_EXPLORE = 0x4', rustU32Const(shellMenuSrc, 'CMF_EXPLORE') === 0x4);
ok('shell_menu.rs 有 CMF_EXTENDEDVERBS = 0x100',
  rustU32Const(shellMenuSrc, 'CMF_EXTENDEDVERBS') === 0x100);
ok('shell_menu.rs 有 CMF_NORMAL = 0x0（写出来是为了语义清楚）',
  rustU32Const(shellMenuSrc, 'CMF_NORMAL') === 0x0);

const flagsExpr = shellMenuSrc.match(/let mut flags = ([^;]+);/);
ok('能找到 flags 的构造表达式', flagsExpr !== null, '正则没匹配到，源码可能被改过');
if (flagsExpr !== null) {
  const expr = flagsExpr[1];
  ok('flags 含 CMF_EXPLORE（Explorer 弹菜单一定带它）', expr.includes('CMF_EXPLORE'), expr);
  ok('flags 不再裸传 0', !/^\s*0\s*$/.test(expr), expr);
  ok(
    'flags **不含** CMF_CANRENAME（Explorer 的重命名是视图实现的，我们谎报只会得到死项）',
    !expr.includes('CMF_CANRENAME'),
    expr,
  );
}
ok(
  'shell_menu.rs 里根本没有声明 CMF_CANRENAME',
  rustU32Const(shellMenuSrc, 'CMF_CANRENAME') === null,
);
const qcm = shellMenuSrc.match(/QueryContextMenu\(hmenu, 0, 1, 0x7FFF, (\w+)\)/);
ok('QueryContextMenu 传的是算好的 flags 变量，而不是字面量 0', qcm !== null && qcm[1] === 'flags',
  qcm === null ? '正则没匹配到' : qcm[1]);
ok('extended 时补 CMF_EXTENDEDVERBS', /if extended \{\s*flags \|= CMF_EXTENDEDVERBS;/.test(shellMenuSrc));

/* ================================================================== *
 * ② 菜单消息转发：懒加载子菜单全靠它
 * ================================================================== */

ok('shell_menu.rs 引入了 IContextMenu2', /IContextMenu2/.test(shellMenuSrc));
ok('shell_menu.rs 引入了 IContextMenu3', /IContextMenu3/.test(shellMenuSrc));
ok('通过 cast 查 IContextMenu3', /cast::<IContextMenu3>\(\)/.test(shellMenuSrc));
ok('调用 HandleMenuMsg2（IContextMenu3）', /HandleMenuMsg2\(/.test(shellMenuSrc));
ok('调用 HandleMenuMsg（IContextMenu2 兜底）', /HandleMenuMsg\(/.test(shellMenuSrc));
for (const msg of ['WM_INITMENUPOPUP', 'WM_DRAWITEM', 'WM_MEASUREITEM', 'WM_MENUCHAR']) {
  ok(`处理 ${msg}`, new RegExp(msg).test(shellMenuSrc));
}
ok('用 SetWindowLongPtrW 做窗口子类化', /SetWindowLongPtrW\(hwnd, GWLP_WNDPROC/.test(shellMenuSrc));
ok('子类化后**必须还原**（否则宿主窗口过程被永久换掉）',
  (shellMenuSrc.match(/SetWindowLongPtrW\(hwnd, GWLP_WNDPROC/g) ?? []).length >= 2);
ok('未处理的菜单消息原样交回原窗口过程（CallWindowProcW）', /CallWindowProcW\(/.test(shellMenuSrc));
ok('WM_MENUCHAR 命中后自己 return（要回话给系统）', /return result;/.test(shellMenuSrc));
ok('子类化失败不静默（写日志）', /窗口子类化失败/.test(shellMenuSrc));

/* ================================================================== *
 * ③ 命令层 / IPC / 前端：Shift 让回系统，Handy 菜单改 Ctrl
 * ================================================================== */

ok('Rust 命令 shell_context_menu 接受 extended 参数',
  /pub async fn shell_context_menu\(\s*app: AppHandle,\s*path: String,\s*extended: Option<bool>,/.test(rustCmdSrc));
ok('命令层把 extended 传给 show_context_menu',
  /show_context_menu\(hwnd, &target, want_extended\)/.test(rustCmdSrc));

ok('ipc.ts shellContextMenu 带 extended（默认 false）',
  /shellContextMenu: \(path: string, extended = false\)/.test(ipcSrc));
ok('ipc.ts 把 extended 发到后端', /call<void>\('shell_context_menu', \{ path, extended \}\)/.test(ipcSrc));

ok('前端条目右键用 ctrlKey 判 Handy 菜单（不再抢 Shift）',
  /if \(!event\.ctrlKey\) \{/.test(overlaySrc));
ok('前端把 shiftKey 透传给原生菜单（扩展动词）',
  (overlaySrc.match(/shellContextMenu\([^)]*event\.shiftKey\)/g) ?? []).length >= 3,
  '格子条目 / 未归类条目 / 桌面空白处 三处都要传 —— 不一致本身就算「改行为」');
ok('前端不再出现「!event.shiftKey && !entry.isSystem」这种抢 Shift 的写法',
  !/!event\.shiftKey && !entry\.isSystem/.test(overlaySrc));

/* ================================================================== *
 * ④ 诊断工具还在（改 shell_menu 时靠它对照菜单项）
 * ================================================================== */

ok('诊断 example 仍在（cargo run --example menu_dump）',
  fs.existsSync(path.join(root, 'src-tauri/examples/menu_dump.rs')));

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
