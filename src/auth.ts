import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';

/**
 * Đăng nhập dashboard: session cookie ký HMAC (cho trình duyệt) +
 * Basic auth (cho CLI/curl). /proxy/v1/* miễn trừ — dùng GATEWAY_API_KEY riêng.
 */

const COOKIE = 'agy_session';
const MAX_AGE_SEC = 7 * 24 * 3600; // 7 ngày

function sign(payload: string): string {
  return createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
}
function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function makeToken(): string {
  const exp = Date.now() + MAX_AGE_SEC * 1000;
  const payload = `${exp}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string | undefined): boolean {
  if (!token) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  if (!safeEq(sig, sign(payload))) return false;
  const exp = Number(payload);
  return Number.isFinite(exp) && exp > Date.now();
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

export function setSessionCookie(reply: FastifyReply): void {
  reply.header(
    'set-cookie',
    `${COOKIE}=${makeToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SEC}`,
  );
}
export function clearSessionCookie(reply: FastifyReply): void {
  reply.header('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Kiểm mật khẩu (dùng cho login + Basic). */
export function passwordOk(pass: string, user = ''): boolean {
  if (!config.dashboardPassword) return true;
  const userOk = !config.dashboardUser || user === config.dashboardUser;
  return userOk && safeEq(pass, config.dashboardPassword);
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

// Đường dẫn công khai (không cần đăng nhập)
const PUBLIC_PATHS = new Set(['/login', '/login.html', '/style.css', '/api/auth/login', '/favicon.ico']);

export function registerAuth(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    const url = (req.url.split('?')[0] || '');
    if (url.startsWith('/proxy/v1')) return; // gateway dùng API key riêng
    if (PUBLIC_PATHS.has(url)) return;
    if (isAuthed(req)) return;

    // Trình duyệt → chuyển tới màn đăng nhập; API → 401 JSON
    const accept = (req.headers.accept || '') as string;
    if (req.method === 'GET' && accept.includes('text/html')) {
      return reply.redirect('/login');
    }
    return reply.code(401).send({ error: 'unauthorized', login: '/login' });
  });

  // ---- endpoints ----
  app.post('/api/auth/login', async (req, reply) => {
    const { password = '', user = '' } = (req.body as { password?: string; user?: string }) ?? {};
    if (!passwordOk(password, user)) {
      return reply.code(401).send({ ok: false, error: 'Sai mật khẩu' });
    }
    setSessionCookie(reply);
    return { ok: true, mustChange: config.dashboardPassword === '123456' };
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async () => ({
    ok: true,
    user: config.dashboardUser,
    mustChange: config.dashboardPassword === '123456',
  }));
}
