/**
 * 布局审计：无头浏览器多视口实测（溢出 / 裁切 / 重叠）+ 截图取证。
 *
 * # 为什么要它，而不是「读代码判断」
 *
 * V22/V23 两轮用户反馈都是**布局**问题（「挤在一起了」「放大缩小后一堆乱套」），
 * 而这类问题有一个共同特征：**页面级检测完全看不出来**。
 * 面板 A 的内容溢出自己的单元格、被后渲染的面板 B 盖住时，
 * `document.documentElement.scrollWidth` 一点没变 —— 因为外层有 `overflow:hidden` 兜着。
 * 所以必须换一套指标：
 *
 * | 指标 | 抓什么 | V22 那次能不能抓到 |
 * | --- | --- | --- |
 * | `ox` / `mox` 横向溢出 | 整页 / 主内容区被撑破 | 抓不到（被 overflow 兜住） |
 * | `clipX` / `clipY` | **内容溢出但容器不滚**（滚不到 = 用户够不着） | 抓不到 |
 * | `overlap` | 非祖孙关系的块级容器矩形相交 | **能**（这正是「挤在一起」的形态） |
 *
 * V23 实测战果：`module=notes`（工作台）在 680px 宽下
 * ① 日历的 42 格网格被 `flex-1` 压进「剩余高度」，**月末两周被裁**；
 * ② 「计划」面板被同一行的 flex 收缩压成 19px 空壳。
 * 两个都被 `overlap` + 截图抓到，`ox` 全程为 0 —— 只测溢出会得出「一切正常」的错误结论。
 *
 * # 用法
 *
 *   node scripts/audit/layout-audit.mjs                      # 全部页面 × 默认三档视口
 *   node scripts/audit/layout-audit.mjs --widths=680,1280    # 指定视口
 *   node scripts/audit/layout-audit.mjs --shots              # 顺便截图到 _shots/audit/
 *   node scripts/audit/layout-audit.mjs --only=workstation,text-lab
 *
 * 输出：`_shots/audit/layout-audit.json`（明细）+ stdout（人读表）。
 * 退出码：0 = 无溢出且无重叠；1 = 有发现。
 *
 * # 硬约束（踩过坑）
 *
 * Vite dev server 与浏览器**必须在同一个 node 进程里起**：沙箱会在命令结束时回收
 * 后台进程，分两条命令起服务必定 `fetch failed`。
 * agent-browser 的 `.cmd` 会被安全层拦截，一律走 `node <bin>.js`。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 41_887;
const AB =
  process.env.AGENT_BROWSER_BIN ??
  'C:/Users/Administrator/AppData/Roaming/npm/node_modules/agent-browser/bin/agent-browser.js';

/** 工具箱命令 id（命令行 `--only` 可只跑其中几个） */
const TOOLS = [
  'timestamp',
  'json-formatter',
  'base64-codec',
  'url-codec',
  'jwt-decoder',
  'text-diff',
  'password-generator',
  'hash-generator',
  'qrcode-generator',
  'uuid-generator',
  'json-to-ts',
  'regex-tester',
  'case-converter',
  'text-dedup',
  'text-lab',
  'csv-json',
  'sql-formatter',
  'relative-time',
  'unit-converter',
  'file-size',
  'cron-descriptor',
  'slug-generator',
  'image-to-base64',
  'ascii-table',
];

/**
 * 模块页 id。
 *
 * ⚠️ 注意 `notes` 就是「工作台」—— 工作台的路由 id 仍是 `notes`（零迁移，见 WorkstationView 头注释）。
 * `todos` / `desktop-grid` / `workstation` 这些名字**不是**可深链的模块 id：
 * 模块注册表靠 `import.meta.glob` 收集各模块 `index.ts`，只有 notes / vault /
 * desktop-organizer 三个存在。传不存在的 id 会渲染空视图 —— 审计会得出「没问题」的假结论。
 */
const MODULES = ['notes', 'vault', 'desktop-organizer'];

const args = process.argv.slice(2);
const argOf = (name) => {
  const hit = args.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const widths = (argOf('widths') ?? '680,1024,1680').split(',').map((v) => Number.parseInt(v, 10));
const height = Number.parseInt(argOf('height') ?? '760', 10);
const withShots = args.includes('--shots');
const only = argOf('only');

let pages = [
  ...TOOLS.map((id) => ({ kind: 'tool', id })),
  ...MODULES.map((id) => ({ kind: 'module', id })),
];
if (only !== null) {
  const wanted = only.split(',').map((item) => item.trim());
  pages = pages.filter((page) => wanted.includes(page.id));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ab(callArgs) {
  const result = spawnSync(process.execPath, [AB, ...callArgs], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
}

/**
 * 页面内测量。**用 `truncate` 类元素要过滤掉** ——
 * Tailwind 的 `truncate` = `overflow:hidden + text-overflow:ellipsis + nowrap`，
 * 它的 `scrollWidth > clientWidth` 是**预期行为**（正是省略号的实现方式），
 * 不过滤的话每个工具都会刷一堆假警报，真问题反而被埋掉。
 */
const MEASURE = `(()=>{
  const d=document.documentElement, cx=d.clientWidth;
  const scrollable=(v)=>v==='auto'||v==='scroll'||v==='overlay';
  const intentionalTruncate=(el)=>/(^|\\s)truncate(\\s|$)/.test(String(el.className||''));
  const clipX=[], clipY=[], bad=[];
  for (const el of document.querySelectorAll('body *')) {
    const r=el.getBoundingClientRect();
    if (r.width===0 && r.height===0) continue;
    const cs=getComputedStyle(el);
    if (!intentionalTruncate(el)) {
      if (el.scrollWidth>el.clientWidth+2 && !scrollable(cs.overflowX) && cs.overflowX!=='visible') {
        clipX.push({ t:el.tagName.toLowerCase(), c:String(el.className||'').slice(0,70), sw:el.scrollWidth, cw:el.clientWidth });
      }
      if (el.scrollHeight>el.clientHeight+2 && !scrollable(cs.overflowY) && cs.overflowY!=='visible') {
        clipY.push({ t:el.tagName.toLowerCase(), c:String(el.className||'').slice(0,70), sh:el.scrollHeight, ch:el.clientHeight });
      }
    }
    if (r.right>cx+2 || r.left<-2) {
      bad.push({ t:el.tagName.toLowerCase(), c:String(el.className||'').slice(0,70), l:Math.round(r.left), r:Math.round(r.right) });
    }
  }
  // 重叠：非 absolute/fixed、非祖孙关系的块级容器两两相交
  const boxes=[];
  for (const el of document.querySelectorAll('div,section,header,footer,aside,main,nav')) {
    const cs=getComputedStyle(el);
    if (cs.position==='absolute'||cs.position==='fixed') continue;
    if (cs.display==='none'||cs.visibility==='hidden') continue;
    const r=el.getBoundingClientRect();
    if (r.width<40||r.height<24) continue;
    boxes.push(el);
  }
  const overlaps=[];
  for (let i=0;i<boxes.length && overlaps.length<8;i++) {
    for (let j=i+1;j<boxes.length && overlaps.length<8;j++) {
      const A=boxes[i], B=boxes[j];
      if (A.contains(B)||B.contains(A)) continue;
      const a=A.getBoundingClientRect(), b=B.getBoundingClientRect();
      const ox=Math.min(a.right,b.right)-Math.max(a.left,b.left);
      const oy=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top);
      if (ox>4 && oy>4) {
        overlaps.push({ a:String(A.className||A.tagName).slice(0,64), b:String(B.className||B.tagName).slice(0,64), ox:Math.round(ox), oy:Math.round(oy) });
      }
    }
  }
  const m=document.querySelector('main');
  const h=document.querySelector('h1') || document.querySelector('h2');
  return JSON.stringify({
    vw: cx, vh: d.clientHeight,
    ox: d.scrollWidth-cx,
    mox: m ? m.scrollWidth-m.clientWidth : -1,
    title: h ? h.textContent : '',
    clipX: clipX.slice(0,6), clipY: clipY.slice(0,6),
    overlaps, boxes: boxes.length,
    bad: bad.slice(0,8)
  });
})()`;

const log = [];
const push = (line) => {
  log.push(line);
  console.log(line);
};

/** CLI 会把求值结果当 JSON 字符串回显：逐层剥 */
function parseEval(out) {
  const candidates = [out, out.replace(/^"|"$/g, '').replace(/\\"/g, '"'), out.replace(/\\\\/g, '\\')];
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (typeof value === 'string') {
        const inner = JSON.parse(value);
        if (inner !== null && typeof inner === 'object') return inner;
      } else if (value !== null && typeof value === 'object') {
        return value;
      }
    } catch {
      /* 换下一种 */
    }
  }
  return null;
}

const outDir = path.resolve('_shots', 'audit');
fs.mkdirSync(outDir, { recursive: true });

const server = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort'],
  { stdio: 'ignore' },
);

let ready = false;
for (let i = 0; i < 80; i += 1) {
  try {
    const res = await fetch(`http://localhost:${PORT}/`);
    if (res.ok) {
      ready = true;
      break;
    }
  } catch {
    /* 还没起来 */
  }
  await sleep(500);
}
push(`dev server ready: ${ready}（http://localhost:${PORT}）`);

const rows = [];
if (ready) {
  try {
    for (const width of widths) {
      push(`\n--- viewport ${width}×${height} ---`);
      ab(['set', 'viewport', String(width), String(height)]);
      for (const page of pages) {
        const query = page.kind === 'tool' ? `tool=${page.id}` : `module=${page.id}`;
        ab(['open', `http://localhost:${PORT}/?${query}`]);
        await sleep(700);
        const parsed = parseEval(ab(['eval', MEASURE]));
        if (parsed === null) {
          rows.push({ width, ...page, error: 'EVAL_FAIL' });
          push(`  ${page.kind}/${page.id} @${width}: EVAL_FAIL`);
          continue;
        }
        rows.push({ width, ...page, ...parsed });
        const flags = [];
        if (parsed.ox > 0) flags.push('PAGE_OVERFLOW');
        if (parsed.mox > 0) flags.push('MAIN_OVERFLOW');
        if (parsed.clipX.length > 0) flags.push(`CLIP_X×${parsed.clipX.length}`);
        if (parsed.clipY.length > 0) flags.push(`CLIP_Y×${parsed.clipY.length}`);
        if (parsed.overlaps.length > 0) flags.push(`OVERLAP×${parsed.overlaps.length}`);
        push(
          `  ${page.kind}/${page.id} @${width}: ox=${parsed.ox} mox=${parsed.mox} title="${parsed.title}" ${flags.join(' ') || 'ok'}`,
        );
        for (const item of parsed.overlaps.slice(0, 3)) {
          push(`      OVERLAP ${item.ox}×${item.oy}px  A="${item.a}"  B="${item.b}"`);
        }
        for (const item of parsed.clipX.slice(0, 3)) {
          push(`      CLIP_X <${item.t} class="${item.c}"> scrollW=${item.sw} clientW=${item.cw}`);
        }
        if (withShots) {
          ab(['screenshot', path.join(outDir, `${page.kind}-${page.id}-${width}.png`)]);
        }
      }
    }
  } finally {
    ab(['close']);
  }
}

server.kill();

const problems = rows.filter(
  (row) =>
    (row.ox ?? 0) > 0 ||
    (row.mox ?? 0) > 0 ||
    (row.clipX ?? []).length > 0 ||
    (row.clipY ?? []).length > 0 ||
    (row.overlaps ?? []).length > 0 ||
    (row.bad ?? []).length > 0 ||
    row.error !== undefined,
);

push(`\n===== 有问题的组合：${problems.length} / ${rows.length} =====`);
for (const row of problems) {
  push(
    `  ⚠️ ${row.kind}/${row.id} @${row.width} → ox=${row.ox} mox=${row.mox}` +
      ` clipX=${(row.clipX ?? []).length} clipY=${(row.clipY ?? []).length}` +
      ` overlap=${(row.overlaps ?? []).length} out=${(row.bad ?? []).length}` +
      `${row.error ? ` ${row.error}` : ''}`,
  );
}

fs.writeFileSync(path.join(outDir, 'layout-audit.json'), JSON.stringify(rows, null, 2));
fs.writeFileSync(path.join(outDir, 'layout-audit.log'), log.join('\n'));
console.log(`\n明细已写入 ${path.join(outDir, 'layout-audit.json')}`);
process.exit(problems.length === 0 ? 0 : 1);
