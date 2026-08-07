import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config, saveSettings } from './config.js';
import { hashPassword, verifyPassword, isHashed } from './security.js';
import {
  createSession, getSession, touchSession, deleteSession, deleteAllSessions,
  listSessions, pruneSessions, addAuthLog, failedLoginCount, clearFailedLogins, recentAuthLog, getSetting,
} from './store/db.js';

/**
 * Đăng nhập dashboard:
 *  - Trình duyệt: session cookie (id ký HMAC), phiên lưu DB → thu hồi được.
 *  - CLI/curl: Basic auth.
 *  - /proxy/v1/*: miễn trừ, dùng GATEWAY_API_KEY riêng.
 * Kèm chống brute-force (khoá theo IP) + log đăng nhập.
 */

const COOKIE = 'agy_session';
const MAX_AGE_SEC = 7 * 24 * 3600; // 7 ngày

// Nâng cấp mật khẩu plaintext cũ → hash (chạy 1 lần lúc boot, người dùng không phải làm gì).
if (config.dashboardPassword && !isHashed(config.dashboardPassword)) {
  const hashed = hashPassword(config.dashboardPassword);
  config.dashboardPassword = hashed;
  saveSettings({ dashboardPassword: hashed });
}
pruneSessions();

function sign(payload: string): string {
  return createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
}
/** So sánh chuỗi timing-safe. Export để gateway dùng chung, không viết bản thứ hai. */
export function safeEqStr(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function ipOf(req: FastifyRequest): string {
  const fwd = (req.headers['x-forwarded-for'] as string) || '';
  return (fwd.split(',')[0] || req.ip || '').trim() || 'unknown';
}
function uaOf(req: FastifyRequest): string {
  return ((req.headers['user-agent'] as string) || '').slice(0, 200);
}

/** Tạo phiên mới (lưu DB) → token cookie. */
export function newSession(req: FastifyRequest): string {
  const id = randomBytes(18).toString('base64url');
  const exp = Date.now() + MAX_AGE_SEC * 1000;
  createSession(id, exp, ipOf(req), uaOf(req));
  return `${id}.${sign(id)}`;
}

/** Kiểm token: chữ ký hợp lệ + phiên còn trong DB. Trả sessionId nếu hợp lệ. */
export function verifyToken(token: string | undefined): string | null {
  if (!token) return null;
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const id = token.slice(0, i);
  const sig = token.slice(i + 1);
  if (!safeEqStr(sig, sign(id))) return null;
  const s = getSession(id);
  if (!s || s.expires_at <= Date.now()) return null;
  if (Date.now() - s.last_seen > 60_000) touchSession(id); // throttle ghi
  return id;
}

function readCookie(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function isHttps(req: FastifyRequest): boolean {
  return req.protocol === 'https' || (req.headers['x-forwarded-proto'] as string) === 'https';
}
export function setSessionCookie(reply: FastifyReply, req: FastifyRequest, token: string): void {
  const secure = isHttps(req) ? '; Secure' : '';
  reply.header('set-cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SEC}${secure}`);
}
export function clearSessionCookie(reply: FastifyReply): void {
  reply.header('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Kiểm mật khẩu (hash hoặc plaintext cũ) + user nếu có đặt. */
export function passwordOk(pass: string, user = ''): boolean {
  if (!config.dashboardPassword) return true;
  // Token riêng cho CLI (mật khẩu đã băm nên CLI không dùng lại được).
  const cliToken = getSetting('cliToken');
  if (cliToken && pass && safeEqStr(pass, cliToken)) return true;
  const userOk = !config.dashboardUser || user === config.dashboardUser;
  return userOk && verifyPassword(pass, config.dashboardPassword);
}

/** Request đã xác thực chưa (cookie hoặc Basic). */
export function isAuthed(req: FastifyRequest): boolean {
  if (!config.dashboardPassword) return true;
  if (verifyToken(readCookie(req, COOKIE))) return true;
  const h = (req.headers['authorization'] || '') as string;
  if (h.startsWith('Basic ')) {
    const raw = Buffer.from(h.slice(6), 'base64').toString('utf8');
    const i = raw.indexOf(':');
    return passwordOk(i >= 0 ? raw.slice(i + 1) : '', i >= 0 ? raw.slice(0, i) : '');
  }
  return false;
}

/** Còn bị khoá vì đăng nhập sai nhiều lần? → số phút còn lại (0 = không khoá). */
function lockRemainMin(ip: string): number {
  const windowMs = Math.max(1, config.loginLockMin) * 60_000;
  const fails = failedLoginCount(ip, windowMs);
  return fails >= Math.max(1, config.loginMaxFail) ? Math.max(1, config.loginLockMin) : 0;
}

// `/api/health` công khai: load balancer / uptime monitor / `docker healthcheck` gọi nó
// mà không có phiên đăng nhập — bắt auth thì health check luôn thấy 401 và coi như service
// chết. Payload chỉ gồm số đếm + version, không có email/token/secret nào.
const PUBLIC_PATHS = new Set(['/login', '/login.html', '/style.css', '/api/auth/login', '/favicon.ico', '/api/health']);

export function registerAuth(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0] || '';
    // Endpoint suy luận dùng GATEWAY_API_KEY riêng, không dùng phiên dashboard:
    //  /proxy/v1/*  (OpenAI)   ·  /v1/*, /anthropic/*  (Anthropic — Claude Code gọi <base>/v1/messages)
    if (url.startsWith('/proxy/v1') || url.startsWith('/v1/') || url.startsWith('/anthropic/')) return;
    if (PUBLIC_PATHS.has(url)) return;
    if (isAuthed(req)) return;

    const accept = (req.headers.accept || '') as string;
    if (req.method === 'GET' && accept.includes('text/html')) return reply.redirect('/login');
    return reply.code(401).send({ error: 'unauthorized', login: '/login' });
  });

  // ---- endpoints ----
  app.post('/api/auth/login', async (req, reply) => {
    const { password = '', user = '' } = (req.body as { password?: string; user?: string }) ?? {};
    const ip = ipOf(req);
    const lock = lockRemainMin(ip);
    if (lock > 0) {
      addAuthLog(ip, uaOf(req), false, 'locked');
      return reply.code(429).send({ ok: false, error: `Sai quá nhiều lần — thử lại sau ${lock} phút` });
    }
    if (!passwordOk(password, user)) {
      addAuthLog(ip, uaOf(req), false, 'wrong_password');
      const left = Math.max(0, config.loginMaxFail - failedLoginCount(ip, config.loginLockMin * 60_000));
      return reply.code(401).send({ ok: false, error: `Sai mật khẩu${left > 0 ? ` (còn ${left} lần)` : ''}` });
    }
    clearFailedLogins(ip);
    addAuthLog(ip, uaOf(req), true, 'login');
    setSessionCookie(reply, req, newSession(req));
    return { ok: true, mustChange: verifyPassword('123456', config.dashboardPassword) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const id = verifyToken(readCookie(req, COOKIE));
    if (id) deleteSession(id);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => ({
    ok: true,
    user: config.dashboardUser,
    mustChange: verifyPassword('123456', config.dashboardPassword),
    sessionId: verifyToken(readCookie(req, COOKIE)),
  }));

  // Danh sách phiên + thu hồi
  app.get('/api/auth/sessions', async (req) => {
    const cur = verifyToken(readCookie(req, COOKIE));
    return {
      sessions: listSessions().map((s) => ({ ...s, current: s.id === cur })),
      log: recentAuthLog(20),
    };
  });
  app.post('/api/auth/sessions/revoke', async (req) => {
    const { id, others } = (req.body as { id?: string; others?: boolean }) ?? {};
    const cur = verifyToken(readCookie(req, COOKIE));
    if (others) return { ok: true, revoked: deleteAllSessions(cur ?? undefined) };
    if (id) { deleteSession(id); return { ok: true, revoked: 1 }; }
    return { ok: false, error: 'thiếu id' };
  });
}
