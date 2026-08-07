import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { safeEqStr } from '../auth.js';
import {
  listApiKeys, getApiKeyByPrefix, insertApiKey, updateApiKey, deleteApiKey, touchApiKey,
  type ApiKeyRow,
} from '../store/db.js';

/**
 * Nhiều API key có nhãn, mỗi key một user. CHỈ để định danh cho báo cáo —
 * không giới hạn hạn mức, không phân quyền model (mọi key dùng chung pool).
 *
 * Hash bằng SHA-256 chứ KHÔNG phải scrypt: key là chuỗi ngẫu nhiên 256-bit do hệ
 * thống sinh (entropy cao, không dò được bằng từ điển), khác mật khẩu người dùng.
 * Đo thật: scrypt 34,4ms/lần vs sha256 0,0009ms — scrypt ở đường nóng sẽ giết
 * throughput. `dashboardPassword` vẫn dùng scrypt như cũ.
 */

const PREFIX_LEN = 12; // 'agy_' + 8 ký tự — đủ phân biệt, lưu plaintext để lookup + hiển thị

export interface AuthCtx {
  /** '' = ẩn danh (chưa đặt key nào), 'legacy' = GATEWAY_API_KEY cũ, còn lại là id bảng. */
  keyId: string;
  keyName: string;
}

const ANONYMOUS: AuthCtx = { keyId: '', keyName: 'anonymous' };
const LEGACY: AuthCtx = { keyId: 'legacy', keyName: 'legacy' };

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// Cache xác thực: khoá là sha256(raw) để không giữ secret nguyên văn trong RAM.
const cache = new Map<string, { ctx: AuthCtx; at: number }>();
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 500;

export function clearApiKeyCache(): void {
  cache.clear();
}

/** Đọc key thô từ header. Chấp nhận cả 3 dạng client thật hay dùng. */
export function rawKeyOf(req: FastifyRequest): string {
  const xk = (req.headers['x-api-key'] || '') as string;
  if (xk) return xk;
  const h = (req.headers['authorization'] || '') as string;
  if (h.startsWith('Bearer ')) return h.slice(7);
  return h;
}

/**
 * Xác thực key thô. Trả AuthCtx nếu hợp lệ, null nếu không.
 *
 * Thứ tự có chủ đích:
 *  1. Chưa cấu hình key nào (legacy rỗng + bảng rỗng) → CHO QUA, giữ đúng hành vi cũ
 *     `if (!key) return true`. Đổi thành chặn sẽ làm chết mọi deploy chưa đặt key.
 *  2. Khớp GATEWAY_API_KEY cũ → hợp lệ VĨNH VIỄN. Hermes/Claude Code đang dùng key này;
 *     không migrate ngầm nó vào bảng vì nó không có prefix theo format mới nên lookup
 *     sẽ trượt — giữ là nhánh riêng, đơn giản và không thể hỏng.
 *  3. Tra bảng theo prefix (index UNIQUE → tối đa 1 hàng) rồi so hash.
 */
export function resolveApiKey(raw: string, now = Date.now()): AuthCtx | null {
  const legacy = config.gateway.apiKey;
  const hasKeys = listApiKeys().some((k) => k.enabled);

  if (!legacy && !hasKeys) return ANONYMOUS;
  if (!raw) return null;

  if (legacy && safeEqStr(raw, legacy)) return LEGACY;

  const hit = cache.get(sha256(raw));
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.ctx;

  const row = getApiKeyByPrefix(raw.slice(0, PREFIX_LEN));
  if (!row || !row.enabled) return null;
  if (!safeEqStr(sha256(raw), row.hash)) return null;

  const ctx: AuthCtx = { keyId: row.id, keyName: row.name };
  if (cache.size >= CACHE_MAX) cache.clear(); // đơn giản hơn LRU, đủ cho quy mô này
  cache.set(sha256(raw), { ctx, at: now });
  touchApiKey(row.id, now);
  return ctx;
}

/** Xác thực từ request. Dùng chung cho cả 2 dialect (OpenAI và Anthropic). */
export function authenticate(req: FastifyRequest): AuthCtx | null {
  return resolveApiKey(rawKeyOf(req));
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface CreatedKey {
  id: string;
  name: string;
  prefix: string;
  /** Key thô — chỉ trả về ĐÚNG MỘT LẦN lúc tạo, không bao giờ lưu plaintext. */
  key: string;
}

export function createApiKey(name: string, note?: string): CreatedKey {
  const id = 'ak_' + randomUUID().replace(/-/g, '').slice(0, 16);
  // 'agy_' + 8 hex (thành prefix 12 ký tự) + '_' + 32 byte ngẫu nhiên base64url
  const key = `agy_${randomBytes(4).toString('hex')}_${randomBytes(32).toString('base64url')}`;
  insertApiKey({
    id,
    name,
    prefix: key.slice(0, PREFIX_LEN),
    hash: sha256(key),
    enabled: 1,
    created_at: Date.now(),
    note: note ?? null,
  });
  clearApiKeyCache();
  return { id, name, prefix: key.slice(0, PREFIX_LEN), key };
}

/** Dạng an toàn để trả ra API — KHÔNG bao giờ chứa hash hay key thô. */
export function publicApiKey(r: ApiKeyRow) {
  return {
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    enabled: r.enabled !== 0,
    createdAt: r.created_at,
    lastUsed: r.last_used,
    note: r.note,
  };
}

export function listPublicApiKeys() {
  return listApiKeys().map(publicApiKey);
}

export function patchApiKey(id: string, p: { name?: string; note?: string; enabled?: boolean }): boolean {
  const ok = updateApiKey(id, p);
  if (ok) clearApiKeyCache(); // thu hồi phải có hiệu lực NGAY, không đợi TTL
  return ok;
}

export function removeApiKey(id: string): boolean {
  const ok = deleteApiKey(id);
  if (ok) clearApiKeyCache();
  return ok;
}
