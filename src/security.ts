import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Băm mật khẩu bằng scrypt (node:crypto — không thêm dependency).
 * Định dạng: scrypt$N$r$p$<salt_b64>$<hash_b64>
 * Tự nhận biết mật khẩu plaintext cũ để nâng cấp dần (không bắt người dùng đổi).
 */

const N = 16384; // 2^14
const R = 8;
const P = 1;
const KEYLEN = 32;
const PREFIX = 'scrypt$';

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, KEYLEN, { N, r: R, p: P });
  return `${PREFIX}${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function isHashed(stored: string): boolean {
  return typeof stored === 'string' && stored.startsWith(PREFIX);
}

function safeEq(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** So khớp mật khẩu — hỗ trợ cả hash mới lẫn plaintext cũ (để migrate). */
export function verifyPassword(pw: string, stored: string): boolean {
  if (!stored) return false;
  if (!isHashed(stored)) {
    // plaintext cũ — vẫn so sánh timing-safe
    return safeEq(Buffer.from(pw), Buffer.from(stored));
  }
  const parts = stored.slice(PREFIX.length).split('$');
  if (parts.length !== 5) return false;
  const [nS, rS, pS, saltB64, hashB64] = parts;
  try {
    const salt = Buffer.from(saltB64!, 'base64');
    const expect = Buffer.from(hashB64!, 'base64');
    const got = scryptSync(pw, salt, expect.length, { N: Number(nS), r: Number(rS), p: Number(pS) });
    return safeEq(got, expect);
  } catch {
    return false;
  }
}
