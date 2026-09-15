import React, { useCallback, useEffect, useRef, useState } from 'react';
import { highlightCodeHtml, isSupportedLang, normalizeLang } from '@/components/CodeBlock';
import { renderMarkdown } from '@/lib/markdown';
import { cn } from '@/lib/utils';
import '@/styles/markdown.css';

/**
 * 所见即所得 Markdown 输入（RichMarkdown）。
 *
 * # 为什么需要它
 *
 * `MarkdownEditor` 是「源码 + 预览」双栏式：编辑区永远显示 `**加粗**` 这类**语法**，
 * 想看效果得扭头看另一半。用户真正要的是**边写边渲染**——敲完 `**今天**` 这四个字
 * 加两个星号，屏上就该直接变成**加粗的「今天」**，而不是留着星号让人自己脑补。
 * 于是有了本组件。
 *
 * # 实现路线（为什么是 contenteditable 而不是 textarea）
 *
 * `textarea` 只能承载纯文本，不可能做到「同一处既是输入又是渲染结果」，
 * 因此改用 `contentEditable` 容器，并在**输入事件里就地做两类转换**：
 *
 * 1. **行内即时转换**：光标前刚闭合的 `**x**` / `*x*` / `~~x~~` / `` `x` `` 立刻
 *    被替换成 `<strong>/<em>/<del>/<code>` 元素——**只改动刚输入的那一小段**，
 *    因此光标位置天然稳定，不会出现「打字打到一半被打断」的跳光标问题。
 * 2. **块级前缀转换**：行首敲出 `# ` / `- ` / `1. ` / `> ` / `[] ` 后，整块被
 *    提升为对应的块元素（标题 / 列表 / 引用 / 任务项），与 Typora、Notion 的习惯一致。
 *
 * 反向（DOM → Markdown）由 `serializeBlocks()` 负责，因此对外**始终只暴露 Markdown
 * 文本**：宿主照旧存 markdown、照旧用 `renderMarkdown()` 做只读展示，数据格式零迁移。
 *
 * # 边界处理
 *
 * - **外部值回灌**：只有 props.value 与「自己刚发出的值」不一致时才重建 DOM，
 *   否则每次输入都会重建内容、光标必丢；
 * - **粘贴**：只取纯文本，避免从网页粘进一堆内联样式把结构冲烂；
 * - **空态占位**：内容为空时显示 placeholder（CSS 伪元素做不到 `:empty` 判定，
 *   因为浏览器会在空块里塞 `<br>`，故用显式标记 + 真实节点）。
 *
 * # 浏览器内核踩过的坑（改这里之前务必先读）
 *
 * 这一层的每一处别扭都是为了绕开 `contentEditable` 的默认脾气。冒烟脚本见
 * `_smoke_drive.js`（用 `execCommand('insertText')` 逐字符驱动，读状态前要
 * `await` 一个 tick 让 React 把值刷出去，否则读到的永远是上一帧）。
 *
 * 1. **样式延续**：敲完 `**粗体**` 后光标若停在元素边界，Chrome 会把接下来敲的
 *    字继续塞进 `<strong>` 里。位置必须是「哨兵文本节点内的 offset 1」——
 *    offset 0、以及 `setStartAfter(el)` 都会延续样式。见 `convertInline`。
 * 2. **空文本节点会被回收**：拿 `createTextNode('')` 当锚点没用，浏览器在选区
 *    规范化时直接丢掉。必须用 `ZWSP` 哨兵。
 * 3. **`**x**` 的星号歧义**：逐字符输入时，第 5 个字符 `*` 会先命中单星号规则，
 *    把 `*x*` 提前变成斜体。斜体规则加了 `(?<!\*)` 前瞻断言来避让。
 * 4. **空块吞光标**：给空元素 `placeCaretAtEnd` 无效，光标会被挤回上一行。
 *    新块一律带一颗零宽种子，见 `withCaretSeed`。
 * 5. **搬动节点会重置选区**：把裸内容包进 `<div>` 后，浏览器把选区丢到容器开头，
 *    于是后续每个字符都插到行首。`wrapInlineRunAtCaret` 里必须手动还原光标。
 * 6. **零宽哨兵会混进块级标记判定**：`marker` 必须先 `stripZwsp`，否则
 *    `^#\s$` 之类的规则永远匹配不上。
 *
 * 已知取舍：在**列表项内部**敲 `> ` / `# ` 这类块级标记不会转换（列表项不是
 * 顶层块，直接替换会破坏 `<ul>` 结构），会原样保留为文本。
 *
 * # V21 增强：代码块能多行、能高亮、带语言
 *
 * 用户反馈「``` 只有一行输入不能换行等，也没有语法高亮等」。三处根因与对策：
 *
 * 1. **只有一行** —— 浏览器在 `<pre>` 里按回车默认会**跑出代码块**（另起一个
 *    `<div>`），于是代码块永远只有一行。现在回车改为**手工插入 `\n` 文本节点**
 *    留在块内；在「末行本来就是空行」时按回车才跳出（与三引号收尾的习惯一致），
 *    `Esc` 也随时可跳出。
 * 2. **没有语言** —— 围栏规则从只认裸 ``` ``` ``` 扩展为 ```` ```lang ````，
 *    语言记在 `pre.dataset.lang`；顺手支持「先起块、再敲 `shell` 回车」的写法
 *    （仅当该词是**内置高亮语言**时才认，避免把一行 `ls` 吃掉）。
 * 3. **没有高亮** —— 复用 `CodeBlock` 的同一套词法规则，把 `pre > code` 的内容
 *    重建为带颜色的 `<span>`。重建会动 DOM、可能丢光标，因此：
 *    - 只在内容**真的变了**时重建（`hlKey` 比对，避免无谓抖动）；
 *    - 重建前后按**可见字符偏移**保存 / 还原光标；
 *    - 光标落在边界（块首 / 块尾）时插一颗 `ZWSP` 哨兵再落光标 ——
 *      沿用行内转换那套「哨兵断样式继承」的老办法，避免接着敲的字继续染成
 *      上一个 token 的颜色。
 *
 * 输入期高亮走 400ms 空转去抖：连续敲字时不动 DOM，停一拍颜色就上。
 */

export interface RichMarkdownProps {
  /** 当前 Markdown 源文本（受控；宿主存的就是它） */
  value: string;
  /** 内容变更回调（markdown 文本） */
  onChange: (next: string) => void;
  /** 空内容占位提示 */
  placeholder?: string;
  /** 附加样式（通常用来控制高度 / 内边距） */
  className?: string;
  /** 只读模式：仅渲染不可编辑（查看态用） */
  readOnly?: boolean;
  /**
   * 单行模式（任务标题用）：回车不换行，改为触发 `onEnter`。
   */
  singleLine?: boolean;
  /** 单行模式下回车触发 */
  onEnter?: () => void;
  /** 失焦（宿主可借此立即落库，不必等防抖） */
  onBlur?: () => void;
  /** 聚焦（宿主可据此暂停「远端内容覆盖本地草稿」，避免打字被打断） */
  onFocus?: () => void;
  /** 无障碍标签 */
  ariaLabel?: string;
}

/**
 * 代码块高亮去抖（毫秒）。
 *
 * 连续敲字期间不动 DOM（改 DOM 就可能动光标），停一拍再把颜色补上 ——
 * 视觉上仍是「随时渲染」，但把光标抖动的风险压到最低。
 */
const HIGHLIGHT_DEBOUNCE_MS = 400;

/**
 * 每个 `pre` 最近一次高亮对应的内容指纹。
 *
 * 用 `WeakMap` 而不是 `dataset`：指纹里含整段代码，写进 DOM 属性会让每次
 * 高亮都触发一次属性序列化。内容没变就不重建 DOM，是「光标不乱跳」的前提。
 */
const highlightedKeys = new WeakMap<HTMLElement, string>();

/** 行内即时转换规则（顺序敏感：`**` 必须早于 `*`，否则会被单星号规则截胡） */
const INLINE_RULES: ReadonlyArray<{ re: RegExp; tag: string }> = [
  { re: /\*\*([^*\n]+)\*\*$/, tag: 'strong' },
  { re: /~~([^~\n]+)~~$/, tag: 'del' },
  { re: /`([^`\n]+)`$/, tag: 'code' },
  // `(?<!\*)` 是关键：用户敲 `**粗体**` 时，第 5 个字符 `*` 会**先**命中单星号规则，
  // 把 `*粗体*` 提前变成斜体；等第 6 个 `*` 落下来已经回不去了（`*<em>粗体</em>*`）。
  // 要求开星号前面不能再是 `*`，就把「连续星号」整体让给 `**` 规则去消化。
  { re: /(?<!\*)\*([^*\n]+)\*$/, tag: 'em' },
];

/** 块级前缀规则（匹配「标记 + 尾随空格」或独占围栏） */
interface BlockRule {
  re: RegExp;
  /** 目标标签：`h1`~`h6` / `ul` / `ol` / `task` / `quote` / `pre` */
  kind: string;
}

const BLOCK_RULES: readonly BlockRule[] = [
  { re: /^(#{1,6})\s$/, kind: 'h' },
  // 围栏代码块：裸 ``` ``` ``` 与带语言的 ```` ```shell ```` 都认；语言由捕获组带出
  { re: /^```([A-Za-z0-9+#._-]*)$/, kind: 'pre' },
  { re: /^>\s$/, kind: 'quote' },
  { re: /^\[[ xX]?\]\s$/, kind: 'task' },
  { re: /^[-*+]\s$/, kind: 'ul' },
  { re: /^\d+[.)]\s$/, kind: 'ol' },
];

/** 光标移到元素内容末尾 */
function placeCaretAtEnd(el: HTMLElement): void {
  const range: Range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const selection: Selection | null = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** 取光标所在位置的直接块级子元素（`root` 的孩子） */
function directBlockOf(root: HTMLElement, node: Node): HTMLElement | null {
  let current: Node | null = node;
  while (current && current.parentNode !== root) {
    current = current.parentNode;
  }
  if (current && current.nodeType === Node.ELEMENT_NODE) {
    return current as HTMLElement;
  }
  return null;
}

/** 节点是否属于「行内内容」（裸文本 / 行内元素） */
function isInlineNode(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) {
    return true;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return false;
  }
  return !BLOCK_TAGS.has((node as HTMLElement).tagName.toLowerCase());
}

/**
 * 光标所在「块」的兜底：编辑器还空着时，浏览器把用户敲的第一笔直接挂在根节点上
 * （不套 `<div>`），此时没有块元素可供替换。这里把光标所在的这段连续行内内容
 * 就地包进一个 `<div>`，让后续逻辑与「已经有块」的情况完全一致
 * —— 否则在新笔记里敲 `# ` 永远变不出标题。
 *
 * @returns 包裹后的容器；光标不在根的直接子节点上时返回 null
 */
function wrapInlineRunAtCaret(root: HTMLElement, node: Node): HTMLElement | null {
  if (node.parentNode !== root) {
    return null;
  }
  // 先记下光标：`appendChild` 搬动节点会让浏览器把选区重置到新容器开头，
  // 若不还原，接着敲的每个字符都会插到行首（曾导致 `**粗体**` 退化成 `*<em>粗体</em>**`）。
  const selection: Selection | null = window.getSelection();
  const live: Range | null =
    selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  const savedNode: Node | null = live ? live.startContainer : null;
  const savedOffset: number = live ? live.startOffset : 0;

  const children: Node[] = Array.from(root.childNodes);
  const anchor: number = children.indexOf(node);
  if (anchor < 0) {
    return null;
  }
  let start: number = anchor;
  let end: number = anchor;
  while (start - 1 >= 0 && isInlineNode(children[start - 1]!)) {
    start -= 1;
  }
  while (end + 1 < children.length && isInlineNode(children[end + 1]!)) {
    end += 1;
  }

  const wrapper: HTMLElement = document.createElement('div');
  const after: Node | undefined = children[end + 1];
  if (after) {
    root.insertBefore(wrapper, after);
  } else {
    root.appendChild(wrapper);
  }
  for (let i: number = start; i <= end; i += 1) {
    wrapper.appendChild(children[i]!);
  }

  // 还原光标（节点仍在文档里就按原偏移放回，否则退化为行尾）
  if (savedNode && savedNode.parentNode) {
    const maxOffset: number =
      savedNode.nodeType === Node.TEXT_NODE
        ? (savedNode.nodeValue ?? '').length
        : savedNode.childNodes.length;
    const restore: Range = document.createRange();
    restore.setStart(savedNode, Math.min(savedOffset, maxOffset));
    restore.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(restore);
  } else {
    placeCaretAtEnd(wrapper);
  }
  return wrapper;
}

/** 取当前折叠光标的 (文本节点, 偏移)；非折叠或不在文本节点上时返回 null */
function caretInTextNode(): { node: Text; offset: number } | null {
  const selection: Selection | null = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return null;
  }
  const range: Range = selection.getRangeAt(0);
  if (!range.collapsed) {
    return null;
  }
  const node: Node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) {
    return null;
  }
  return { node: node as Text, offset: range.startOffset };
}

// —— DOM → Markdown 序列化 ——

/**
 * 零宽空格（U+200B），只作**光标锚点**用，绝不进入 Markdown 文本。
 *
 * 为什么不能用「空文本节点」当锚点：转换完把光标放进 `createTextNode('')` 后，
 * 浏览器在选区规范化时会把空文本节点直接丢掉，光标随即被并回前面的
 * `<strong>` / `<em>` 里 —— 于是接着敲的普通文字莫名其妙继承加粗，
 * 敲 `*斜体*` 又叠成 `***斜体***`。带一个零宽字符的文本节点非空、不会被回收，
 * 光标才能稳稳停在格式之外；序列化时统一剥掉即可。
 */
const ZWSP = '\u200B';

/** 去掉所有零宽锚点，得到用户真正写下的文本 */
function stripZwsp(value: string): string {
  return value.replace(/\u200B/g, '');
}

/**
 * 造一个「自带零宽种子」的空块。
 *
 * 直接给空元素 `placeCaretAtEnd` 是没用的：空块里没有文本节点，Chrome 的选区
 * 规范化会把光标**挤回上一行**（曾导致敲完 `# ` 变出空 `<h1>` 后，接着敲的
 * 「大标题」跑进上一段的删除线里）。塞一颗零宽种子，块就不再是空的，
 * 光标稳稳落在种子之后，而种子在序列化时被剥掉，不污染 Markdown。
 */
function withCaretSeed(tag: string): HTMLElement {
  const el: HTMLElement = document.createElement(tag);
  el.appendChild(document.createTextNode(ZWSP));
  return el;
}

/**
 * 取围栏代码块的语言标识。
 *
 * 两个来源：编辑期写进 `pre.dataset.lang` 的，以及 marked 渲染出来的
 * `<code class="language-shell">`。二者取其一，都没有就是「无语言围栏」。
 */
function fenceLangOf(pre: HTMLElement, codeEl: HTMLElement): string {
  const fromDataset: string = normalizeLang(pre.dataset.lang ?? '');
  if (fromDataset !== '') {
    return fromDataset;
  }
  const matched: RegExpExecArray | null = /(?:^|\s)language-([A-Za-z0-9+#._-]+)/.exec(codeEl.className);
  return normalizeLang(matched?.[1] ?? '');
}

/** 确保 `pre` 里有 `code` 子元素（marked 会产出，手工建块时也建了；这里只兜底） */
function ensureCodeChild(pre: HTMLElement): HTMLElement {
  const existing: HTMLElement | null = pre.querySelector('code');
  if (existing !== null) {
    return existing;
  }
  const code: HTMLElement = document.createElement('code');
  while (pre.firstChild !== null) {
    code.appendChild(pre.firstChild);
  }
  pre.appendChild(code);
  return code;
}

/**
 * 光标在 `scope` 内的**可见字符偏移**（零宽锚点不计入）。
 *
 * 高亮要重建 innerHTML，重建前只能用偏移量记住光标位置，重建后再换算回来。
 * @returns 光标不在 `scope` 内时返回 null（此时无需还原，随便重建）
 */
function caretOffsetIn(scope: HTMLElement): number | null {
  const selection: Selection | null = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return null;
  }
  const range: Range = selection.getRangeAt(0);
  if (!scope.contains(range.startContainer)) {
    return null;
  }
  const probe: Range = document.createRange();
  probe.selectNodeContents(scope);
  probe.setEnd(range.startContainer, range.startOffset);
  return stripZwsp(probe.toString()).length;
}

/**
 * 把光标放回 `scope` 内的第 `offset` 个可见字符处（高亮重建后调用）。
 *
 * 边界情况（偏移 0 或等于总长）不能直接落在已有文本节点里 —— 浏览器会按
 * 「紧邻前一个行内元素」延续样式，接着敲的字就染成上一个 token 的颜色。
 * 这两种情况一律插一颗 `ZWSP` 哨兵再落光标（与 `convertInline` 同一套办法）。
 */
function restoreCaretIn(scope: HTMLElement, offset: number): void {
  const selection: Selection | null = window.getSelection();
  if (!selection) {
    return;
  }
  const place = (node: Node, at: number): void => {
    const range: Range = document.createRange();
    range.setStart(node, at);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  if (offset <= 0) {
    const head: Text = document.createTextNode(ZWSP);
    scope.insertBefore(head, scope.firstChild);
    place(head, 1);
    return;
  }

  const walker: TreeWalker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  let remaining: number = offset;
  let node: Node | null = walker.nextNode();
  let last: Text | null = null;
  while (node) {
    const text: Text = node as Text;
    const length: number = (text.nodeValue ?? '').length;
    last = text;
    if (remaining <= length) {
      place(text, remaining);
      return;
    }
    remaining -= length;
    node = walker.nextNode();
  }

  // 跑到末尾（或 scope 里一个文本节点都没有）：补哨兵
  const tail: Text = document.createTextNode(ZWSP);
  if (last === null) {
    scope.appendChild(tail);
  } else {
    last.after(tail);
  }
  place(tail, 1);
}

/** 行内序列化：把富文本节点还原成 markdown 行内语法 */
function serializeInline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return stripZwsp(node.nodeValue ?? '');
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return '';
  }
  const el: HTMLElement = node as HTMLElement;
  const tag: string = el.tagName.toLowerCase();
  const inner: string = Array.from(el.childNodes).map(serializeInline).join('');

  switch (tag) {
    case 'strong':
    case 'b':
      return inner === '' ? '' : `**${inner}**`;
    case 'em':
    case 'i':
      return inner === '' ? '' : `*${inner}*`;
    case 'del':
    case 's':
    case 'strike':
      return inner === '' ? '' : `~~${inner}~~`;
    case 'code':
      return inner === '' ? '' : `\`${inner}\``;
    case 'a': {
      const href: string = el.getAttribute('href') ?? '';
      return inner === '' ? '' : `[${inner}](${href})`;
    }
    case 'img': {
      const alt: string = el.getAttribute('alt') ?? '';
      const src: string = el.getAttribute('src') ?? '';
      return `![${alt}](${src})`;
    }
    case 'br':
      return '\n';
    case 'input':
      // 任务项复选框由 li 层统一处理，这里不产出文本
      return '';
    default:
      return inner;
  }
}

/** 会被当成「独立成行」的块级标签；不在表内的都算行内内容，需并入同一行 */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'div',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'blockquote',
  'pre',
  'hr',
  'table',
]);

/** 块级序列化：把编辑区还原成 markdown 文本（编辑器对外只暴露这一份数据） */
function serializeBlocks(root: HTMLElement): string {
  const lines: string[] = [];
  /** 连续的行内节点（裸文本 / `<strong>` …）攒成同一行 */
  let inline: string = '';

  const flushInline = (): void => {
    if (inline.trim() !== '') {
      lines.push(inline);
    }
    inline = '';
  };

  Array.from(root.childNodes).forEach((node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      inline += stripZwsp(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }
    const el: HTMLElement = node as HTMLElement;
    const tag: string = el.tagName.toLowerCase();

    // 行内节点（含 `<br>`）并入当前行，不单独成行。
    // 编辑器还空着时浏览器会把内容直接挂在根节点上（不套 div），若不归并，
    // 视觉上的一行 `**粗体** 普通` 会被拆成两行 Markdown 输出。
    if (!BLOCK_TAGS.has(tag)) {
      if (tag === 'br') {
        flushInline();
        return;
      }
      inline += serializeInline(el);
      return;
    }

    flushInline();

    // 标题
    const heading: RegExpExecArray | null = /^h([1-6])$/.exec(tag);
    if (heading) {
      const level: number = Number.parseInt(heading[1] ?? '1', 10);
      // 空标题（内容被删光，浏览器留下 `<h1><br></h1>`）不再吐出孤零零的 `#`，
      // 否则空文档会序列化出一个空标题。
      const body: string = serializeInline(el).replace(/\s+$/, '');
      lines.push(body === '' ? '' : `${'#'.repeat(level)} ${body}`);
      return;
    }

    // 列表（含 GFM 任务项）
    if (tag === 'ul' || tag === 'ol') {
      const items: Element[] = Array.from(el.children).filter(
        (child: Element): boolean => child.tagName.toLowerCase() === 'li',
      );
      items.forEach((li: Element, index: number): void => {
        const checkbox: HTMLInputElement | null = li.querySelector('input[type="checkbox"]');
        // li 的直接文本（排除复选框本身，它不产出文本）
        const body: string = serializeInline(li).replace(/^\s*\n/, '').trim();
        if (checkbox) {
          lines.push(`- [${checkbox.checked ? 'x' : ' '}] ${body}`);
          return;
        }
        if (tag === 'ol') {
          lines.push(`${index + 1}. ${body}`);
          return;
        }
        lines.push(`- ${body}`);
      });
      return;
    }

    // 引用
    if (tag === 'blockquote') {
      const inner: string = serializeBlocks(el);
      inner.split('\n').forEach((line: string): void => {
        lines.push(line.trim() === '' ? '>' : `> ${line}`);
      });
      return;
    }

    // 代码块（保留语言标识，尾部空行剥掉，避免每次序列化都多出一行）
    if (tag === 'pre') {
      const codeEl: HTMLElement = ensureCodeChild(el);
      const lang: string = fenceLangOf(el, codeEl);
      const code: string = stripZwsp(codeEl.textContent ?? '').replace(/\n+$/, '');
      lines.push(`\`\`\`${lang}`);
      lines.push(code);
      lines.push('```');
      return;
    }

    if (tag === 'hr') {
      lines.push('---');
      return;
    }

    // 段落 / 普通块（含浏览器自产的 div）
    lines.push(serializeInline(el));
  });

  // 收尾：把最后一段还没落行的行内内容补上
  flushInline();

  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '');
}

/** 内容是否「视觉为空」（浏览器会在空块塞 `<br>`，零宽锚点也不算内容） */
function isVisuallyEmpty(root: HTMLElement): boolean {
  if (stripZwsp(root.textContent ?? '').trim() !== '') {
    return false;
  }
  return root.querySelector('img, hr, input') === null;
}

/**
 * 所见即所得 Markdown 输入框。
 *
 * @param props 见 `RichMarkdownProps`
 * @returns 可编辑的富文本容器
 */
export function RichMarkdown({
  value,
  onChange,
  placeholder = '',
  className = '',
  readOnly = false,
  singleLine = false,
  onEnter,
  onBlur,
  onFocus,
  ariaLabel,
}: RichMarkdownProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** 自己刚发出的 markdown：用于区分「外部改值」与「自己的回声」，避免无谓重建 */
  const lastEmitted = useRef<string | null>(null);
  const [empty, setEmpty] = useState<boolean>(value.trim() === '');

  /** 把编辑区内容同步出去 */
  const emit = useCallback((): void => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    setEmpty(isVisuallyEmpty(root));
    const next: string = serializeBlocks(root);
    lastEmitted.current = next;
    onChange(next);
  }, [onChange]);

  // ————————————————————————————————————————————————————————————
  // 围栏代码块：就地高亮
  //
  // 放在这两个 effect 之前是有意的：「挂载灌初值」与「外部换值」都要顺手把既有
  // 代码块上色，若把高亮器声明在它们后面，闭包里就是 TDZ（TS 也会直接报错）。
  // ————————————————————————————————————————————————————————————

  /**
   * 就地高亮所有围栏代码块。
   *
   * 内容指纹没变就直接跳过 —— 这是「不抖」的关键：光标还原再准，也比不上
   * 根本不动 DOM。真要重建时，先按可见字符偏移记住光标，重建后再换算回去。
   */
  const applyHighlight = useCallback((): void => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const pres: HTMLElement[] = Array.from(root.querySelectorAll<HTMLElement>('pre'));
    pres.forEach((pre: HTMLElement): void => {
      const codeEl: HTMLElement = ensureCodeChild(pre);
      const raw: string = stripZwsp(codeEl.textContent ?? '');
      const lang: string = fenceLangOf(pre, codeEl);
      const key = `${lang}\u0000${raw}`;
      if (highlightedKeys.get(pre) === key) {
        return;
      }
      highlightedKeys.set(pre, key);
      if (!isSupportedLang(lang) || raw.trim() === '') {
        return;
      }
      const offset: number | null = caretOffsetIn(pre);
      codeEl.innerHTML = highlightCodeHtml(raw, lang);
      if (offset !== null) {
        restoreCaretIn(codeEl, offset);
      }
    });
  }, []);

  /** 高亮去抖句柄（输入期用；失焦 / 换值 / 挂载时立刻跑） */
  const highlightTimerRef = useRef<number | undefined>(undefined);
  const scheduleHighlight = useCallback((): void => {
    if (highlightTimerRef.current !== undefined) {
      window.clearTimeout(highlightTimerRef.current);
    }
    highlightTimerRef.current = window.setTimeout(() => {
      highlightTimerRef.current = undefined;
      applyHighlight();
    }, HIGHLIGHT_DEBOUNCE_MS);
  }, [applyHighlight]);
  useEffect(
    () => () => {
      if (highlightTimerRef.current !== undefined) {
        window.clearTimeout(highlightTimerRef.current);
      }
    },
    [],
  );

  /** 首次挂载：灌入初值（并立刻给既有代码块上色） */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    root.innerHTML = renderMarkdown(value);
    setEmpty(isVisuallyEmpty(root));
    applyHighlight();
    // 仅初始化执行一次：后续同步由 value 变更的 effect 负责
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 外部值变更 → 重建 DOM（自己的回声直接跳过，否则光标必丢） */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    if (lastEmitted.current === value) {
      return;
    }
    if (serializeBlocks(root) === value) {
      return;
    }
    root.innerHTML = renderMarkdown(value);
    setEmpty(isVisuallyEmpty(root));
    applyHighlight();
  }, [value, applyHighlight]);

  /**
   * 摘掉「空格式壳」。
   *
   * 浏览器的内容可编辑区有个默认脾气：**回车 / 在行尾继续输入时会克隆上一行的
   * 行内格式**。于是敲完 `**粗体**` 再回车，新行往往是
   * `<div><strong><br></strong></div>` —— 用户接着敲什么都被莫名加粗，敲
   * `*斜体*` 更会叠成 `***斜体***`（粗 + 斜），源文本彻底走样。
   *
   * 这里在每次输入前，把**不含任何可见内容**的格式壳摘掉（有文字、含图片/链接/
   * 复选框的一律保留），让后续输入落回中性的块级上下文。
   */
  const pruneEmptyFormatting = useCallback((): void => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const selection: Selection | null = window.getSelection();
    const range: Range | null =
      selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    const caretNode: Node | null = range ? range.startContainer : null;

    const shells: HTMLElement[] = Array.from(
      root.querySelectorAll<HTMLElement>('strong, b, em, i, del, s, strike, code'),
    );

    const landings: HTMLElement[] = [];
    shells.forEach((shell: HTMLElement): void => {
      if (stripZwsp(shell.textContent ?? '').trim() !== '') {
        return;
      }
      if (shell.querySelector('img, a, input') !== null) {
        return;
      }
      const parent: HTMLElement | null = shell.parentElement;
      if (!parent) {
        return;
      }
      if (caretNode !== null && (shell === caretNode || shell.contains(caretNode))) {
        landings.push(parent);
      }
      shell.remove();
    });

    const target: HTMLElement | undefined = landings[0];
    if (!target) {
      return;
    }
    // 摘空了就补一个占位换行，保证这行仍可见、仍可输入
    if (target.childNodes.length === 0) {
      target.appendChild(document.createElement('br'));
    }
    placeCaretAtEnd(target);
  }, []);

  // ————————————————————————————————————————————————————————————
  // 围栏代码块：换行 / 认语言 / 跳出
  // ————————————————————————————————————————————————————————————

  /** 光标所在的直接块（`root` 的孩子）；不在编辑器里返回 null */
  const blockAtCaret = useCallback((): HTMLElement | null => {
    const root = rootRef.current;
    const selection: Selection | null = window.getSelection();
    if (!root || !selection || selection.rangeCount === 0) {
      return null;
    }
    return directBlockOf(root, selection.getRangeAt(0).startContainer);
  }, []);

  /** 光标所在的围栏代码块（不在代码块里返回 null） */
  const preAtCaret = useCallback((): HTMLElement | null => {
    const block: HTMLElement | null = blockAtCaret();
    if (!block) {
      return null;
    }
    return block.tagName.toLowerCase() === 'pre' ? block : null;
  }, [blockAtCaret]);

  /**
   * 在光标处插入一个**真实换行**。
   *
   * 不用 `<br>`、也不用 `execCommand('insertLineBreak')` —— 前者在
   * `textContent` 里不产出 `\n`，序列化后代码块就还是「一行的」。
   * 这里直接落一个含 `\n` 的文本节点，markdown 与渲染两侧都一致。
   */
  const insertNewlineInPre = useCallback((): void => {
    const selection: Selection | null = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return;
    }
    const range: Range = selection.getRangeAt(0);
    range.deleteContents();
    const newline: Text = document.createTextNode('\n');
    range.insertNode(newline);
    const after: Range = document.createRange();
    after.setStart(newline, 1);
    after.collapse(true);
    selection.removeAllRanges();
    selection.addRange(after);
  }, []);

  /** 跳出代码块：块后另起一个空段落并把光标落过去 */
  const exitPre = useCallback(
    (pre: HTMLElement): void => {
      const paragraph: HTMLElement = document.createElement('div');
      paragraph.appendChild(document.createElement('br'));
      pre.after(paragraph);
      placeCaretAtEnd(paragraph);
      emit();
    },
    [emit],
  );

  /**
   * 代码块里按回车的三种去向：
   *   ① 首行是**内置高亮语言名** → 认成围栏语言并清空内容（```` ```sh ⏎ ```` 的写法）；
   *   ② 末行本来就是空行 → 收尾跳出（三引号写法的直觉）；
   *   ③ 其余情况 → 插一个真实换行，留在代码块里继续写。
   */
  const handlePreEnter = useCallback(
    (pre: HTMLElement, shift: boolean): void => {
      const codeEl: HTMLElement = ensureCodeChild(pre);
      const text: string = stripZwsp(codeEl.textContent ?? '');
      const token: string = text.trim();
      if (!shift && text.indexOf('\n') < 0 && isSupportedLang(token)) {
        pre.dataset.lang = normalizeLang(token);
        codeEl.textContent = ZWSP;
        placeCaretAtEnd(codeEl);
        emit();
        return;
      }
      const lastBreak: number = text.lastIndexOf('\n');
      if (!shift && lastBreak >= 0 && text.slice(lastBreak + 1).trim() === '') {
        codeEl.textContent = text.replace(/\n+$/, '');
        exitPre(pre);
        return;
      }
      insertNewlineInPre();
      emit();
    },
    [emit, exitPre, insertNewlineInPre],
  );

  /** 行内即时转换：把光标前刚闭合的标记换成格式化元素 */
  const convertInline = useCallback((): boolean => {
    const caret = caretInTextNode();
    if (!caret) {
      return false;
    }
    const before: string = (caret.node.nodeValue ?? '').slice(0, caret.offset);
    for (const rule of INLINE_RULES) {
      const matched: RegExpExecArray | null = rule.re.exec(before);
      if (!matched) {
        continue;
      }
      const inner: string = matched[1] ?? '';
      const start: number = caret.offset - matched[0].length;
      const range: Range = document.createRange();
      range.setStart(caret.node, start);
      range.setEnd(caret.node, caret.offset);
      range.deleteContents();

      const el: HTMLElement = document.createElement(rule.tag);
      el.textContent = inner;
      range.insertNode(el);

      // 光标必须落回**格式之外**：若直接 `setStartAfter(el)`、或停在哨兵节点开头
      // （`range.startOffset = 0`），Chrome 都会按「紧邻前一个行内元素」判样式，
      // 把接下来敲的字继续塞进 `<strong>` 里。停在哨兵**末尾**（offset = 1），
      // 光标前一个字符就是零宽空格本身，样式继承链才真正断掉。
      const spacer: Text = document.createTextNode(ZWSP);
      el.after(spacer);
      const after: Range = document.createRange();
      after.setStart(spacer, 1);
      after.collapse(true);
      const selection: Selection | null = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(after);
      return true;
    }
    return false;
  }, []);

  /** 块级前缀转换：行首标记 → 块元素（标题 / 列表 / 引用 / 任务 / 代码块） */
  const convertBlock = useCallback((): boolean => {
    const root = rootRef.current;
    const caret = caretInTextNode();
    if (!root || !caret) {
      return false;
    }
    let block: HTMLElement | null = directBlockOf(root, caret.node);
    if (!block || block === root) {
      // 内容还裸挂在根节点上（新笔记的第一笔）→ 先补一层块容器
      block = wrapInlineRunAtCaret(root, caret.node);
    }
    if (!block) {
      return false;
    }
    // 只在「整块就是标记本身」时转换，避免误伤正文。
    // 注意要剥掉零宽锚点：上一处行内转换会在同一块里留下 `\u200B`，
    // 若拿它当首字符，`^#\s$` 之类的块级规则会永远匹配不上（曾导致 `# ` 失效）。
    const marker: string = stripZwsp(block.textContent ?? '');
    const rule: BlockRule | undefined = BLOCK_RULES.find((item: BlockRule): boolean =>
      item.re.test(marker),
    );
    if (!rule) {
      return false;
    }

    let replacement: HTMLElement;
    /** 光标最终要落进去的元素（列表是 `li`、代码块是 `code`） */
    let caretTarget: HTMLElement;
    switch (rule.kind) {
      case 'h': {
        const level: number = marker.trim().length;
        replacement = withCaretSeed(`h${level}`);
        caretTarget = replacement;
        break;
      }
      case 'quote':
        replacement = withCaretSeed('blockquote');
        caretTarget = replacement;
        break;
      case 'pre': {
        // 语言从围栏行的捕获组带出（```shell / ```python …），无语言则为空串
        const fenceLang: string = normalizeLang(rule.re.exec(marker)?.[1] ?? '');
        replacement = document.createElement('pre');
        if (fenceLang !== '') {
          replacement.dataset.lang = fenceLang;
        }
        const code: HTMLElement = withCaretSeed('code');
        replacement.appendChild(code);
        caretTarget = code;
        break;
      }
      case 'ul':
      case 'ol': {
        replacement = document.createElement(rule.kind);
        const li: HTMLElement = withCaretSeed('li');
        replacement.appendChild(li);
        caretTarget = li;
        break;
      }
      case 'task': {
        const ul: HTMLElement = document.createElement('ul');
        ul.dataset.task = 'true';
        const li: HTMLElement = document.createElement('li');
        const box: HTMLInputElement = document.createElement('input');
        box.type = 'checkbox';
        // 让复选框在可编辑区里可点、但不被序列化成语义文本
        box.setAttribute('contenteditable', 'false');
        li.appendChild(box);
        li.appendChild(document.createTextNode(ZWSP));
        ul.appendChild(li);
        replacement = ul;
        caretTarget = li;
        break;
      }
      default:
        return false;
    }

    block.replaceWith(replacement);
    placeCaretAtEnd(caretTarget);
    return true;
  }, []);

  /** 输入事件：先清空壳，再尝试两类转换，最后同步内容出去 */
  const handleInput = useCallback((): void => {
    // 代码块内部一律按裸文本处理：不做行内 / 块级转换，
    // 否则一段代码只要恰好长得像标记（例如整块就是一个 `- `）就会被「吃掉」。
    if (preAtCaret() === null) {
      pruneEmptyFormatting();
      // 块级优先（`# ` 之类），失败再试行内（`**x**` 之类）
      convertBlock() || convertInline();
    }
    emit();
    scheduleHighlight();
  }, [convertBlock, convertInline, emit, preAtCaret, pruneEmptyFormatting, scheduleHighlight]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (singleLine && event.key === 'Enter') {
        event.preventDefault();
        onEnter?.();
        return;
      }

      // —— 围栏代码块内的按键：换行 / 认语言 / 跳出 / 撤销围栏 ——
      const pre: HTMLElement | null = preAtCaret();
      if (pre !== null) {
        if (event.key === 'Enter') {
          event.preventDefault();
          handlePreEnter(pre, event.shiftKey);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          exitPre(pre);
        } else if (
          event.key === 'Backspace' &&
          stripZwsp(ensureCodeChild(pre).textContent ?? '') === ''
        ) {
          // 空代码块里退格 = 撤掉这个围栏，还原成普通段落（否则空块删不掉）
          event.preventDefault();
          const paragraph: HTMLElement = document.createElement('div');
          paragraph.appendChild(document.createElement('br'));
          pre.replaceWith(paragraph);
          placeCaretAtEnd(paragraph);
          emit();
        }
        return;
      }

      // 空任务项 / 空列表项回车：跳出列表（避免空标记一直续下去）
      if (event.key === 'Enter' && !event.shiftKey) {
        const root = rootRef.current;
        const selection: Selection | null = window.getSelection();
        if (!root || !selection || selection.rangeCount === 0) {
          return;
        }
        const block: HTMLElement | null = directBlockOf(root, selection.getRangeAt(0).startContainer);
        const li: HTMLElement | null = block?.closest('li') ?? null;
        if (li && (li.textContent ?? '').trim() === '') {
          event.preventDefault();
          const list: HTMLElement | null = li.parentElement;
          const paragraph: HTMLElement = document.createElement('p');
          paragraph.appendChild(document.createElement('br'));
          if (list && list.children.length <= 1) {
            list.replaceWith(paragraph);
          } else {
            li.remove();
            list?.after(paragraph);
          }
          placeCaretAtEnd(paragraph);
          emit();
        }
      }
    },
    [emit, exitPre, handlePreEnter, onEnter, preAtCaret, singleLine],
  );

  /** 粘贴：只取纯文本（避免粘进外部 HTML 把结构冲烂），多行仍然合法 */
  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>): void => {
      event.preventDefault();
      const text: string = event.clipboardData.getData('text/plain');
      const safe: string = singleLine ? text.replace(/\s*\n+\s*/g, ' ') : text;
      document.execCommand('insertText', false, safe);
      emit();
      scheduleHighlight();
    },
    [emit, scheduleHighlight, singleLine],
  );

  return (
    <div className={cn('relative min-h-0', className)}>
      <div
        ref={rootRef}
        role="textbox"
        aria-multiline={!singleLine}
        aria-label={ariaLabel}
        tabIndex={readOnly ? -1 : 0}
        contentEditable={!readOnly}
        suppressContentEditableWarning
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onFocus={() => onFocus?.()}
        onBlur={() => {
          // 失焦即把待补的高亮补上（省得离开后代码还是黑的）
          if (highlightTimerRef.current !== undefined) {
            window.clearTimeout(highlightTimerRef.current);
            highlightTimerRef.current = undefined;
          }
          applyHighlight();
          emit();
          onBlur?.();
        }}
        className={cn(
          // `h-full` 在父容器高度为 auto 时自然退化为 auto（内容撑开），
          // 父容器有确定高度（如笔记正文）时则撑满并自行滚动 —— 一套样式两种场景通吃。
          'md-preview wysiwyg scrollbar-thin h-full min-h-0 overflow-auto outline-none',
          readOnly && 'pointer-events-none',
        )}
      />
      {empty && placeholder !== '' && (
        <span className="pointer-events-none absolute left-0 top-0 select-none text-muted-foreground/60">
          {placeholder}
        </span>
      )}
    </div>
  );
}

export default RichMarkdown;

/**
 * 纯函数序列化（无 DOM 依赖部分无法完全剥离，但导出便于回归脚本直接断言）。
 * 与 `MarkdownEditor.markdownOps` 同一用意：把可测逻辑显式暴露。
 */
export const richMarkdownOps = {
  serializeInline,
  serializeBlocks,
};
