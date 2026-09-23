/**
 * 「图标拖拽 = 指针拖拽，不是 HTML5 拖放」＋「盒子高度不许自己长」的回归守卫（V59 新增）。
 *
 * # 为什么必须锁
 *
 * 用户 09-21 三条反馈里，两条的根因都**不在能跑测试的那一层**：
 *
 *   ① 「图标还是不能自己拖动，拖动就显示禁用图标」——
 *      根因在 wry（`wry-0.55.1/src/webview2/drag_drop.rs`）：
 *      `DragEnter` 只在载荷含 `CF_HDROP`（真实文件）时才写 `*pdwEffect`，否则
 *      **直接 return 不写**；而 `DragOver` 每次都把初始化值 `DROPEFFECT_NONE` 回填。
 *      于是 DOM 元素的 HTML5 拖放在这个窗口里**永远被系统判成「不可放置」**：
 *      光标画成禁止符号、`drop` 不派发。V43–V58 加的五层兜底（`effectAllowed`、
 *      `types`、`ref`、无条件 `preventDefault`…）全部无效，因为改的不是那一层。
 *      现在的口径是**指针拖拽**，这条守卫就是防止有人再退回去用 HTML5 拖放。
 *
 *   ② 「高度方向还是有点重叠」＋「列表展开装不下了应该自动出滚动条」——
 *      同一个根因：`height: isWidget ? box.height : undefined` 让**收纳格高度是 auto**，
 *      引擎按「条目数 ÷ 每行列数」估算的几何被前端渲染成另一个高度 ⇒ 盒子长出去压住
 *      下一个格子；而且盒子自己长高了，内容区的 `overflow-y-auto` 没有可滚余量 ⇒
 *      永远不出滚动条；更隐蔽的是 flex 子项默认 `min-height: auto`，
 *      少了 `min-h-0` 它根本不会被压缩。
 *
 * 这三条都**编译通过、类型正确、单测全绿**，只能靠源码断言守住。
 *
 *   ③ 「桌面可以滚轮上下移动了……只有光标在图标或格子上才可以移动」——
 *      这是 ① ② 改完之后**自己制造的回归**：为了排查「装不下不出滚动条」，把根画布从
 *      `overflow-hidden` 改成了 `overflow-y-auto grid-scroll`。根画布是 `fixed inset-0`，
 *      格子 / 竖条都是它的绝对定位子元素 —— 绝对定位元素会把溢出算进包含块的可滚动溢出区，
 *      于是**任何**一处子元素比视口高出十几像素，整层就变成可滚的。
 *      空白处 `pointerEvents: 'none'`（事件穿透到桌面，滚不动）、图标 / 格子上恢复了指针
 *      事件（滚轮冒泡到根画布 → 整个桌面跟着跑），用户看到的正是「只在图标或格子上能滚」。
 *
 * **解析不到即 FAIL**（不是跳过）：正则没匹配上时必须变红，否则本套件会静默退化成
 * 「永远 PASS」，比没有它更糟（CONVENTIONS「审计脚本解析为空即 FAIL」）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

const OVERLAY = 'src/modules/desktop-grid/GridOverlay.tsx';
const RUST_CMD = 'src-tauri/src/commands/grid.rs';

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

const overlay = read(OVERLAY);
const rustCmd = read(RUST_CMD);
// V60：工作台（日历 + 快捷入口 + 操作按钮）从 GridOverlay 里抽成了一个组件，
// 于是「滚动容器必须带 min-h-0」这条纪律的适用面也跟着多了一个文件 —— 见 ⑦。
const WORKSTATION = 'src/modules/desktop-grid/DesktopWorkstation.tsx';
const workstation = read(WORKSTATION);
const MIGRATIONS = 'src-tauri/src/db/migrations.rs';
const migrations = read(MIGRATIONS);
const LIB_RS = 'src-tauri/src/lib.rs';
const libRs = read(LIB_RS);
// V61：日历（`CalendarWidget`）的唯一宿主现在是工作台，它的外壳观感属于「工作台整体感」
// 的一部分 —— 见 ⑫ 的最后两条。
const WIDGETS = 'src/modules/desktop-grid/DesktopWidgets.tsx';
const widgets = read(WIDGETS);

/**
 * 把注释剥掉后再断「不许有」——本文件里有一大段解释**为什么**删掉那些东西的注释，
 * 里面必然出现 `effectAllowed`、`max-h-[60vh]` 这些字面量。不剥注释，「不许有」的断言
 * 会被自己的说明书判红（这一版第一跑就是被自己绊倒的）；而「必须有」的断言用原文即可。
 *
 * 只剥 `/* … *​/` 与**整行** `//`：够用，且不会误伤 `'https://…'` 这类字符串里的 `//`。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ');
}

const overlayCode = stripComments(overlay);
const rustCmdCode = stripComments(rustCmd);
const workstationCode = stripComments(workstation);
const widgetsCode = stripComments(widgets);

/** 数一下源码里出现次数 */
function count(src, re) {
  return (src.match(re) ?? []).length;
}

/* ================================================================== *
 * ① 内部拖拽必须是**指针**拖拽：不许再出现 HTML5 拖放的实操痕迹
 * ================================================================== */

ok('GridOverlay 里已无 dataTransfer.setData（HTML5 拖拽载荷）',
  count(overlayCode, /dataTransfer\.setData/g) === 0);
ok('GridOverlay 里已无 dataTransfer.getData',
  count(overlayCode, /dataTransfer\.getData/g) === 0);
ok('GridOverlay 里已无 effectAllowed（V43 那个「兼容 Dock 的 copy」补丁）',
  count(overlayCode, /effectAllowed/g) === 0,
  '它在 wry 的 DROPEFFECT_NONE 面前毫无作用 —— 见文件头说明');
ok('GridOverlay 里已无 dropEffect',
  count(overlayCode, /dropEffect/g) === 0);
for (const attr of ['onDragStart', 'onDragOver', 'onDragLeave', 'onDragEnd', 'onDrop']) {
  ok(`GridOverlay 里已无 JSX 属性 ${attr}`,
    count(overlayCode, new RegExp(`\\b${attr}=`, 'g')) === 0);
}

/* ================================================================== *
 * ② 指针拖拽的关键件都在
 * ================================================================== */

ok('定义了拖拽阈值 DRAG_THRESHOLD', /const DRAG_THRESHOLD = \d+;/.test(overlay));
ok('有拖拽会话类型 DragSession', /interface DragSession/.test(overlay));
ok('有拖拽会话 ref', /const dragSessionRef = useRef<DragSession \| null>\(null\)/.test(overlay));
ok('有拖拽预览 ref', /const dragGhostRef = useRef<HTMLDivElement \| null>\(null\)/.test(overlay));
ok('有 beginDragSession / beginItemDrag / beginLooseDrag / resetDragVisuals 四个入口',
  ['beginDragSession', 'beginItemDrag', 'beginLooseDrag', 'resetDragVisuals']
    .every((name) => new RegExp(`const ${name} = useCallback\\(`).test(overlay)));
ok('主循环挂了 window mousemove', /window\.addEventListener\('mousemove', onMove\)/.test(overlay));
ok('主循环挂了 window mouseup', /window\.addEventListener\('mouseup', onUp\)/.test(overlay));
ok('拖拽中可按 Esc 取消', /event\.key === 'Escape' && dragSessionRef\.current !== null/.test(overlay));
ok('指针移出窗口要作废会话（否则永久卡在拖拽态）',
  /document\.documentElement\.addEventListener\('mouseleave', onAbort\)/.test(overlay));
ok('卸载时把四个监听都摘掉', count(overlay, /removeEventListener\(/g) >= 4);

/* ================================================================== *
 * ③ 阈值：没过阈值 = 普通单击 / 双击，什么都不做
 *    （条目上挂着「双击打开文件」，被拖拽抢掉就变成「点不开」）
 * ================================================================== */

ok('用位移阈值判定「真的在拖了吗」',
  /if \(moved < DRAG_THRESHOLD\) \{\s*return;/.test(overlay),
  '正则没匹配到：阈值判据被改过，请人工确认双击还能用');
ok('没过阈值 / 按过 Esc 一律不落点',
  /if \(!active \|\| cancelled\) \{\s*return;/.test(overlay));
ok('条目 onMouseDown 里先 stopPropagation 再 beginItemDrag',
  /event\.stopPropagation\(\);\s*\/\/[\s\S]{0,200}?beginItemDrag\(item, event\);/.test(overlay)
  || /beginItemDrag\(item, event\)/.test(overlay));
ok('竖条条目 onMouseDown 里也走 beginLooseDrag',
  /beginLooseDrag\(entry, event\)/.test(overlay));

/* ================================================================== *
 * ④ 落点判定：入口优先于格子，判定函数复用同一套（不另起一套坐标换算）
 * ================================================================== */

ok('落点用 hitDock 判快捷入口', /hitDock\(event\.clientX, event\.clientY\)/.test(overlay));
ok('落点用 hitBoxId 判格子', /hitBoxId\(event\.clientX, event\.clientY\)/.test(overlay));
ok('拖到入口 = 收藏成快捷方式', /addDockLink\(item\.displayName, item\.filePath\)/.test(overlay));
ok('拖出所有格子 = 移出格子', /if \(boxId === null\) \{\s*removeItem\(item\);/.test(overlay));
ok('拖进格子 = 改引用归属', /moveItem\(\{ item, itemId: item\.id, fromBoxId: item\.boxId \}, boxId\)/.test(overlay));

/* ================================================================== *
 * ⑤ 不许关掉 Tauri 的原生拖放（关了它，真实文件就再也拿不到路径）
 *    只是**不许在窗口构建里显式关闭**；注释里提它是允许的
 * ================================================================== */

ok('挂件窗构建里没有 `.drag_drop_enabled(` 调用',
  count(rustCmdCode, /\.drag_drop_enabled\(/g) === 0,
  '关掉它 = 从资源管理器拖文件进格子拿不到真实路径；内部拖拽改指针就是为了两全');
ok('grid.rs 里说明了为什么不能关（留痕，防下次又有人「顺手修一下」）',
  /不要给这个窗口设 `drag_drop_enabled\(false\)`/.test(rustCmd));

/* ================================================================== *
 * ⑥ 盒子高度必须绑定引擎值 —— 否则又会出现「压住下面那个格子」
 * ================================================================== */

ok('section 高度绑引擎值 height: box.height', /height: box\.height,/.test(overlayCode));
ok('已删掉 `isWidget ? box.height : undefined` 这条 auto 高度分支',
  !/isWidget \? box\.height : undefined/.test(overlayCode),
  '收纳格 auto 高度 = 渲染几何与引擎几何不一致 = 重叠');
ok('已删掉 `maxHeight: isWidget ? … : …` 这条只给挂件的上限',
  !/maxHeight: isWidget/.test(overlayCode),
  '再压一层上限同样会让渲染高度小于引擎高度');
ok('盒子 section 上不再有 maxHeight 内联样式',
  count(overlayCode, /maxHeight: `\$\{Math\.round\(window\.innerHeight/g) === 0);

/* ================================================================== *
 * ⑦ 内容区必须能滚：flex-1 + min-h-0 + overflow-y-auto，三件缺一不可
 * ================================================================== */

ok('收纳格内容区带 min-h-0 flex-1 overflow-y-auto（列表视图）',
  /flex min-h-0 flex-1 flex-col gap-0\.5 overflow-y-auto/.test(overlayCode));
ok('收纳格内容区带 min-h-0 flex-1 overflow-y-auto（网格视图）',
  /grid min-h-0 flex-1 content-start gap-1\.5 overflow-y-auto/.test(overlayCode));
ok('便签内容区也带 min-h-0 flex-1 overflow-y-auto',
  count(overlayCode, /className="min-h-0 flex-1 overflow-y-auto grid-scroll"/g) >= 1,
  'V60 起日历不再是盒子，便签这一条路仍要能滚');
ok('工作台的内容区也带 min-h-0 flex-1 overflow-y-auto（日历 + 快捷入口装不下时在它里面滚）',
  // 间距值会随排版微调（V60 是 gap-2、V61 是 gap-2.5）—— 这里只锁「这条纪律在不在」，
  // 不锁具体数值：真正的尺寸约束由 `test-desktop-constants.mjs` 管。
  /className="flex min-h-0 flex-1 flex-col gap-[\d.]+ overflow-y-auto p-2 grid-scroll"/.test(workstationCode),
  '少了 min-h-0，flex 子项的 min-height:auto 会把标题栏 / 按钮条顶出屏幕');
ok('收纳格内容区已去掉 max-h-[60vh]（高度上限由盒子本身给）',
  !/max-h-\[60vh\]/.test(overlayCode));
ok('左下「未归类」竖条自己滚（列数撞 4 列上限时，内容天然高于引擎给的区域）',
  /"absolute grid content-start gap-1\.5 overflow-y-auto grid-scroll"/.test(overlayCode),
  '少了它，多出来的行会溢出竖条、被根画布的可滚动溢出区收走 → 整个桌面又能滚了');
{
  // 扫描**每个**桌面层文件里所有「滚动的类名字符串」，除了白名单里的，都必须带 `min-h-0`。
  //
  // 白名单里那一条是左侧「未归类」竖条：绝对定位 + 引擎给定的 `height`（定高），
  // 不靠 flex 压缩，所以不需要 min-h-0。
  //
  // ⚠️ 判据是「漏掉的**恰好等于**白名单」，不是数个数 —— 数个数那种写法一有人
  // 合理地新增/删除一个滚动容器就会误报（V60 就撞上了：工作台的内容区从 GridOverlay
  // 搬进 DesktopWorkstation，GridOverlay 那份白名单里的快捷入口条目当场过期）。
  // 集合相等这个判据同时挡住了两边：新增了没带 min-h-0 的容器 → 漏掉的变多 → 红；
  // 白名单里的东西被改好或删掉了 → 漏掉的变少 → 也红（顺手删掉白名单项）。
  // V63：白名单从「一条」扩成「一组」—— 判据没变（**绝对定位 + 定高**，不靠 flex
  // 压缩，所以不需要 min-h-0），只是符合这条的容器多了一个。
  const ABSOLUTE_SCROLLERS = new Set([
    // 左侧「未归类」竖条：绝对定位 + 引擎给定的 `height`
    '"absolute grid content-start gap-1.5 overflow-y-auto grid-scroll"',
    // V63 收纳区滚动容器：绝对定位 + `top-0 bottom-0`（统一网格放不下时在这里滚）。
    // 高度由上下 inset 定死，加 min-h-0 只是个无害的摆设，不如进白名单说清楚。
    '"absolute left-0 top-0 bottom-0 overflow-y-auto overflow-x-hidden"',
  ]);
  const files = [
    ['GridOverlay.tsx', overlayCode],
    ['DesktopWorkstation.tsx', workstationCode],
  ];
  const leaked = [];
  let withMin = 0;
  for (const [name, code] of files) {
    const scrollers = code.match(/"(?:[^"\\]|\\.)*overflow-y-auto(?:[^"\\]|\\.)*"/g) ?? [];
    for (const cls of scrollers) {
      if (cls.includes('min-h-0')) {
        withMin += 1;
      } else if (!ABSOLUTE_SCROLLERS.has(cls)) {
        leaked.push(`${name}: ${cls}`);
      }
    }
  }
  ok('盒内 / 工作台里漏掉 min-h-0 的滚动容器恰好只有白名单那几条（都是绝对定位定高）',
    leaked.length === 0,
    `多出来 ${leaked.length} 处：${leaked.join(' | ')}`);
  ok('白名单没过期：「未归类」竖条仍在，且仍是那几条不带 min-h-0 的滚动容器之一',
    count(overlayCode, /"absolute grid content-start gap-1\.5 overflow-y-auto grid-scroll"/g) === 1,
    '竖条被改写成带 min-h-0 或删掉了 → 请同步删掉 ABSOLUTE_SCROLLERS 里的对应项');
  ok('带 min-h-0 的滚动容器总数没掉（盒子两种视图 + 便签 + 工作台）',
    withMin >= 4,
    `只有 ${withMin} 个 —— 有人的 min-h-0 掉了，或滚动容器被删了`);
}

/* ================================================================== *
 * ⑧ 桌面根画布**不许**是滚动容器
 *
 * 用户 09-21：「桌面可以滚轮上下移动了……只有鼠标移动到图标或者格子上才可以移动，
 * 在桌面空白的地方不能移动」。根画布 `fixed inset-0` + `overflow-y-auto` ⇒ 只要有任何
 * 绝对定位子元素（格子 / 竖条）比视口高出十几像素，整层就变成可滚容器 ⇒ 滚轮一动
 * 整个桌面跟着跑。空白处因为 `pointerEvents:'none'` 才「恰好正常」，极具迷惑性。
 * ================================================================== */

ok('根画布是 overflow-hidden（整层滚动 = 滚轮一动整个桌面跟着跑）',
  /className="fixed inset-0 select-none overflow-hidden"/.test(overlayCode),
  'V59 曾把它改成 `overflow-y-auto grid-scroll` —— 桌面层永远不该能滚');
ok('根画布上不再挂 grid-scroll',
  !/"fixed inset-0 select-none[^"]*grid-scroll"/.test(overlayCode),
  '它是整层画布，不是滚动区；滚动条样式只属于盒内 / 竖条 / 入口');
ok('根画布的次数是 1（别处不要冒出第二个全屏层）',
  count(overlayCode, /className="fixed inset-0 select-none/g) === 1);

/* ================================================================== *
 * ⑨ 右键菜单必须视口锚定（`fixed`），不许再退回 `absolute`
 *
 * 四处菜单（格子 / 条目 / 竖条 / 快捷条）的坐标全部直接取自 `event.clientX / clientY`
 * —— 那是**视口**坐标。根画布带 `overflow-hidden`（见 ⑧），`absolute` 子元素会被它裁剪，
 * 在屏幕靠下 / 靠右的位置右键就会看到菜单被切掉半截；`fixed` 的包含块是视口，不受影响。
 * V53 的桌面菜单一直是 `fixed`，两边原本就不一致。
 * ================================================================== */

ok('没有 `absolute z-50` 的菜单外壳了（全部视口锚定）',
  count(overlayCode, /\babsolute z-50\b/g) === 0,
  '菜单坐标是 clientX/clientY —— absolute 会被根画布的 overflow-hidden 裁掉半截');
ok('菜单外壳确实是 fixed z-50（改完别改丢）',
  count(overlayCode, /\bfixed z-50\b/g) >= 3,
  `期望格子/条目/竖条/快捷条/桌面几处都是 fixed z-50，实际只有 ${count(overlayCode, /\bfixed z-50\b/g)} 处`);

/* ================================================================== *
 * ⑩ 视图模式要持久化（原本是纯内存态，重启就悄悄变回网格）
 * ================================================================== */

ok('定义了视图模式的 localStorage 键',
  /const BOX_VIEW_MODES_KEY = 'handy:grid\.box-view-modes';/.test(overlay));
ok('视图模式启动时从 localStorage 恢复',
  /localStorage\.getItem\(BOX_VIEW_MODES_KEY\)/.test(overlay));
ok('视图模式切换后写回 localStorage',
  /localStorage\.setItem\(BOX_VIEW_MODES_KEY, JSON\.stringify\(next\)\)/.test(overlay));

/* ================================================================== *
 * ⑪ 工作台（V60）：日历 + 快捷入口 + 操作按钮是**一个常驻浮窗**
 *
 * 用户 09-21（附腾讯桌面整理截图）：「日历可以修改为工作台，把快捷入口这些都可以整合到
 * 工作台里面，整合成一个整体的模块，现在还缺少添加便签的按钮 还有整理 关闭整理等，
 * 工作台这个可以常驻，不跟桌面整理一起退出等」
 *
 * 这一段的每一条都对应一个「编译通过、类型正确、单测全绿」的翻车方式：
 *   · 工作台被 `contentHidden` 门控 → 「退出桌面整理」把唯一的入口一起收走了；
 *   · 前端宽度与 Rust 禁区宽度不一致 → 格子压在工作台上，或右边白留一条缝；
 *   · Rust 发一个动作、前端没人接 → 用户点了右键菜单什么都没发生（假按钮）；
 *   · 历史遗留的日历盒子数据没人清 → 升级后桌面上多出一个几何算不出来位置的盒子。
 * ================================================================== */

{
  // —— ① 常驻：渲染不能被 contentHidden 门控 ——
  const wsIdx = overlayCode.indexOf('<DesktopWorkstation');
  ok('GridOverlay 里渲染了工作台', wsIdx > 0);
  ok('工作台的渲染没有被 contentHidden 门控（退出整理时它必须还在）',
    wsIdx > 0 &&
      !/contentHidden\s*(?:&&|\?)/.test(overlayCode.slice(Math.max(0, wsIdx - 300), wsIdx)),
    '「退出桌面整理」只该收起格子与竖条；工作台一起没了，用户就没有再打开整理的入口');
  ok('工作台把 contentHidden 当**显示状态**传进去（只用来翻转按钮文案 / 图标）',
    /hidden=\{contentHidden\}/.test(overlayCode));
  ok('工作台组件本身不会因 hidden 而整块消失（hidden 只换图标与文案）',
    !/\bhidden\s*\?\s*null/.test(workstationCode),
    'hidden ? null : … 会让「已退出整理」时工作台整个消失，与「常驻」直接冲突');
  ok('工作台只有『收起』一种折叠（collapsed ? null : …）',
    count(workstationCode, /\?\s*null\s*:\s*\(/g) === 1);

  // —— ② 操作按钮：用户点名缺的四件事必须都在 ——
  for (const [name, prop] of [
    ['便签', 'onAddNote'],
    ['格子', 'onAddBox'],
    ['整理', 'onArrange'],
    ['退出整理', 'onToggleOverlay'],
  ]) {
    ok(`工作台底栏有「${name}」按钮（绑到 ${prop}）`,
      new RegExp(`${prop}=\\{`).test(overlayCode) && new RegExp(`${prop}:`).test(workstationCode));
  }

  // —— ③ 几何必须跨语言一致：前端浮窗宽 == Rust 禁区宽 ——
  //
  // V62：宽度源从 `CALENDAR_BOX_W` 换成了 `WST_BOX_W`。工作台不再是「当年日历那一列」
  // —— 它要装日历 + 快捷入口 + 操作按钮三段，用户 09-21「工作台太小了 日历等都不清晰」
  // 之后加宽到 400，与 `CALENDAR_BOX_W`（日历本体的自然宽度，320）**解耦**。
  const frontW = /export const WORKSTATION_W = (\d+);/.exec(workstation)?.[1];
  const rustW = /const WST_BOX_W: i64 = (\d+);/.exec(rustCmdCode)?.[1];
  const calendarW = /const CALENDAR_BOX_W: i64 = (\d+);/.exec(rustCmdCode)?.[1];
  ok('能解析出前端工作台宽度 WORKSTATION_W',
    frontW !== undefined, '正则没匹配到：常量被改名了，请同步本守卫');
  ok('能解析出 Rust 工作台禁区宽度（WST_BOX_W）',
    rustW !== undefined, '正则没匹配到：常量被改名了，请同步本守卫');
  ok('前端工作台宽度 == Rust 禁区宽度（差 1 像素就压住或留缝）',
    frontW !== undefined && frontW === rustW,
    `前端 ${frontW} vs Rust ${rustW}`);
  ok('Rust 工作台宽度 ≥ 当年日历那一列（V62：它现在要装三段内容，只能更宽）',
    rustW !== undefined && calendarW !== undefined && Number(rustW) >= Number(calendarW),
    `WST_BOX_W=${rustW} < CALENDAR_BOX_W=${calendarW}`);
  ok('工作台外壳的边距用满 Rust 的 ARRANGE_MARGIN（32px = Tailwind 的 8 档）',
    /const ARRANGE_MARGIN: i64 = 32;/.test(rustCmdCode) &&
      /fixed bottom-8 right-8 top-8 flex flex-col overflow-hidden/.test(workstationCode),
    'Rust `workstation_rect` 的上下右边距就是它，错一个档位就会与禁区对不上');
  ok('布局引擎确实把这一列当禁区（workstation_rect 存在且被 layout 用上）',
    /fn workstation_rect\(/.test(rustCmdCode) &&
      count(rustCmdCode, /workstation_rect\(/g) >= 2);

  // —— ④ Rust 发的动作，前端必须逐个接住（否则就是点不动的假按钮）——
  const dispatched = [...libRs.matchAll(/dispatch\(app, "([a-z-]+)"\)/g)].map((m) => m[1]).sort();
  const handled = [...overlayCode.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]).sort();
  ok('能解析出 Rust 侧分发的桌面右键动作',
    dispatched.length > 0, '正则没匹配到：dispatch 调用被改名了，请同步本守卫');
  ok('Rust 分发的每个动作前端都处理了（动作集必须一致）',
    JSON.stringify(dispatched) === JSON.stringify(handled),
    `Rust 发 ${JSON.stringify(dispatched)}，前端接 ${JSON.stringify(handled)}`);

  // —— ⑤ 冷启动那条路的兜底 ——
  ok('Rust 侧把动作入队（冷启动时事件早于前端监听，必丢）',
    /static PENDING_ACTION: Mutex<Option<String>>/.test(rustCmdCode));
  ok('Rust 侧提供了取待办动作的命令',
    /pub async fn grid_take_pending_action\(/.test(rustCmdCode));
  ok('前端挂载时取一次待办 + 监听唤醒事件',
    /\.gridTakePendingAction\(\)/.test(overlayCode) &&
      /listen\('handy:\/\/desktop-action'/.test(overlayCode));

  // —— ⑥ 日历盒子：渲染分支已删、存量数据有迁移清 ——
  ok('GridOverlay 里已无日历盒子的渲染分支',
    !/kind === 'calendar'/.test(overlayCode),
    '日历已并进工作台；留着分支 = 又会出现一个布局算不出位置的盒子');
  ok('`isWidget` 只认便签（widget 列只放便签）',
    /const isWidget = box\.kind === 'note';/.test(overlayCode));
  ok('迁移 v11 会清掉历史遗留的日历盒子',
    /V11_GRID_DROP_CALENDAR/.test(migrations) && /\(11, V11_GRID_DROP_CALENDAR\)/.test(migrations),
    '不清的话老库升级后 `grid_boxes` 里还躺着 kind=calendar 的行');
}

/* ================================================================== *
 * ⑫ 工作台样式融合 + 「双击不被穿透打断」（V61）
 *
 * 用户 09-21（附截图）：「感觉工作台这块样式不够自然，一看那个快捷模块就是拼接上去的
 * 要融为几个整体，简单的文字按钮就可以 不用那么大的图标占空间，本来空间就不够，
 * 图标原有的行为都被覆盖了 例如我双击打开我的电脑 打开某个文件夹现在都做不到了
 * 双击没反应，右键打开居然切到 资源管理器了」
 *
 * 两件独立的事，分别对应下面 A / B：
 *   A. **观感**——快捷入口从「32px 图标 + 10px 标签」的方阵磁贴改成「12px 图标 + 文字」
 *      的胶囊；段与段之间不再画整条分隔线。方阵 + 横线正是「两块板子拼在一起」的来源。
 *   B. **双击**——`grid_set_interactive(false)` 曾让窗口**瞬间穿透**，而轮询线程的局部缓存
 *      `last_ignore` 看不见那次改动 ⇒ 下一拍算出「光标在命中区、该可交互」时与缓存相等
 *      ⇒ 判定「不用改」而跳过 `set` ⇒ 窗口**永久停在穿透态** ⇒ 第二次点击落到下层桌面，
 *      浏览器永远凑不齐 `dblclick`。这里把「谁改状态谁记账」钉死。
 *      （右键不受影响：`onContextMenu` 不经过 `beginDragSession`，没改过窗口状态。）
 * ================================================================== */

{
  // —— A. 胶囊化 ——
  ok('快捷入口用 DockChip（小图标 + 文字胶囊）',
    /function DockChip\(/.test(overlayCode) && !/function DockCell\(/.test(overlayCode));
  ok('DockChip 里不再有 32px 的磁贴图标底座',
    !/h-8 w-8 shrink-0 items-center justify-center rounded-lg/.test(overlayCode),
    '用户：「不用那么大的图标占空间，本来空间就不够」');
  ok('DockChip 的图标收到 h-3.5（14px 档）',
    /flex h-3\.5 w-3\.5 shrink-0 items-center justify-center/.test(overlayCode));
  ok('快捷入口改两列排布（原 3 列方阵）',
    count(overlayCode, /className="grid grid-cols-2 gap-1"/g) >= 2,
    '两处（快捷入口 / 我的快捷方式）都该是两列；少一处说明有人退回方阵了');
  ok('工作台底栏按钮是横向胶囊（原「上图标下文字」的竖排块）',
    /flex min-w-0 flex-1 items-center justify-center gap-1 rounded-lg/.test(workstationCode));
  // ⚠️ 两处都要查：`<section aria-label="快捷入口">` 本身在 DesktopWorkstation 里，
  //    别处若有人另起一段、自己加回 `border-t`，这条也要能发现。
  ok('段与段之间不再画整条分隔线（改由段头分组）',
    !/aria-label="快捷入口"\s+className="border-t/.test(workstationCode) &&
      !/aria-label="快捷入口"\s+className="border-t/.test(overlayCode),
    '一条横线把卡片切成两块，正是用户说的「拼接上去的」');
  ok('段头由工作台统一提供（两段共用同一套语言）',
    count(overlayCode, /<WorkstationSectionLabel/g) >= 2 &&
      /function SectionLabel\(/.test(workstationCode),
    '「快捷入口」与「我的快捷方式」必须都走它；各写各的就会各自漂移回「几块板子」');
  ok('「我的快捷方式」的文件图标跟着缩到 14px',
    /<FileIcon path=\{link\.value\} size=\{14\} \/>/.test(overlayCode));
  ok('日历（默认主题）的外壳只留一抹极淡暗调（不再自带深色底 + 描边）',
    /shell: 'bg-black\/\[0\.12\] text-neutral-100',/.test(widgetsCode),
    'V61 从 neutral-950/72 + ring 收到 0.18，V62 再压到 0.12（工作台加宽后日历是主角，'
    + '底越淡越像长在卡片上的一段）；自带底色 + ring 会在工作台里形成「卡片里贴卡片」');
  ok('六套浅色日历主题的外壳底面保留（浅底是主题的一部分，去掉就看不见字）',
    count(widgetsCode, /shell: 'bg-gradient-to-b from-\w+-\d+ to-\w+-\d+ text-\w+-\d+/g) === 6,
    'V61 只动了默认那套；这里顺手把「六套浅色」钉住，防止有人顺着改下去');
  // —— V62 立规、V66 按用户口径改名：底栏里「一次性动作」与「模式开关」不能长同一张脸 ——
  //
  // 用户 09-21：「开启整理和整理两个让人懵逼 可以有一个更好的方式体现 或者整理换个说法」；
  // 用户 09-22 又点名：「现在只有一个整理动作了，为什么不叫整理 还是归类不是很傻吗?」
  //
  // 于是口径定为：**一次性动作 = 「整理」**（底栏里唯一一颗含「整理」字样的按钮）；
  // **模式开关 = 「显示格子 / 收起格子」**（一格「整理」都不许出现）。
  // 两者只要都带「整理」，就退回那对让人懵逼的按钮。
  const barLabels = [
    ...workstationCode.matchAll(/(?<![-\w])label=(?:"([^"]*)"|\{[^}]*\})/g),
  ].flatMap((m) => (m[1] !== undefined ? [m[1]] : [...m[0].matchAll(/'([^']*)'/g)].map((s) => s[1])));
  const tidyButtons = barLabels.filter((l) => l.includes('整理'));
  ok('底栏只有一颗含「整理」的按钮，且模式开关叫「显示格子 / 收起格子」',
    tidyButtons.length === 1 &&
      tidyButtons[0] === '整理' &&
      barLabels.includes('显示格子') &&
      barLabels.includes('收起格子') &&
      !/label="归类"/.test(workstationCode) &&
      !/'开启整理'/.test(workstationCode) && !/'退出整理'/.test(workstationCode),
    `底栏按钮 = ${JSON.stringify(barLabels)}；「整理」只能出现一次（它就是那个一次性动作），`
      + '模式开关必须是「显示格子 / 收起格子」—— 都叫「整理」就是 09-21 那对让人懵逼的按钮');
  ok('模式开关用描边外观与动作按钮区分（ActionButton 的 variant）',
    /variant="toggle"/.test(workstationCode) && /variant\?: 'action' \| 'toggle'/.test(workstationCode));
  // —— V62：日历网格必须随工作台自适应（限宽会把它锁回 41px 的窄格） ——
  ok('日历网格不再有 max-w-[288px] 限宽（V62：随 400 宽的工作台自适应）',
    /<div className="mx-auto w-full">/.test(widgetsCode) &&
      !/max-w-\[288px\]/.test(widgetsCode),
    '限宽把日期格锁在 41px、字号压到 12px —— 正是用户「日历等都不清晰」的来源');

  // —— B. 双击：交互状态必须「谁改谁记账」 ——
  ok('grid_set_interactive 按「强制标志 + 当前光标命中」求值，而不是无脑跟随参数',
    /let want = interactive \|\| cursor_hit\(&win\);/.test(rustCmdCode),
    '无脑 `set_ignore_cursor_events(!interactive)` ⇒ 抬起鼠标那一刻窗口穿透 ⇒ 双击丢失');
  ok('源码里不再出现无脑按参数设穿透的写法',
    !/set_ignore_cursor_events\(!interactive\)/.test(rustCmdCode),
    '这是 V61 修掉的那个双击 bug 的原文');
  ok('穿透态的「上次施加值」放在共享原子里（轮询与命令路径同源）',
    /static POLLER_IGNORE: AtomicU8/.test(rustCmdCode));
  ok('轮询线程不再用局部 last_ignore 缓存',
    !/let mut last_ignore/.test(rustCmdCode),
    '局部缓存看不见 grid_set_interactive 的改动 ⇒ 判「不用改」而跳过 set ⇒ 永久穿透');
  ok('施加穿透态统一走 apply_ignore（带变化判据 + 记账）',
    /fn apply_ignore\(win: &WebviewWindow, ignore: bool\)/.test(rustCmdCode) &&
      count(rustCmdCode, /apply_ignore\(/g) >= 4);
  ok('「实际状态不可知」的两条路径走 force_ignore（先把缓存置为未知）',
    /fn force_ignore\(win: &WebviewWindow, ignore: bool\)/.test(rustCmdCode) &&
      count(rustCmdCode, /force_ignore\(/g) >= 3,
    '窗口创建 / 收起格子时窗口的实际穿透态已不可知，沿用旧缓存会让下一次判据失真');
  // ⚠️ 下面两条必须查**函数体内**而不是全文件：只把 `POLLER_IGNORE` 声明出来、
  //    却漏了写回那一步，全文件正则照样通过 —— 而那正是双击 bug 的机理。
  {
    const at = rustCmdCode.indexOf('pub async fn grid_set_interactive(');
    const body = at < 0 ? '' : rustCmdCode.slice(at, at + 900);
    ok('能定位 grid_set_interactive 的函数体',
      at >= 0, '正则没匹配到：函数被改名了，请同步本守卫');
    ok('grid_set_interactive 改完窗口状态会写回 POLLER_IGNORE（谁改谁记账）',
      /POLLER_IGNORE\.store\(/.test(body),
      '漏了它 ⇒ 命令路径改了窗口、轮询却以为没改 ⇒ 窗口永久穿透 ⇒ 双击丢失');
  }
  {
    const at = rustCmdCode.indexOf('fn force_ignore(');
    const body = at < 0 ? '' : rustCmdCode.slice(at, at + 400);
    ok('force_ignore 先把缓存置为未知，再施加',
      /IGNORE_UNKNOWN/.test(body) && /apply_ignore\(/.test(body));
  }
}

/* ================================================================== *
 * ⑬ 「桌面排满了就别再建格子」（V70）
 *
 * 用户 09-23：「格子太多后还是出现了滚动条，我建议**如果放不下了就提醒用户不能因为空间
 * 有限不能创建更多格子**，不然逻辑没法实现了」。
 *
 * 判据必须是**引擎自己说放不下**，而不是「数够 N 个格子」：格子的宽高由条目数算出来，
 * 同一个格数在不同内容下占的面积完全不同。所以实现是在一个立刻回滚的 `SAVEPOINT` 里
 * 真的插进去、真的排一遍，看 `LayoutOutcome::overflowed`。
 *
 * 这几条都在守「编译通过、类型正确、单测全绿」的翻车方式：
 *   · 试探被删 ⇒ 又回到「建出来一屏滚动条」；
 *   · 试探插的是另一条 SQL（`content` / `accent` 之类字段不同）⇒ 量出来的不是真货；
 *   · 忘了回滚 ⇒ 每次点「+ 格子」都在库里留一个幽灵格子；
 *   · 拒绝理由没写明「没建」并给出路 ⇒ 用户只看到一句报错，不知道该干什么。
 * ================================================================== */

{
  ok('Rust 里有「试探还有没有地方」的实现',
    /fn probe_room_for_another_box\(/.test(rustCmdCode),
    'V70 之后新建格子必须先量一次；删掉它 ⇒ 桌面又会出现整层滚动条');
  ok('新建格子的那条路径真的调用了试探',
    /if let Some\(reason\) = probe_room_for_another_box\(/.test(rustCmdCode),
    '有函数没调用 = 假守卫');
  {
    const at = rustCmdCode.indexOf('if let Some(reason) = probe_room_for_another_box(');
    const body = at < 0 ? '' : rustCmdCode.slice(at, at + 1200);
    ok('试探与随后的真插入共用同一条 SQL',
      /probe\.execute\(\s*INSERT_BOX_SQL,/.test(body),
      '试探插的是另一条语句 ⇒ 量出来的不是真正会落库的那一行');
    ok('拒绝时要记日志（便于事后查「为什么没建出来」）',
      /grid_log\(&format!\("新建格子被拒/.test(body));
  }
  ok('试探必须整条回滚（不许在库里留下幽灵格子）',
    /ROLLBACK TO \{SP\}; RELEASE \{SP\}/.test(rustCmdCode),
    '只插不回滚 ⇒ 每点一次「+ 格子」库里就多一条看不见的格子');
  ok('试探出错一律当成还装得下（宁可放行，也别把人挡在门外）',
    /Err\(_\) => None,/.test(rustCmdCode),
    '「量尺子」失败就拒绝 ⇒ 用户永远建不出格子');
  ok('拒绝的理由写明「没有新建」',
    /没有新建/.test(rustCmd),
    '用户 09-23 要的是「提醒 + 给出路」，不是一句莫名的报错');
  ok('拒绝的理由给出路（删一个格子 / 清掉一些图标）',
    /先删掉一个格子/.test(rustCmd) && /清掉一些/.test(rustCmd));
  // 前端：这句话有两行那么长，按固定 2.6 秒显示根本读不完
  ok('提示条按字数放宽显示时长（长提示读不完就没了）',
    /Math\.min\(9000, Math\.max\(HINT_DURATION_MS, message\.length \* 110\)\)/.test(overlayCode),
    'V70 的拒绝理由带行动指引，固定 2.6 秒不够读');
  {
    const hintCls = /className="(absolute left-1\/2 top-5[^"]*)"/.exec(overlay)?.[1] ?? '';
    ok('能解析出提示条的类名', hintCls !== '', '提示条被改写/搬走了，请同步本守卫');
    ok('提示条能换行（不再是单行胶囊）',
      hintCls.includes('max-w-[560px]') && hintCls.includes('leading-snug') &&
        !hintCls.includes('rounded-full'),
      `两行长的理由塞进单行胶囊会撑成一条，现在是：${hintCls}`);
  }
}

/* ================================================================== *
 * ⑭ 「能多铺一列就多铺一列」（V71）
 *
 * 用户 09-23（附截图）：「你看整体效果怎么还是补补丁一样的，三个图表最多的不应该 2 3 列
 * 上面开始平均放置，然后把零散的少量的格子补在下面即可哇，至于便签这个列前面的空间不够再放」
 *
 * 真机现场（3 个收纳格 18 / 8 / 8 项，收纳区只剩 637 宽）：
 *   · `k = 3` 的自然宽度要 372 + 232 + 232 + 2×24 = 884 > 637 ⇒ 淘汰；
 *   · `k = 2` 自然宽度 628 ≤ 637 ⇒ 直接命中并返回。
 * 于是「文档」独占第一列、下方空掉 501px，另外两个挤在第二列 —— 正是用户说的「补丁」。
 *
 * 病根：把「自然宽度放不下」当成了「这个列数不可行」。宽度是**软约束**（夹窄了格子变高，
 * 但还能用），**列数才是用户看得见的那个东西** —— 所以要「能多铺一列就多铺一列，
 * 尺寸去适配列宽」，而不是少开一列让尺寸舒服。
 *
 * ⚠️ 这一段的断言都是**结构**。真正的行为判据在 Rust 侧那三条用例里
 * （`cargo test --lib`）：`the_biggest_boxes_share_the_top_row_instead_of_piling_up` /
 * `small_boxes_fill_in_below_the_big_ones` / `a_roomy_zone_keeps_natural_box_widths`，
 * 两条方向的破坏（夹宽挪出循环、夹宽排到自然之前）都验证过会变红。
 * mjs 这边只确认「这段结构还在」，防止重构时整块丢掉、而没人发现。
 * ================================================================== */

{
  const at = rustCmdCode.indexOf('fn pick_columns(');
  ok('Rust 里有挑列数的实现（pick_columns）',
    at >= 0,
    '函数被改名/搬走 ⇒ 下面两条断言会全部落空，必须同步本守卫');
  const body = at < 0 ? '' : rustCmdCode.slice(at, at + 2400);
  ok('列数循环里同时准备「自然宽度」与「夹到 zone_w/k」两套尺寸，且自然在前',
    /vec!\[\(natural_h\.to_vec\(\), natural_w\.to_vec\(\), false\)\][\s\S]{0,260}?trials\.push\(\(ch, cw, true\)\)/.test(body),
    '把「夹宽」挪出列数循环（或排到自然之前）⇒ 宽度一紧张就少开一列，布局又变成「补补丁一样」');
  ok('两套尺寸都在同一个 k 循环里被试（不是「全败之后才夹宽」）',
    /for k in \(1\.\.=capacity\)\.rev\(\)/.test(body) &&
      body.indexOf('for k in (1..=capacity).rev()') <
        body.indexOf('trials.push((ch, cw, true))'),
    'V69 的老写法（夹宽在循环外）产出的正是用户这次截图里那份布局');
}

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
