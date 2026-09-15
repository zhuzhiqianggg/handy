import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * 轻量代码高亮（零依赖）。
 *
 * # 为什么自己写
 *
 * 便签（用户反馈 #6）里要支持 ```shell / ```python 这类代码块高亮。上 highlight.js
 * 或 shiki 会显著增大包体（release 体积是本项目的硬指标：Win < 30MB），
 * 而真实需求只是「关键字、字符串、注释、数字能分清颜色」，几十行规则就够了。
 *
 * # 实现
 *
 * 每种语言给一组 `TokenRule`（带名字的正则片段 + 颜色类），拼成**一个**大正则
 * （`(a)|(b)|(c)...`），扫描时看哪个捕获组命中就知道是哪种 token。
 * 顺序即优先级：注释与字符串写在关键字前面，否则字符串里的关键字会抢先变色。
 *
 * # 边界
 *
 * - 不做语法分析，因此**不会**因为半个引号就崩；最坏情况是颜色不准；
 * - 未知语言按纯文本渲染，并去掉多余缩进。
 */

/** 一条 token 规则 */
interface TokenRule {
  /** 正则片段（会被包进捕获组，注意不要有裸露的顶层 `|`） */
  pattern: string;
  /** 对应的 CSS 类 */
  cls: string;
}

/** 颜色类（对齐项目浅色主题；dark 下也有对应色） */
const CLS = {
  comment: 'text-neutral-400 italic dark:text-neutral-500',
  string: 'text-emerald-700 dark:text-emerald-400',
  keyword: 'text-violet-700 font-medium dark:text-violet-400',
  number: 'text-amber-700 dark:text-amber-500',
  func: 'text-sky-700 dark:text-sky-400',
  type: 'text-teal-700 dark:text-teal-400',
  variable: 'text-rose-700 dark:text-rose-400',
  operator: 'text-muted-foreground',
} as const;

/** 正则片段片段复用 */
const P = {
  lineComment: '(?:#[^\\n]*|//[^\\n]*)',
  blockComment: '/\\*[\\s\\S]*?\\*/',
  dqString: '"(?:\\\\.|[^"\\\\\\n])*"',
  sqString: "'(?:\\\\.|[^'\\\\\\n])*'",
  templateString: '`(?:\\\\.|[^`\\\\])*`',
  number: '\\b\\d+(?:\\.\\d+)?\\b',
};

/** 各语言规则（顺序 = 优先级） */
const LANGS: Record<string, TokenRule[]> = {
  shell: [
    { pattern: P.lineComment, cls: CLS.comment },
    { pattern: `(?:${P.dqString}|${P.sqString})`, cls: CLS.string },
    {
      pattern:
        '\\b(?:if|then|else|elif|fi|for|in|do|done|while|until|case|esac|function|return|local|export|declare|readonly|set|unset|shift|exit|source|trap|eval)\\b',
      cls: CLS.keyword,
    },
    {
      pattern:
        '\\b(?:echo|printf|read|test|mkdir|rmdir|rm|cp|mv|ln|chmod|chown|grep|egrep|pgrep|awk|sed|cut|sort|uniq|head|tail|cat|tee|find|xargs|curl|wget|systemctl|journalctl|df|du|ps|kill|sleep|git|docker|kubectl)\\b',
      cls: CLS.func,
    },
    { pattern: '\\$\\{[^}]*\\}|\\$[A-Za-z_][A-Za-z0-9_]*|\\$[?#@*!$0-9]', cls: CLS.variable },
    { pattern: P.number, cls: CLS.number },
    { pattern: '(?:&&|\\|\\||[|&><]=?|!=|==|-eq|-ne|-z|-n)', cls: CLS.operator },
  ],
  python: [
    { pattern: P.lineComment, cls: CLS.comment },
    { pattern: `(?:'''[\\s\\S]*?'''|"""[\\s\\S]*?"""|${P.dqString}|${P.sqString})`, cls: CLS.string },
    { pattern: '@[A-Za-z_][\\w.]*', cls: CLS.type },
    {
      pattern:
        '\\b(?:def|class|return|yield|if|elif|else|for|while|break|continue|pass|import|from|as|with|try|except|finally|raise|lambda|global|nonlocal|assert|del|async|await|in|is|not|and|or|None|True|False)\\b',
      cls: CLS.keyword,
    },
    {
      pattern:
        '\\b(?:print|len|range|enumerate|zip|open|int|str|float|bool|list|dict|set|tuple|sum|min|max|sorted|map|filter|isinstance|type|super|self)\\b',
      cls: CLS.func,
    },
    { pattern: P.number, cls: CLS.number },
  ],
  javascript: [
    { pattern: `${P.blockComment}|${P.lineComment}`, cls: CLS.comment },
    { pattern: `${P.templateString}|${P.dqString}|${P.sqString}`, cls: CLS.string },
    {
      pattern:
        '\\b(?:const|let|var|function|return|if|else|for|while|do|break|continue|new|class|extends|super|import|export|from|default|try|catch|finally|throw|await|async|yield|typeof|instanceof|in|of|this|null|undefined|true|false|void|delete)\\b',
      cls: CLS.keyword,
    },
    { pattern: '\\b[A-Z][A-Za-z0-9_]*\\b', cls: CLS.type },
    { pattern: P.number, cls: CLS.number },
  ],
  json: [
    { pattern: '"(?:\\\\.|[^"\\\\])*"(?=\\s*:)', cls: CLS.type },
    { pattern: '"(?:\\\\.|[^"\\\\])*"', cls: CLS.string },
    { pattern: '\\b(?:true|false|null)\\b', cls: CLS.keyword },
    { pattern: '-?\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b', cls: CLS.number },
  ],
  yaml: [
    { pattern: P.lineComment, cls: CLS.comment },
    { pattern: '^[ \\t-]*[\\w.$-]+(?=\\s*:)', cls: CLS.type },
    { pattern: `(?:${P.dqString}|${P.sqString})`, cls: CLS.string },
    { pattern: '\\b(?:true|false|null|yes|no|on|off)\\b', cls: CLS.keyword },
    { pattern: '\\b\\d+(?:\\.\\d+)?(?:Gi|Mi|Ki|s|m|h)?\\b', cls: CLS.number },
    { pattern: '[&*][\\w-]+', cls: CLS.variable },
  ],
  java: [
    { pattern: `${P.blockComment}|${P.lineComment}`, cls: CLS.comment },
    { pattern: P.dqString, cls: CLS.string },
    { pattern: '@[A-Za-z_][\\w.]*', cls: CLS.type },
    {
      pattern:
        '\\b(?:public|private|protected|static|final|abstract|class|interface|enum|extends|implements|new|return|if|else|for|while|do|switch|case|default|break|continue|try|catch|finally|throw|throws|this|super|void|int|long|double|float|boolean|char|byte|short|String|null|true|false|import|package|synchronized|volatile|transient|instanceof)\\b',
      cls: CLS.keyword,
    },
    { pattern: P.number, cls: CLS.number },
  ],
  go: [
    { pattern: `${P.blockComment}|${P.lineComment}`, cls: CLS.comment },
    { pattern: `${P.templateString}|${P.dqString}`, cls: CLS.string },
    {
      pattern:
        '\\b(?:package|import|func|return|if|else|for|range|switch|case|default|break|continue|var|const|type|struct|interface|map|chan|go|defer|select|nil|true|false|make|new|len|cap|append)\\b',
      cls: CLS.keyword,
    },
    { pattern: '\\b(?:string|int|int64|float64|bool|byte|error|rune)\\b', cls: CLS.type },
    { pattern: P.number, cls: CLS.number },
  ],
  sql: [
    { pattern: '--[^\\n]*', cls: CLS.comment },
    { pattern: `${P.sqString}`, cls: CLS.string },
    {
      pattern:
        '\\b(?:SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|ALTER|DROP|TABLE|INDEX|VIEW|AS|AND|OR|NOT|NULL|IS|IN|LIKE|BETWEEN|UNION|ALL|DISTINCT|COUNT|SUM|AVG|MAX|MIN|CASE|WHEN|THEN|ELSE|END|EXPLAIN|DESC|ASC)\\b',
      cls: CLS.keyword,
    },
    { pattern: P.number, cls: CLS.number },
  ],
  ini: [
    { pattern: '[;#][^\\n]*', cls: CLS.comment },
    { pattern: '^\\[[^\\]]+\\]', cls: CLS.type },
    { pattern: '^[\\w.$-]+(?=\\s*=)', cls: CLS.variable },
    { pattern: `(?:${P.dqString}|${P.sqString})`, cls: CLS.string },
    { pattern: P.number, cls: CLS.number },
  ],
};

/** 语言别名归一 */
const ALIAS: Record<string, string> = {
  sh: 'shell', bash: 'shell', zsh: 'shell', console: 'shell', powershell: 'shell', ps1: 'shell',
  py: 'python', python3: 'python',
  js: 'javascript', jsx: 'javascript', ts: 'javascript', tsx: 'javascript', node: 'javascript', typescript: 'javascript',
  yml: 'yaml',
  java: 'java', kotlin: 'java',
  golang: 'go',
  mysql: 'sql', postgres: 'sql', postgresql: 'sql', sqlite: 'sql',
  conf: 'ini', config: 'ini', toml: 'ini', env: 'ini', properties: 'ini',
};

/** 编译后的高亮器（按语言缓存，避免每次渲染重建正则） */
const compiled = new Map<string, { re: RegExp; classes: string[] } | null>();

function compile(lang: string): { re: RegExp; classes: string[] } | null {
  if (compiled.has(lang)) {
    return compiled.get(lang) ?? null;
  }
  const rules = LANGS[lang];
  if (!rules) {
    compiled.set(lang, null);
    return null;
  }
  const classes = rules.map((rule) => rule.cls);
  const re = new RegExp(rules.map((rule) => `(${rule.pattern})`).join('|'), 'gm');
  const built = { re, classes };
  compiled.set(lang, built);
  return built;
}

/** 把一段代码切成带颜色的片段 */
function highlight(code: string, lang: string): React.ReactNode[] {
  const engine = compile(lang);
  if (engine === null) {
    return [code];
  }
  const { re, classes } = engine;
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let guard = 0;
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)) !== null) {
    guard += 1;
    if (guard > 20000) {
      break;
    }
    // 全空匹配（例如裸的 `|` 规则）会导致死循环，跳过
    if (match[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    if (match.index > cursor) {
      nodes.push(code.slice(cursor, match.index));
    }
    const groupIndex = match.slice(1).findIndex((value) => value !== undefined);
    const cls = classes[groupIndex] ?? '';
    nodes.push(
      <span key={`${match.index}-${guard}`} className={cls}>
        {match[0]}
      </span>,
    );
    cursor = match.index + match[0].length;
  }
  if (cursor < code.length) {
    nodes.push(code.slice(cursor));
  }
  return nodes;
}

export interface CodeBlockProps {
  code: string;
  /** 语言标识（缺省 = 纯文本） */
  lang?: string;
  className?: string;
}

/**
 * 代码块（带语法高亮）。
 *
 * 支持的常见语言：shell / python / javascript(ts) / json / yaml / java / go / sql / ini(toml)，
 * 其余按纯文本渲染，不会报错也不会变色。
 */
export function CodeBlock({ code, lang = '', className }: CodeBlockProps): React.JSX.Element {
  const normalized = React.useMemo(() => {
    const key = lang.trim().toLowerCase();
    return key.length === 0 ? '' : (ALIAS[key] ?? key);
  }, [lang]);

  const nodes = React.useMemo(() => highlight(code.replace(/\s+$/, ''), normalized), [code, normalized]);
  const supported = normalized !== '' && LANGS[normalized] !== undefined;

  return (
    <div className={cn('my-2 overflow-hidden rounded-lg border border-border bg-muted/40', className)}>
      <div className="flex items-center justify-between border-b border-border/70 px-2.5 py-1">
        <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          {normalized === '' ? 'text' : normalized}
          {supported ? '' : '（未内置高亮，按纯文本显示）'}
        </span>
      </div>
      <pre className="scrollbar-thin overflow-x-auto px-3 py-2 font-mono text-xs leading-relaxed">
        <code>{nodes}</code>
      </pre>
    </div>
  );
}

export default CodeBlock;
