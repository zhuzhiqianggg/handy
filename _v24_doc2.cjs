#!/usr/bin/env node
/**
 * 把新转正的 `scripts/audit/sample-smoke.mjs` 写进文档，并修掉一处编号引用笔误。
 */
const fs = require('node:fs');
const path = require('node:path');
const log = [];
const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const write = (p, s) => fs.writeFileSync(path.join(process.cwd(), p), s, 'utf8');

function swap(text, needle, repl, label) {
  const count = text.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}：锚点命中 ${count} 次 —— ${needle.slice(0, 60)}`);
  log.push(`  ✓ ${label}`);
  return text.split(needle).join(repl);
}

// ——— PROJECT_STATUS：编号笔误 + 新增示例条冒烟命令 ———
{
  let s = read('.workbuddy/PROJECT_STATUS.md');
  log.push('PROJECT_STATUS.md');
  const anchor = '#   ⚠️ 跑完它会吃光本回合的删除额度 —— 别在同一个回合里接着 vite build（见 §3 约束 17）';
  s = swap(
    s,
    anchor,
    anchor.replace('§3 约束 17', '§3 约束 18') +
      '\n' +
      '\n' +
      '# 示例条功能冒烟（V24 起；改了任何工具的 samples 就该跑）\n' +
      '#   静态自检只能证明「文件里写了 samples=」，证明不了「点下去真填进去了」——\n' +
      '#   本脚本在真实 dist + 无头浏览器里逐个点 chip，再读回输入框与页面正文断言\n' +
      '#   （连「填完以后派生结果算不算得出来」一起验：哈希工具点了示例必须真出现那段摘要）\n' +
      '#   同样会吃删除额度（要开关浏览器），别和 vite build 放同一回合\n' +
      'node scripts/audit/sample-smoke.mjs\n' +
      'node scripts/audit/sample-smoke.mjs --only=timestamp,hash-generator',
    '§4 示例条冒烟命令',
  );
  write('.workbuddy/PROJECT_STATUS.md', s);
}

// ——— TOOL-AUTHORING：指南里点出这一步 ———
{
  let s = read('docs/03-development/TOOL-AUTHORING.md');
  log.push('TOOL-AUTHORING.md');
  s = swap(
    s,
    '   > 示例里出现的哈希 / Base64 / 时间戳**必须真算过再写进去**（V24 的 8 个工具示例条就是这么来的）。\n   > 编一个「看起来像」的摘要值，用户点开校验会直接对不上，比没有示例更糟。',
    '   > 示例里出现的哈希 / Base64 / 时间戳**必须真算过再写进去**（V24 的 8 个工具示例条就是这么来的）。\n' +
      '   > 编一个「看起来像」的摘要值，用户点开校验会直接对不上，比没有示例更糟。\n' +
      '   >\n' +
      '   > 写完跑一遍 `node scripts/audit/sample-smoke.mjs` —— 它会在真实产物里点你的 chip 并断言结果。\n' +
      '   > 如果这个工具也值得进冒烟，就在脚本的 `CASES` 里加一条用例（`check` 要断言**用户能看到的后果**，\n' +
      '   > 不是内部状态）。',
    '§3 示例条补冒烟指引',
  );
  s = swap(
    s,
    '- [ ] 示例条 3-5 条，数据是真实场景，**里面的哈希 / Base64 / 时间戳都真算过**',
    '- [ ] 示例条 3-5 条，数据是真实场景，**里面的哈希 / Base64 / 时间戳都真算过**\n' +
      '- [ ] `node scripts/audit/sample-smoke.mjs` —— 本工具的示例 chip 在真实产物里点了确实生效\n' +
      '      （新工具建议往脚本 `CASES` 里补一条用例）',
    '§7 清单补冒烟项',
  );
  write('docs/03-development/TOOL-AUTHORING.md', s);
}

console.log(log.join('\n'));
