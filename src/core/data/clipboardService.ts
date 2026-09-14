import { isTauri } from '@/platform/detect';
import { execute, select } from '@/lib/db';
import { ipc } from '@/lib/ipc';
import { BUS_EVENT_CLIPS_CHANGED, busEmit } from './bus';
import type { ClipInput, ClipItem } from '@/types/clipboard';

export type { ClipInput, ClipItem };

/**
 * 剪贴板历史数据服务（M4，V10）。
 *
 * **实现选择（与 notes/todos 一致）**：CRUD 走前端 `lib/db` 直连 SQLite；
 * 批量落库（监听写入）走 Rust `clip_add_batch`——去重（唯一索引 UPSERT）、按
 * `settings.maxClipboard` 裁剪、FTS 对账都收敛在 Rust 侧单处完成，前端监听器只管
 * 「读剪贴板 → 判敏感 → 交给本服务」。
 *
 * 跨窗口同步：写操作后经 `busEmit(BUS_EVENT_CLIPS_CHANGED, …)` 广播（V11 UI 消费）。
 */

/** DB 行（snake_case）→ 实体（camelCase） */
function rowToClip(row: Record<string, unknown>): ClipItem {
  return {
    id: String(row.id ?? ''),
    kind: String(row.kind ?? 'text'),
    content: String(row.content ?? ''),
    thumb: row.thumb === null || row.thumb === undefined ? null : String(row.thumb),
    sourceApp:
      row.source_app === null || row.source_app === undefined ? null : String(row.source_app),
    pinned: Number(row.pinned ?? 0) !== 0,
    sensitive: Number(row.sensitive ?? 0) !== 0,
    createdAt: Number(row.created_at ?? 0),
  };
}

/** 便签需要 SQLite（仅 Tauri 宿主内可用）；否则抛出可读错误。 */
function assertDesktop(): void {
  if (!isTauri()) {
    throw new Error('剪贴板历史需要 Handy 桌面环境（SQLite 不可用）');
  }
}

/** 跨窗口同步事件载荷（`clips:changed`） */
export interface ClipsChangedPayload {
  action: 'add' | 'update' | 'delete' | 'clear';
  /** update / delete 时：目标条目 id */
  id?: string;
  /** add / clear 时：条数 */
  count?: number;
}

/** 分页读取历史（新 → 旧；V11 UI 可再按 pinned 置顶展示） */
export async function listClips(limit = 100, offset = 0): Promise<ClipItem[]> {
  assertDesktop();
  const rows = await select<Record<string, unknown>>(
    `SELECT id, kind, content, thumb, source_app, pinned, sensitive, created_at
     FROM clip_items ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [limit, offset],
  );
  return rows.map(rowToClip);
}

/** 翻转置顶；成功后广播 update */
export async function togglePinClip(id: string): Promise<void> {
  assertDesktop();
  await execute('UPDATE clip_items SET pinned = 1 - pinned WHERE id = ?', [id]);
  await busEmit<ClipsChangedPayload>(BUS_EVENT_CLIPS_CHANGED, { action: 'update', id });
}

/** 删除单条；成功后广播 delete */
export async function deleteClip(id: string): Promise<void> {
  assertDesktop();
  await execute('DELETE FROM clip_items WHERE id = ?', [id]);
  await busEmit<ClipsChangedPayload>(BUS_EVENT_CLIPS_CHANGED, { action: 'delete', id });
}

/** 清空非置顶条目，返回删除条数；成功后广播 clear */
export async function clearClips(): Promise<number> {
  assertDesktop();
  const result = await execute('DELETE FROM clip_items WHERE pinned = 0');
  await busEmit<ClipsChangedPayload>(BUS_EVENT_CLIPS_CHANGED, {
    action: 'clear',
    count: result.rowsAffected,
  });
  return result.rowsAffected;
}

/**
 * 全文搜索（FTS5, unicode61）。
 *
 * 用户输入整段作为**短语**匹配（包裹双引号并转义内部引号），避免用户输入中的
 * FTS 语法字符（`*`、`NEAR`、`-` 等）被当作查询语法导致报错或语义漂移；
 * 空查询退化为普通倒序列表。
 */
export async function searchClips(query: string, limit = 50): Promise<ClipItem[]> {
  assertDesktop();
  const q = query.trim();
  if (q.length === 0) {
    return listClips(limit);
  }
  const phrase = `"${q.replace(/"/g, '""')}"`;
  const rows = await select<Record<string, unknown>>(
    `SELECT ci.id, ci.kind, ci.content, ci.thumb, ci.source_app, ci.pinned, ci.sensitive, ci.created_at
     FROM clip_fts f JOIN clip_items ci ON ci.id = f.ref_id
     WHERE clip_fts MATCH ?1
     ORDER BY ci.created_at DESC LIMIT ?2`,
    [phrase, limit],
  );
  return rows.map(rowToClip);
}

/** 批量落库（Rust 侧去重 / 裁剪 / FTS 对账）；成功后广播 add */
export async function addClipItems(items: ClipInput[]): Promise<number> {
  assertDesktop();
  if (items.length === 0) {
    return 0;
  }
  const count = await ipc.clipAddBatch(items);
  await busEmit<ClipsChangedPayload>(BUS_EVENT_CLIPS_CHANGED, { action: 'add', count });
  return count;
}

/**
 * 监听器入口：记录一条剪贴板文本。
 * 敏感判定在前（命中即不落库），去重与裁剪由 Rust 侧完成。
 * @returns 是否实际落库（敏感内容 / 空内容返回 false）
 */
export async function recordClipboardText(text: string): Promise<boolean> {
  if (text.length === 0 || isSensitiveClipboard(text)) {
    return false;
  }
  await addClipItems([{ kind: 'text', content: text }]);
  return true;
}

/**
 * 敏感剪贴板判定（V10，可测试的纯函数）。
 *
 * **取舍：命中即不落库**（而非落库 `sensitive = 1` 再隐藏）。理由：产品承诺
 * 「敏感内容不留痕」——`sensitive = 1` 的行仍会把明文密钥写进磁盘上的 handy.db
 * （含 WAL 副本），与承诺冲突。schema 的 `sensitive` 列保留，供将来「会话内易失
 * 条目」（仅内存、退出即清）复用，当前恒不写入。
 *
 * 规则（启发式，**宁枉勿纵**——误杀一条普通文本的代价远低于密钥入库）：
 *   1. PEM 私钥头：`-----BEGIN … PRIVATE KEY-----`；
 *   2. JWT 三段式（`eyJ…` 开头、两处 `.` 分隔）；
 *   3. 常见密钥前缀：`sk-` / `rk-` / `pk-` + ≥16 位字母数字（OpenAI / Stripe 风格）；
 *   4. 明文凭据赋值：password / passwd / pwd / secret / api_key / access_token /
 *      auth_token / private_key 后跟 `:` 或 `=` 的形式；
 *   5. `Bearer` 令牌；
 *   6. 高熵随机串：单行、无空格、长度 ≥ 20、字符集限于 URL-safe 集合、**不含 `://`
 *      或「域名.后缀」形态**（排除 URL），且至少含数字与字母、字符类别 ≥ 3
 *      （小写 / 大写 / 数字 / 符号）。
 *
 * 已知局限（有意接受）：长 Base64 Blob（如内联图片数据）会被误判为敏感——但此类
 * 内容本就几乎无历史价值；普通 URL / 日期 / 电话 / 句子均不命中。
 */
export function isSensitiveClipboard(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) {
    return false;
  }
  // 1) PEM 私钥
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(t)) {
    return true;
  }
  // 2) JWT
  if (/^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(t)) {
    return true;
  }
  // 3) 云厂商密钥前缀
  if (/\b(?:sk|rk|pk)-[A-Za-z0-9]{16,}\b/.test(t)) {
    return true;
  }
  // 4) 明文凭据赋值
  if (
    /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)\b\s*[:=]\s*\S+/i.test(
      t,
    )
  ) {
    return true;
  }
  // 5) Bearer 令牌
  if (/\bBearer\s+[A-Za-z0-9\-._~+/]{8,}=*/i.test(t)) {
    return true;
  }
  // 6) 高熵随机串（单行、无空格）
  if (!t.includes('\n') && !t.includes(' ') && t.length >= 20 && /^[A-Za-z0-9+/_\-=.~]+$/.test(t)) {
    // 排除 URL：带协议，或呈「域名.后缀(/…)」形态
    if (/:\/\//.test(t) || /\.[a-z]{2,}(\/|$)/i.test(t)) {
      return false;
    }
    const hasLower = /[a-z]/.test(t);
    const hasUpper = /[A-Z]/.test(t);
    const hasDigit = /\d/.test(t);
    const hasSymbol = /[+/_\-=.~]/.test(t);
    const classes = [hasLower, hasUpper, hasDigit, hasSymbol].filter(Boolean).length;
    if (hasDigit && (hasLower || hasUpper) && classes >= 3) {
      return true;
    }
  }
  return false;
}
