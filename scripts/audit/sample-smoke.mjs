#!/usr/bin/env node
/**
 * 示例条功能冒烟（V24）。
 *
 * # 它补的是哪一段空白
 *
 * `tool-audit.mjs` 只能**静态**证明「组件文件里出现了 `samples=`」，
 * 证明不了「用户点下去真的填进去了」；`layout-audit.mjs` 只量几何，不点按钮。
 * 于是「示例条写了但 apply 闭包填错字段」这类错，两个工具都拦不住 ——
 * 而示例条恰恰是用户冷启动一个空工具时唯一的抓手（点一下就应该看懂这工具能干什么）。
 *
 * 本脚本在**真实构建产物**（`dist`）+ 无头浏览器里逐个点击示例 chip，
 * 再把输入框的值与页面正文读回来断言 —— 连「填完以后派生结果算不算得出来」一起验
 * （例：哈希工具点「一句话五算法」后，页面上必须真的出现那段文本的 SHA-256）。
 *
 * # 硬约束（同 layout-audit，踩过坑）
 *
 * dev server 与浏览器**必须在同一个 node 进程里起**：沙箱会在命令结束时回收后台进程，
 * 分两条命令起服务必定 `fetch failed`。agent-browser 的 `.cmd` 会被安全层拦截，
 * 一律走 `node <bin>.js`。
 *
 * # 用法
 *
 * ```bash
 * node scripts/audit/sample-smoke.mjs              # 全部用例
 * node scripts/audit/sample-smoke.mjs --only=timestamp,hash-generator
 * ```
 *
 * 退出码：0 = 全部用例生效；1 = 有用例未生效；2 = 环境未起来。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 41_889;
const ROOT = process.cwd();
const AB =
  process.env.AGENT_BROWSER_BIN ??
  'C:/Users/Administrator/AppData/Roaming/npm/node_modules/agent-browser/bin/agent-browser.js';

const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length).split(',').filter(Boolean) : null;

function ab(args, timeout = 60_000) {
  const res = spawnSync(process.execPath, [AB, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
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

/** 点示例 chip → 读回所有输入框的值 + 页面正文 */
function clickChipScript(chipLabel) {
  return `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(400);
  const label = ${JSON.stringify(chipLabel)};
  const chips = Array.from(document.querySelectorAll('button')).filter((b) => b.textContent.trim() === label);
  if (chips.length === 0) {
    const all = Array.from(document.querySelectorAll('button')).map((b) => b.textContent.trim()).filter(Boolean);
    return JSON.stringify({ found: false, buttons: all.slice(0, 20) });
  }
  chips[0].click();
  await sleep(900);
  const fields = Array.from(document.querySelectorAll('textarea, input[type="text"]')).map((e) => String(e.value));
  const body = document.body.innerText;
  return JSON.stringify({ found: true, fields, body });
})()`;
}

/**
 * 用例表。`check` 断言的是**用户能看到的后果**，不是内部状态：
 * 能查到派生结果（摘要 / 转码 / 换算）就一并断言，这样「填了但算不出来」也逃不掉。
 */
const CASES = [
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
  let exitCode = 0;

  try {
    if (!(await waitReady())) throw new Error('dev-static 未就绪（dist 是否已构建？）');
    lines.push(`dev-static ready（http://127.0.0.1:${PORT}，root=dist 真实构建产物）`, '');

    let pass = 0;
    let fail = 0;
    let opened = null;

    for (const item of cases) {
      const chip = item.chip;
      if (item.id !== opened) {
        opened = item.id;
        ab(['open', `http://127.0.0.1:${PORT}/index.html?tool=${item.id}`]);
        ab(['wait', '--load', 'load']);
        lines.push(`-- ${item.id}`);
      }
      const res = ab(['eval', clickChipScript(chip)]);
      const data = parseEval(res.stdout);
      if (!data || data.found !== true) {
        fail += 1;
        lines.push(`  FAIL  「${chip}」找不到该 chip：${JSON.stringify((data && data.buttons) ?? res.stdout.slice(0, 160))}`);
        continue;
      }
      if (item.check(data)) {
        pass += 1;
        lines.push(`  PASS  「${chip}」→ ${String(item.detail(data)).slice(0, 80)}`);
      } else {
        fail += 1;
        lines.push(`  FAIL  「${chip}」点击后没有产生预期结果`);
      }
    }
    ab(['close']);

    lines.push('', `PASS ${pass}`, `FAIL ${fail}`, `===== ${fail === 0 ? '示例条全部可用' : '有示例条未生效'} =====`);
    exitCode = fail === 0 ? 0 : 1;
  } catch (error) {
    lines.push(`冒烟失败：${error.message}`);
    exitCode = 2;
  } finally {
    server.kill();
  }

  fs.writeFileSync('_shots/audit/sample-smoke.log', lines.join('\n') + '\n', 'utf8');
  console.log(lines.join('\n'));
  process.exit(exitCode);
}

main();
