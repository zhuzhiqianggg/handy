#!/usr/bin/env node
/**
 * 当日日志补两笔：示例条功能冒烟的结果，以及它被转正为常驻工具这件事。
 */
const fs = require('node:fs');
const path = require('node:path');
const FILE = path.join(process.cwd(), '.workbuddy/memory/2026-09-16.md');
let s = fs.readFileSync(FILE, 'utf8');

function swap(needle, repl, label) {
  const n = s.split(needle).length - 1;
  if (n !== 1) throw new Error(`${label}：锚点命中 ${n} 次`);
  s = s.split(needle).join(repl);
  console.log(`  ✓ ${label}`);
}

swap(
  '| 脚手架 | 生成 → `tsc`=0 → 清理 → `tsc`=0 |',
  '| 脚手架 | 生成 → `tsc`=0 → 清理 → `tsc`=0 |\n' +
    '| **示例条功能冒烟** | **9 / 9 用例生效**（真实 dist + 无头浏览器逐个点 chip，回读输入框与派生结果） |',
  '验证表补示例条冒烟',
);

swap(
  '> **打包插曲（值得记）**',
  '### 7. 顺带转正了一个工具：`scripts/audit/sample-smoke.mjs`\n' +
    '\n' +
    '写完示例条后意识到一件事：**`tool-audit` 只能静态证明「文件里写了 `samples=`」，证明不了\n' +
    '「用户点下去真的填进去了」**；`layout-audit` 只量几何、不点按钮。而示例条恰恰是用户冷启动一个\n' +
    '空工具时唯一的抓手 —— 「示例条写了但 apply 闭包填错字段」这类错，两个工具都拦不住。\n' +
    '\n' +
    '于是写了一次性冒烟脚本：在真实 `dist` + 无头浏览器里逐个点击示例 chip，回读输入框与页面正文断言，\n' +
    '**连「填完以后派生结果算不算得出来」一起验**（哈希工具点「一句话五算法」后，页面上必须真的出现\n' +
    '那段文本的 SHA-256 `d7a8fbb3…`）。9/9 通过后转正常驻工具并写进两份文档。\n' +
    '\n' +
    '> 过程中它先报了一次假失败 —— 断言里写的是 `books`，而示例数据（`SAMPLE_JSON`）里字段是单数 `book`。\n' +
    '> **断言写错和代码写错，表现完全一样**；所以断言里的字面量也要对着数据核一遍，别凭印象写。\n' +
    '\n' +
    '> **打包插曲（值得记）**',
  '补第 7 节',
);

fs.writeFileSync(FILE, s, 'utf8');
