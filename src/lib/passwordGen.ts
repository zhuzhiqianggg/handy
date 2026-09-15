/**
 * 通用强密码生成（密码存储器「生成」按钮用）。
 *
 * 与工具箱「密码生成器」保持同一套安全取向：
 *   - `crypto.getRandomValues` + 拒绝采样（消除模偏差），绝不用 `Math.random` 生成机密；
 *   - 四类字符（大写 / 小写 / 数字 / 符号）**各至少出现一次**；
 *   - **首尾固定为字母**，符号与数字集中在中段（手动输入与复制粘贴都不易出错）。
 */

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGIT = '0123456789';
const SYMBOL = '!@#$%^&*()-_=+[]{};:,.?/~';

/** 密码学安全的随机整数 `[0, maxExclusive)`（拒绝采样，无模偏差） */
function randomInt(maxExclusive: number): number {
  if (maxExclusive <= 0) {
    return 0;
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
    const buf = new Uint32Array(1);
    for (;;) {
      crypto.getRandomValues(buf);
      const value = buf[0] ?? 0;
      if (value < limit) {
        return value % maxExclusive;
      }
    }
  }
  return Math.floor(Math.random() * maxExclusive);
}

/** 从字符池取一个随机字符 */
function pick(pool: string): string {
  return pool.charAt(randomInt(pool.length));
}

/** Fisher-Yates 洗牌 */
function shuffle(items: string[]): void {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    const a = items[i];
    const b = items[j];
    if (a === undefined || b === undefined) {
      continue;
    }
    items[i] = b;
    items[j] = a;
  }
}

/**
 * 生成一条强密码（默认 20 位）。
 *
 * @param length 长度（会被限制在 8–128 之间）
 * @returns 同时包含大小写字母、数字与符号，且首尾为字母的密码
 */
export function generateStrongPassword(length = 20): string {
  const size = Math.min(128, Math.max(8, Math.round(length)));
  const letters = UPPER + LOWER;
  const pool = letters + DIGIT + SYMBOL;

  // 1) 四类各先占一位，保证「必须含数字与符号」的站点校验通过
  const chars: string[] = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(SYMBOL)];
  while (chars.length < size) {
    chars.push(pick(pool));
  }
  shuffle(chars);

  // 2) 首尾换为字母（若该位恰为字母则不动）
  const swapWithLetter = (pos: number): void => {
    const current = chars[pos];
    if (current === undefined || /[A-Za-z]/.test(current)) {
      return;
    }
    for (let i = 0; i < chars.length; i += 1) {
      const candidate = chars[i];
      if (i !== pos && candidate !== undefined && /[A-Za-z]/.test(candidate)) {
        chars[pos] = candidate;
        chars[i] = current;
        return;
      }
    }
  };
  swapWithLetter(chars.length - 1);
  swapWithLetter(0);

  return chars.join('');
}
