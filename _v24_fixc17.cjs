#!/usr/bin/env node
/**
 * 修正：约束 17 被插到了文件末尾（§6 的编号列表之后），因为「最后一条 `^\d+\. \*\*`」匹配到的是
 * §6 的「1. **先跑五绿…**」。这里把它挪回 §3 的约束 16 之后。
 */
const fs = require('node:fs');
const path = require('node:path');
const FILE = path.join(process.cwd(), '.workbuddy/PROJECT_STATUS.md');

const lines = fs.readFileSync(FILE, 'utf8').split('\n');

// 1) 摘出错位的块（以「17. **布局审计」开头，到下一个空行为止）
const bad = lines.findIndex((l) => l.startsWith('17. **布局审计'));
if (bad < 0) throw new Error('找不到错位的约束 17');
let badEnd = bad;
while (badEnd < lines.length && lines[badEnd].trim() !== '') badEnd += 1;
const block = lines.slice(bad, badEnd);
if (block.length !== 5) throw new Error(`错位块行数异常：${block.length}`);
lines.splice(bad, block.length);
// 顺带把多出来的尾随空行收敛成一行
while (lines.length > 1 && lines[lines.length - 1].trim() === '' && lines[lines.length - 2].trim() === '') {
  lines.pop();
}

// 2) 插到 §3 约束 16 段落之后
const c16 = lines.findIndex((l) => l.startsWith('16. **'));
if (c16 < 0) throw new Error('找不到约束 16');
let insertAt = c16 + 1;
while (insertAt < lines.length && lines[insertAt].trim() !== '') insertAt += 1;
lines.splice(insertAt, 0, ...block);

fs.writeFileSync(FILE, lines.join('\n'), 'utf8');

// 3) 复核
const a = fs.readFileSync(FILE, 'utf8').split('\n');
const i = a.findIndex((l) => l.startsWith('17. **布局审计'));
console.log('约束 17 现在位于第 ' + (i + 1) + ' 行；上一层上下文：');
a.slice(i - 4, i + 6).forEach((l, n) => console.log('  ' + (i - 3 + n) + ': ' + l.slice(0, 120)));
console.log('\n§3 编号约束：' + a.filter((l) => /^\d+\. \*\*/.test(l) && a.indexOf(l) > 380).length + ' 条（该段落区间内）');
