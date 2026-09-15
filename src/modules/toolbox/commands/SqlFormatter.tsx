import * as React from 'react';
import { Database } from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { ResultBox } from '@/components/ResultBox';
import { Switch } from '@/components/ui/switch';
import { useCommandShell } from '@/hooks/useCommandShell';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'sql-formatter';

/** 主子句关键字（换行 + 缩进）。 */
const CLAUSES: ReadonlyArray<string> = [
  'SELECT',
  'FROM',
  'WHERE',
  'GROUP BY',
  'ORDER BY',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'UNION ALL',
  'UNION',
  'INSERT INTO',
  'VALUES',
  'UPDATE',
  'SET',
  'DELETE FROM',
  'INNER JOIN',
  'LEFT JOIN',
  'RIGHT JOIN',
  'FULL JOIN',
  'CROSS JOIN',
  'JOIN',
  'ON',
];

/** 关键字列表（用于大写化）。 */
const KEYWORDS: ReadonlyArray<string> = [
  'select',
  'from',
  'where',
  'group by',
  'order by',
  'having',
  'limit',
  'offset',
  'union all',
  'union',
  'insert into',
  'values',
  'update',
  'set',
  'delete from',
  'join',
  'inner join',
  'left join',
  'right join',
  'full join',
  'cross join',
  'on',
  'and',
  'or',
  'not',
  'in',
  'exists',
  'between',
  'like',
  'as',
  'distinct',
  'with',
  'case',
  'when',
  'then',
  'else',
  'end',
  'is',
  'null',
  'asc',
  'desc',
];

/** 轻量 SQL 美化（纯 TS，无第三方依赖；启发式换行与缩进）。 */
function formatSql(sql: string, uppercase: boolean, indent: number): string {
  const trimmed = sql.replace(/\s+/g, ' ').trim();
  if (!trimmed) {
    return '';
  }
  let working = trimmed;
  // 主子句前换行（按长度降序优先匹配，避免 UNION 抢先 UNION ALL）
  const clauses = [...CLAUSES].sort((a, b) => b.length - a.length);
  for (const clause of clauses) {
    const re = new RegExp(`\\s+${clause.replace(/ /g, '\\s+')}\\b`, 'gi');
    working = working.replace(re, `\n${clause}`);
  }
  const lines = working
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  let out = lines
    .map((line, i) => (i === 0 ? line : `${' '.repeat(indent)}${line}`))
    .join('\n');
  if (uppercase) {
    for (const keyword of KEYWORDS) {
      const re = new RegExp(`\\b${keyword.replace(/ /g, '\\s+')}\\b`, 'gi');
      out = out.replace(re, (m) => m.toUpperCase());
    }
  }
  return out;
}

/**
 * SQL 格式化：纯 TS 实现的轻量美化器（项目未引入 sql-formatter 依赖，
 * 以免本次前端改动触发安装 / 破坏类型检查）。支持关键字大写与缩进宽度。
 */
export function SqlFormatter({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [input, setInput] = React.useState<string>(initialInput);
  const [uppercase, setUppercase] = React.useState<boolean>(true);
  const [indent, setIndent] = React.useState<number>(2);

  const output = React.useMemo(
    () => formatSql(input, uppercase, indent),
    [input, uppercase, indent],
  );

  return (
    <CommandShell
      title="SQL 格式化"
      description="SQL 语句美化（轻量纯 TS 实现）"
      icon={<Database className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={output}
      shortcutHint="主子句自动换行缩进；可切换关键字大写"
      samples={[
        {
          label: '单表查询',
          description: '最基础的 SELECT / WHERE / ORDER BY，看主子句如何分行',
          apply: () =>
            setInput('select id, name, email from users where status = 1 and age > 18 order by created_at desc limit 20'),
        },
        {
          label: '多表 JOIN',
          description: 'JOIN / ON / GROUP BY / HAVING 全齐，验证缩进与关键字大写',
          apply: () =>
            setInput(
              'select u.id, u.name, count(o.id) as order_count, sum(o.amount) as total from users u left join orders o on o.user_id = u.id where o.created_at >= "2026-01-01" group by u.id, u.name having count(o.id) > 3 order by total desc',
            ),
        },
        {
          label: '子查询 + 慢 SQL',
          description: '运维常贴的一整条慢查询（含子查询与 IN），最考验格式化效果',
          apply: () =>
            setInput(
              'select t.host, t.query_time, t.sql_text from (select host, max(query_time) as query_time, sql_text from slow_log where query_time > 1 group by host, sql_text) t where t.sql_text like "%orders%" order by t.query_time desc limit 50',
            ),
        },
        {
          label: 'INSERT 批量写入',
          description: 'INSERT INTO … VALUES 的换行与格式保持',
          apply: () =>
            setInput(
              "insert into audit_log (id, action, actor, created_at) values (1, 'login', 'zhuzhiqiang', now()), (2, 'export', 'zhuzhiqiang', now())",
            ),
        },
        {
          label: 'UNION ALL 合并',
          description: '检验 UNION ALL 不被 UNION 抢先匹配（历史上容易踩的坑）',
          apply: () =>
            setInput(
              'select id, kind from online_hosts union all select id, kind from offline_hosts union select id, kind from archived_hosts',
            ),
        },
      ]}
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-3">
          <label className="text-sm font-medium text-foreground" htmlFor="sql-input">
            SQL 输入
          </label>
          <textarea
            id="sql-input"
            rows={12}
            className="w-full min-h-0 flex-1 rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={input}
            placeholder="select id,name from users where age>18 order by name"
            onChange={(event) => setInput(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-foreground">
              <Switch checked={uppercase} onCheckedChange={setUppercase} />
              关键字大写
            </label>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              缩进
              <input
                type="number"
                min={0}
                max={8}
                value={indent}
                onChange={(event) => setIndent(Math.max(0, Math.min(8, Number.parseInt(event.target.value, 10) || 0)))}
                className="h-7 w-16 rounded-md border border-input bg-background px-2 text-sm text-foreground"
              />
            </label>
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <ResultBox title="格式化结果" value={output} emptyHint="输入 SQL 后自动格式化" mono />
        </div>
      </div>
    </CommandShell>
  );
}

export default SqlFormatter;
