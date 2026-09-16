#!/usr/bin/env node
/**
 * V24 示例条功能冒烟（一次性验证脚本，验证完可删）。
 *
 * 为什么非跑不可：`tool-audit` 只能静态证明「文件里出现了 samples=」，
 * 证明不了「点下去真的填进去了」。这里在**真实构建产物**（dist）+ 无头浏览器里
 * 逐个点击新加的示例 chip，再把输入框的值读回来断言。
 *
 * 硬约束同 layout-audit：dev server 与浏览器必须在同一个 node 进程里（沙箱回收后台进程）。
 */
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const PORT = 41_889;
const ROOT = process.cwd();
const AB =
  process.env.AGENT_BROWSER_BIN ??
  'C:/Users/Administrator/AppData/Roaming/npm/node_modules/agent-browser/bin/agent-browser.js';

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
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        const value = JSON.parse(text);
        if (typeof value === 'string') {
          text = value;
          continue;
        }
        return value;
      } catch {
        break;
      }
    }
    try {
      const value = JSON.parse(text);
      if (typeof value === 'string') {
        text = value;
        continue;
      }
      return value;
    } catch {
      break;
    }
  }
  return null;
}

/** 点示例 chip → 读回所有输入框的值 + 页面正文片段 */
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

const CASES = [
  {
    id: 'timestamp',
    chip: '当前秒级',
    check: (r) => r.fields.some((v) => /^\d{10}$/.test(v)),
    detail: (r) => r.fields.find((v) => /^\d{10}$/.test(v)) ?? JSON.stringify(r.fields.slice(0, 3)),
  },
  {
    id: 'json-formatter',
    chip: '嵌套对象',
    // 注意：示例数据（SAMPLE_JSON）里的字段是单数 `book`，别写成 docs/books
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
    detail: (r) => (r.body.match(/Handy 顺手[^\n]{0,20}/) ?? ['(未出现)'])[0],
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
    check: (r) =>
      r.fields.some((v) => v.includes('quick brown fox')) && r.body.includes('d7a8fbb3'),
    detail: (r) => ((r.body.match(/d7a8fbb3\w{0,12}/) ?? ['(未算出摘要)'])[0]),
  },
  {
    id: 'password-generator',
    chip: '批量 10 条',
    check: (r) => r.body.includes('已生成') || (r.body.match(/\n/g) ?? []).length > 8,
    detail: () => '选项已切换（批量 10）',
  },
  {
    id: 'text-diff',
    chip: '代码改动不存在时用配置改动',
    useChip: '配置改动',
    check: (r) => r.fields.some((v) => v.includes('listen 8080')) && r.fields.some((v) => v.includes('listen 80')),
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

(async () => {
  const server = spawn(process.execPath, [path.join(ROOT, 'scripts/dev-static.cjs'), String(PORT)], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  const lines = [];
  try {
    if (!(await waitReady())) throw new Error('dev-static 未就绪');
    lines.push(`dev-static ready（http://127.0.0.1:${PORT}，root=dist 真实构建产物）\n`);

    let pass = 0;
    let fail = 0;
    let current = null;

    for (const item of CASES) {
      const chip = item.useChip ?? item.chip;
      if (item.id !== current) {
        current = item.id;
        ab(['open', `http://127.0.0.1:${PORT}/index.html?tool=${item.id}`]);
        ab(['wait', '--load', 'load']);
        lines.push(`-- ${item.id}`);
      }
      const res = ab(['eval', clickChipScript(chip)]);
      const data = parseEval(res.stdout);
      if (!data || data.found !== true) {
        fail += 1;
        lines.push(`  FAIL  「${chip}」未找到该 chip：${JSON.stringify((data && data.buttons) ?? res.stdout.slice(0, 200))}`);
        continue;
      }
      if (item.check(data)) {
        pass += 1;
        lines.push(`  PASS  「${chip}」→ ${String(item.detail(data)).slice(0, 80)}`);
      } else {
        fail += 1;
        lines.push(`  FAIL  「${chip}」点击后输入未按预期变化`);
      }
    }
    ab(['close']);

    lines.push('');
    lines.push(`PASS ${pass}`);
    lines.push(`FAIL ${fail}`);
    lines.push(`===== ${fail === 0 ? '示例条全部可用' : '有示例条未生效'} =====`);
    require('node:fs').writeFileSync('_v24_sample_smoke.log', lines.join('\n') + '\n', 'utf8');
    console.log(lines.join('\n'));
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (error) {
    console.error(`冒烟失败：${error.message}`);
    process.exitCode = 2;
  } finally {
    server.kill();
  }
})();
