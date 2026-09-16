#!/usr/bin/env node
/**
 * 示例条 / 关键功能冒烟（V24 建立，V25 扩展）。
 *
 * # 它补的是哪一段空白
 *
 * `tool-audit.mjs` 只能**静态**证明「组件文件里出现了 `samples=`」，
 * 证明不了「用户点下去真的填进去了」；`layout-audit.mjs` 只量几何、不点按钮。
 * 于是「示例条写了但 apply 闭包填错字段」这类错，两个工具都拦不住 ——
 * 而示例条恰恰是用户冷启动一个空工具时唯一的抓手（点一下就应该看懂这工具能干什么）。
 *
 * 本脚本在**真实构建产物**（`dist`）+ 无头浏览器里逐个点击示例 chip，
 * 再把输入框的值与页面正文读回来断言 —— 连「填完以后派生结果算不算得出来」一起验
 * （例：哈希工具点「一句话五算法」后，页面上必须真的出现那段文本的 SHA-256）。
 *
 * # V25 扩展：两种用例
 *
 * 1. **chip 用例**（`chip` 字段）：点示例条上的 chip → 断言填进去的值 + 派生结果。
 * 2. **probe 用例**（`probe` 字段，可无 chip）：打开页面后直接在**浏览器里**跑一段
 *    探针函数，把结构化结果带回来断言。用于「没有示例条、但界面本身就是验收对象」的地方：
 *    - `regex-tester`：30 条正则的**自检徽标**必须无「示例不匹配 / 正则无效」（V25 修的正是这个）；
 *    - `desktop-organizer`：模块首屏必须是「归类文件」页签 + 作用目录栏（V25 修的入口错位）。
 *
 * probe 函数用 `String(fn)` 原样注入，因此**正则与转义不会被外层模板串二次解释**
 * （曾因此踩坑：直接在模板串里写 `\s` 会退化成 `s`）。probe 可以是 async。
 *
 * # 硬约束（同 layout-audit，踩过坑）
 *
 * dev server 与浏览器**必须在同一个 node 进程里起**：沙箱会在命令结束时回收后台进程，
 * 分两条命令起服务必定 `fetch failed`。agent-browser 的 `.cmd` 会被安全层拦截，
 * 一律走 `node <bin>.js`。
 *
 * **开局必须给冷启动留够时间**（V25 卡了两轮才定位）：脚本还没起过浏览器时，第一次 `open` 会顺带
 * 冷启动无头浏览器，**实测 60~90 秒**。如果用 60s 的固定超时去调它，等于每次都把冷启动掐断在半路 ——
 * 浏览器留在半活状态，之后每一步都慢到超时，整轮跑起来像「卡死」（第一次跑就是跑了 9 分钟还没完）。
 * 现在：首次 `open` 单独给 180s + `eval` 失败自动重试一次；后续换页只要 ~0.3 秒。
 * 另外 `ab()` 改成 `spawn` + `exit` + 自计时（不用 `spawnSync`），确保超时路径**一定**能返回，
 * 不会因为子进程/孙进程的管道被拖住。
 * **也别用 `wait --load load`**：每页固定空烧 25 秒（见 PROJECT_STATUS §3 约束 19）。
 *
 * # 用法
 *
 * ```bash
 * node scripts/audit/sample-smoke.mjs              # 全部用例
 * node scripts/audit/sample-smoke.mjs --only=timestamp,hash-generator,regex-tester
 * ```
 *
 * 退出码：0 = 全部用例生效；1 = 有用例未生效；2 = 环境未起来。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 41_889;
const ROOT = process.cwd();
const AB =
  process.env.AGENT_BROWSER_BIN ??
  'C:/Users/Administrator/AppData/Roaming/npm/node_modules/agent-browser/bin/agent-browser.js';

const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length).split(',').filter(Boolean) : null;

/**
 * 调一次 agent-browser CLI。
 *
 * 用 `spawn` + `exit` 事件 + 自计时，**不用 `spawnSync`**：这样超时路径一定返回
 * （`spawnSync` 在子进程拉起了浏览器、管道被继承时，行为取决于管道何时关闭，不够确定）。
 * `timeout` 可调：首次 `open` 要付浏览器冷启动（实测 60~90 秒），见文件头说明。
 */
function ab(args, timeout = 60_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [AB, ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (status) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    };
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('exit', (code) => finish(code ?? 0));
    child.on('error', () => finish(null));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, timeout);
  });
}

/** agent-browser 会把 JSON 结果再包一层引号，逐层剥到对象为止 */
function parseEval(stdout) {
  let text = stdout.trim();
  for (let i = 0; i < 4; i += 1) {
    try {
      const value = JSON.parse(text);
      if (typeof value === 'string') {
        text = value;
        continue;
      }
      return value;
    } catch {
      return null;
    }
  }
  return null;
}

// ——————————————————————————————————————————————————————————
// 页面内探针（真实 JS 源码，用 String() 注入，避免模板串吃掉反斜杠）
// ——————————————————————————————————————————————————————————

/** UUID：数页面里 v4 形态的串（8-4-4-4-12，第三段以 4 开头） */
function probeUuid() {
  const found = document.body.innerText.match(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g) ?? [];
  return { count: found.length, sample: found[0] ?? '' };
}

/**
 * 密码：从页面里挑出 16 位候选串，检查 V25 的两条硬要求
 * ——符号占比不超过 25%（16 位里 ≤ 4 个）、且不出现连排符号。
 */
function probePassword16() {
  const text = [
    document.body.innerText,
    ...Array.from(document.querySelectorAll('textarea, input')).map((e) => String(e.value)),
  ].join('\n');
  const candidates = text
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => /^\S{16}$/.test(line) && /[A-Za-z]/.test(line));
  const pw = candidates[0] ?? '';
  return {
    count: candidates.length,
    pw,
    symbols: pw.replace(/[A-Za-z0-9]/g, '').length,
    adjacent: /[^A-Za-z0-9]{2}/.test(pw),
  };
}

/** 正则库：数「N 处」徽标，并找出零命中 / 编译失败的条目 */
function probeRegexBadges() {
  const text = document.body.innerText;
  return {
    hits: (text.match(/\d+ 处/g) ?? []).length,
    zero: (text.match(/示例不匹配/g) ?? []).length,
    broken: (text.match(/正则无效/g) ?? []).length,
  };
}

/** 文本处理台：示例要「把日志铺进去 + 把 502 填进筛选框」，两件事都得验 */
function probeTextLab() {
  const fields = Array.from(document.querySelectorAll('textarea, input')).map((e) => String(e.value));
  return {
    fieldCount: fields.length,
    textLen: fields.length === 0 ? 0 : Math.max(...fields.map((v) => v.length)),
    hasLog: fields.some((v) => v.includes('GET /')),
    find502: fields.some((v) => v.trim() === '502'),
    bodyHas502: document.body.innerText.includes('502'),
  };
}

/** 桌面整理控制台：首屏必须是「归类文件」，切到「桌面格子」要给出「不移动」的说明 */
async function probeDesktopConsole() {
  const tick = () => new Promise((r) => setTimeout(r, 400));
  const before = document.body.innerText;
  const gridTab = Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent.trim() === '桌面格子',
  );
  const out = {
    tabFound: gridTab !== undefined,
    hasFilesTab: before.includes('归类文件'),
    hasWorkDir: before.includes('作用目录'),
    hasMoveHint: before.includes('真移动'),
    gridHint: false,
  };
  if (gridTab === undefined) {
    return out;
  }
  gridTab.click();
  await tick();
  out.gridHint = document.body.innerText.includes('不移动');
  return out;
}

// ——————————————————————————————————————————————————————————
// 脚本拼装
// ——————————————————————————————————————————————————————————

/**
 * 点示例 chip（可选）→ 读回输入框 + 正文 → 跑探针 → 一次性返回。
 *
 * ⚠️ **不要用 `agent-browser wait --load load`**：实测它每页固定烧 **25 秒**
 * （`open` 之后 load 事件早已触发，这条命令等不到那次事件，只能等到自己的超时），
 * 22 个页面就是 9 分钟纯等待。改成**在页面里轮询就绪**（chip 出现 / 按钮渲染出来），
 * 每页约 1~2 秒，整轮从 ~11 分钟压到 ~2 分钟。
 */
function buildScript(chip, probeFn) {
  const lines = [];
  lines.push('(async () => {');
  lines.push('  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));');
  if (chip) {
    lines.push(`  const chipLabel = ${JSON.stringify(chip)};`);
    lines.push('  const findChips = () =>');
    lines.push(
      "    Array.from(document.querySelectorAll('button')).filter((b) => b.textContent.trim() === chipLabel);",
    );
    // 轮询就绪：SPA 首帧可能还没有示例条
    lines.push('  for (let i = 0; i < 50 && findChips().length === 0; i += 1) { await sleep(200); }');
    lines.push('  const chips = findChips();');
    lines.push('  if (chips.length === 0) {');
    lines.push(
      "    const all = Array.from(document.querySelectorAll('button')).map((b) => b.textContent.trim()).filter(Boolean);",
    );
    lines.push('    return JSON.stringify({ found: false, buttons: all.slice(0, 24) });');
    lines.push('  }');
    lines.push('  chips[0].click();');
    lines.push('  await sleep(900);');
  } else {
    // probe 用例：等页面把按钮渲染出来（说明模块/工具已挂载）
    lines.push("  for (let i = 0; i < 50 && document.querySelectorAll('button').length < 4; i += 1) { await sleep(200); }");
    lines.push('  await sleep(400);');
  }
  lines.push(
    // ⚠️ 用 `textarea, input` 而不是 `input[type="text"]`：**属性选择器只匹配写了 type 的元素**，
    // `<input>` 不带 type 时默认就是 text，但 `input[type="text"]` 匹配不到它 —— 会漏读输入框，
    // 产生「示例没填进去」这类完全虚假的失败（V25 的 text-lab 就是这么误报的）。
    "  const fields = Array.from(document.querySelectorAll('textarea, input')).map((e) => String(e.value));",
  );
  lines.push('  const body = document.body.innerText;');
  lines.push("  const hay = fields.join('\\n') + '\\n' + body;");
  lines.push('  let probe = null;');
  if (probeFn) {
    lines.push(`  try { probe = await (${String(probeFn)})(); } catch (e) { probe = { error: String(e) }; }`);
  }
  lines.push('  return JSON.stringify({ found: true, fields, body, hay, probe });');
  lines.push('})()');
  return lines.join('\n');
}

/**
 * 用例表。`check` 断言的是**用户能看到的后果**，不是内部状态：
 * 能查到派生结果（摘要 / 转码 / 换算 / 去重行数）就一并断言，
 * 这样「填了但算不出来」也逃不掉。
 */
const CASES = [
  // ——— V24 建立的用例（chip）———
  {
    id: 'timestamp',
    chip: '当前秒级',
    check: (r) => r.fields.some((v) => /^\d{10}$/.test(v)),
    detail: (r) => r.fields.find((v) => /^\d{10}$/.test(v)) ?? '',
  },
  {
    id: 'json-formatter',
    chip: '嵌套对象',
    // 示例数据（SAMPLE_JSON）里的字段是单数 `book`，别写成 books
    check: (r) => r.fields.some((v) => v.includes('"store"') && v.includes('"book"') && v.includes('vip')),
    detail: (r) => (r.fields.find((v) => v.includes('"store"')) ?? '').split('\n')[0],
  },
  {
    id: 'json-formatter',
    chip: 'JSONPath 查询',
    check: (r) => r.fields.some((v) => v.includes('$.store.book[0].title')),
    detail: (r) => r.fields.find((v) => v.includes('$.')) ?? '',
  },
  {
    id: 'base64-codec',
    chip: '解码回文本',
    check: (r) => r.body.includes('Handy 顺手'),
    detail: (r) => (r.body.match(/Handy 顺手[^\n]{0,20}/) ?? [''])[0],
  },
  {
    id: 'url-codec',
    chip: '中文查询转义',
    check: (r) => r.fields.some((v) => v.includes('%E9%A1%BA%E6%89%8B')),
    detail: (r) => (r.fields.find((v) => v.includes('%E9')) ?? '').slice(0, 60),
  },
  {
    id: 'hash-generator',
    chip: '一句话五算法',
    // 断言到「摘要本身算出来了」才算过 —— 只查输入框填没填不够
    check: (r) => r.fields.some((v) => v.includes('quick brown fox')) && r.body.includes('d7a8fbb3'),
    detail: (r) => (r.body.match(/d7a8fbb3\w{0,12}/) ?? [''])[0],
  },
  {
    id: 'password-generator',
    chip: '批量 10 条',
    check: (r) => (r.body.match(/\n/g) ?? []).length > 8,
    detail: () => '选项已切到批量 10 并重新生成',
  },
  {
    id: 'text-diff',
    chip: '配置改动',
    check: (r) =>
      r.fields.some((v) => v.includes('listen 8080')) && r.fields.some((v) => v.includes('listen 80')),
    detail: (r) => `${r.fields.filter((v) => v.includes('listen')).length} 个输入框已填`,
  },
  {
    id: 'qrcode-generator',
    chip: '网址',
    check: (r) => r.fields.some((v) => v.includes('github.com')),
    detail: (r) => r.fields.find((v) => v.includes('github')) ?? '',
  },

  // ——— V25 扩展：补齐「有示例条但此前没冒烟」的 11 个工具 ———
  {
    id: 'uuid-generator',
    chip: '5 条标准 v4',
    probe: probeUuid,
    check: (r) => (r.probe?.count ?? 0) >= 5,
    detail: (r) => `${r.probe?.count ?? 0} 条 · ${r.probe?.sample ?? ''}`,
  },
  {
    id: 'json-to-ts',
    chip: '接口返回体',
    // 断言到「接口真的生成出来了」：示例体里有 ip 字段，类型推导必须出现
    check: (r) => r.hay.includes('ops-web-01') && /interface\s+\w+/.test(r.hay) && /ip:\s*string/.test(r.hay),
    detail: (r) => (r.hay.match(/interface\s+\w+/g) ?? []).slice(0, 3).join(' / '),
  },
  {
    id: 'case-converter',
    chip: '变量名',
    check: (r) =>
      r.fields.includes('userProfileImageUrl') &&
      r.hay.includes('user_profile_image_url') &&
      r.hay.includes('user-profile-image-url'),
    detail: (r) => (r.hay.match(/user[_A-Za-z-]*/g) ?? []).slice(0, 4).join(' / '),
  },
  {
    id: 'text-dedup',
    chip: '日志刷屏去重',
    // 「去除 N 行重复」里的 N 必须 > 0 —— 只填进去不算，真的去掉了才算
    check: (r) => r.fields.some((v) => v.split('\n').length >= 5) && /去除\s*[1-9]\d*\s*行重复/.test(r.body),
    detail: (r) => (r.body.match(/结果（共[^）]*）/g) ?? [''])[0],
  },
  {
    id: 'text-lab',
    chip: 'Nginx 日志挑错',
    probe: probeTextLab,
    // 两件事都要成立：日志真的铺进去了，筛选词真的填成 502，且页面把它筛出来了
    check: (r) => (r.probe?.textLen ?? 0) > 200 && r.probe?.find502 === true && r.probe?.bodyHas502 === true,
    detail: (r) => `文本 ${r.probe?.textLen ?? 0} 字符 · 筛选框 502=${r.probe?.find502} · 页面含 502=${r.probe?.bodyHas502}`,
  },
  {
    id: 'csv-json',
    chip: '最小示例',
    check: (r) => r.fields.some((v) => v.includes('name,age,score')) && r.hay.includes('"age"') && r.hay.includes('99.5'),
    detail: (r) => (r.hay.match(/\{[^}]*"age"[^}]*\}/) ?? [''])[0].slice(0, 80),
  },
  {
    id: 'relative-time',
    chip: '3 天前',
    check: (r) => r.fields.some((v) => v.includes('2026-09-12')) && r.body.includes('天前'),
    detail: (r) => (r.body.match(/\d+\s*天前/g) ?? [''])[0],
  },
  {
    id: 'unit-converter',
    chip: '1 米 → 英尺',
    // 1 m = 3.28084 ft，结果区必须真的出现这一行
    check: (r) => /3\.28\d*/.test(r.hay) && r.hay.includes('英尺'),
    detail: (r) => (r.hay.match(/3\.28\d*/) ?? [''])[0],
  },
  {
    id: 'file-size',
    chip: '1 MiB 是多少',
    check: (r) => /1[,.]?048[,.]?576/.test(r.hay) && r.hay.includes('MiB'),
    detail: (r) => (r.hay.match(/1[,.]?048[,.]?576/) ?? [''])[0],
  },
  {
    id: 'slug-generator',
    chip: '英文标题',
    check: (r) => r.hay.includes('deploy-tauri-app-to-windows'),
    detail: (r) => (r.hay.match(/deploy-tauri[^\s]*/) ?? [''])[0],
  },
  {
    id: 'ascii-table',
    chip: '中英混排',
    // 顺 = U+987A、手 = U+624B，码点表必须是这两个值（证明按码点而非 UTF-16 单元拆）
    check: (r) => r.fields.includes('Handy 顺手 2026') && r.hay.includes('0x987A') && r.hay.includes('0x624B'),
    detail: (r) => (r.hay.match(/0x(987A|624B)/g) ?? []).join(' '),
  },
  {
    id: 'password-generator',
    chip: '16 位通用',
    probe: probePassword16,
    // V25 的两条硬要求：符号 ≤ 25%（16 位里 ≤ 4 个）+ 不连排
    check: (r) => {
      const p = r.probe ?? {};
      return (p.count ?? 0) >= 1 && p.symbols <= 4 && p.adjacent === false && p.pw.length === 16;
    },
    detail: (r) => `${r.probe?.pw ?? ''}（符号 ${r.probe?.symbols ?? '?'} 个，连排=${r.probe?.adjacent}）`,
  },

  // ——— V25 扩展：没有示例条、但界面本身就是验收对象的 probe 用例 ———
  {
    id: 'regex-tester',
    probe: probeRegexBadges,
    // 30 条正则全部自带命中数：出现「示例不匹配 / 正则无效」就是回归
    check: (r) => (r.probe?.hits ?? 0) >= 25 && r.probe?.zero === 0 && r.probe?.broken === 0,
    detail: (r) => `${r.probe?.hits ?? 0} 条自报命中数，零命中 ${r.probe?.zero ?? '?'} 条，无效 ${r.probe?.broken ?? '?'} 条`,
  },
  {
    id: 'desktop-organizer',
    url: '?module=desktop-organizer',
    probe: probeDesktopConsole,
    check: (r) =>
      r.probe?.tabFound === true &&
      r.probe?.hasFilesTab === true &&
      r.probe?.hasWorkDir === true &&
      r.probe?.hasMoveHint === true &&
      r.probe?.gridHint === true,
    detail: (r) =>
      `首屏=归类文件 ✓ 作用目录 ✓ 真移动提示 ✓ 切页签后=不移动 ${r.probe?.gridHint ? '✓' : '✗'}`,
  },
];

async function waitReady() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/index.html`);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  const cases = only === null ? CASES : CASES.filter((c) => only.includes(c.id));
  if (cases.length === 0) throw new Error('--only 没有匹配到任何用例');

  const server = spawn(process.execPath, [path.join(ROOT, 'scripts/dev-static.cjs'), String(PORT)], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  const lines = [];
  /**
   * 逐条**立即**落地并回显：曾经因为「全部跑完才输出」，一次卡死让我完全看不出
   * 卡在哪个用例上（日志 0 字节）。冒烟脚本本身要能定位自己卡在哪。
   */
  const say = (text = '') => {
    lines.push(text);
    console.log(text);
    try {
      fs.mkdirSync('_shots/audit', { recursive: true });
      fs.writeFileSync('_shots/audit/sample-smoke.log', lines.join('\n') + '\n', 'utf8');
    } catch {
      /* 落盘失败不影响冒烟本身 */
    }
  };
  let exitCode = 0;

  try {
    if (!(await waitReady())) throw new Error('dev-static 未就绪（dist 是否已构建？）');
    say(`dev-static ready（http://127.0.0.1:${PORT}，root=dist 真实构建产物）`);
    say();

    let pass = 0;
    let fail = 0;
    let opened = null;
    let openedCount = 0;

    for (const item of cases) {
      const chip = item.chip;
      if (item.id !== opened) {
        opened = item.id;
        const t0 = Date.now();
        // 首次 open 要**冷启动无头浏览器**（实测 60~90 秒），给足超时；
        // 同一个浏览器会话内换页只要 ~0.3 秒。
        const nav = await ab(
          ['open', `http://127.0.0.1:${PORT}/index.html${item.url ?? `?tool=${item.id}`}`],
          openedCount === 0 ? 180_000 : 60_000,
        );
        openedCount += 1;
        say(
          `-- ${item.id}${item.url ? ` (${item.url})` : ''}  [open ${Date.now() - t0}ms${nav.status === 0 ? '' : ` status=${nav.status}`}]`,
        );
      }
      const t1 = Date.now();
      let res = await ab(['eval', buildScript(chip, item.probe)]);
      let data = parseEval(res.stdout);
      if (!data) {
        // 首次冷启动可能把 open 卡到超时（浏览器仍在起来）→ 给一次重试
        await new Promise((r) => setTimeout(r, 2000));
        res = await ab(['eval', buildScript(chip, item.probe)]);
        data = parseEval(res.stdout);
      }
      if (!data || data.found !== true) {
        fail += 1;
        say(
          `  FAIL  找不到 chip「${chip ?? '(probe 用例)'}」：${JSON.stringify((data && data.buttons) ?? res.stdout.slice(0, 160))}`,
        );
        continue;
      }
      if (item.check(data)) {
        pass += 1;
        say(`  PASS  「${chip ?? 'probe'}」→ ${String(item.detail(data)).slice(0, 90)}`);
      } else {
        fail += 1;
        say(
          `  FAIL  「${chip ?? 'probe'}」没有产生预期结果${data.probe ? `：${JSON.stringify(data.probe).slice(0, 200)}` : ''}`,
        );
      }
      say(`        （本用例 ${Date.now() - t1}ms）`);
    }
    await ab(['close'], 20_000);

    say();
    say(`PASS ${pass}`);
    say(`FAIL ${fail}`);
    say(`===== ${fail === 0 ? '示例条 / 关键功能全部可用' : '有用例未生效'} =====`);
    exitCode = fail === 0 ? 0 : 1;
  } catch (error) {
    say(`冒烟失败：${error.message}`);
    exitCode = 2;
  } finally {
    server.kill();
  }

  fs.writeFileSync('_shots/audit/sample-smoke.log', lines.join('\n') + '\n', 'utf8');
  console.log(lines.join('\n'));
  process.exit(exitCode);
}

main();
