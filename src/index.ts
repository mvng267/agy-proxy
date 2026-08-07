import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import { config, PUBLIC_DIR, SCREENSHOTS_DIR } from './config.js';
import { store } from './store/index.js';
import { registerRoutes } from './routes.js';
import { bus, type AppEvent } from './events.js';
import { omniroute } from './omniroute/client.js';
import { startHealthLoop } from './health/tokenHealth.js';
import { registerAuth } from './auth.js';
import { verifyPassword } from './security.js';
import { setBareMode } from './gateway/providers/index.js';
import { flushPersist } from './gateway/pool.js';
import { readFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';

async function main() {
  store.load();

  // bodyLimit: Fastify mặc định CHỈ 1 MB → tool coding gửi cả file + lịch sử hội thoại
  // là dính 413 FST_ERR_CTP_BODY_TOO_LARGE. 32 MB khớp giới hạn phía client (Claude Code…).
  const app = Fastify({ logger: false, bodyLimit: config.maxBodyMb * 1024 * 1024 });
  await app.register(formbody);

  // Bảo vệ dashboard + /api/* bằng Basic auth khi có DASHBOARD_PASSWORD.
  // (/proxy/v1/* dùng GATEWAY_API_KEY riêng nên bỏ qua ở đây.)
  // Đăng nhập: session cookie (trình duyệt) + Basic (CLI). Đổi mật khẩu có hiệu lực NGAY.
  setBareMode(config.gateway.bareModels);
  registerAuth(app);

  // Màn đăng nhập
  app.get('/login', async (_req, reply) => {
    reply.type('text/html');
    return readFileSync(resolve(PUBLIC_DIR, 'login.html'), 'utf8');
  });

  // Static: dashboard + screenshots
  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: '/' });
  await app.register(fastifyStatic, {
    root: SCREENSHOTS_DIR,
    prefix: '/screenshots/',
    decorateReply: false,
  });

  /**
   * SPA fallback: dashboard React dùng client-side routing, nên F5 tại `/pool` phải trả
   * index.html chứ không phải 404 (đo trước khi sửa: `/` → 200 nhưng `/pool` → 404).
   *
   * Whitelist prefix tường minh — nuốt nhầm `/api/*` hay `/v1/*` sẽ biến lỗi 404 rõ ràng
   * thành một trang HTML mà client API không parse được, rất khó chẩn đoán.
   */
  const API_PREFIXES = ['/api/', '/proxy/', '/v1/', '/anthropic/', '/openai/', '/events', '/screenshots/'];
  app.setNotFoundHandler((req, reply) => {
    const url = req.url.split('?')[0] || '';
    const isApi = API_PREFIXES.some((p) => url === p.replace(/\/$/, '') || url.startsWith(p));
    const wantsHtml = (req.headers.accept || '').includes('text/html');
    if (req.method === 'GET' && wantsHtml && !isApi) {
      reply.type('text/html');
      return reply.send(readFileSync(resolve(PUBLIC_DIR, 'index.html'), 'utf8'));
    }
    return reply.code(404).send({ error: 'not found' });
  });

  // SSE realtime log/trạng thái
  app.get('/events', (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.write('retry: 3000\n\n');
    const onEvent = (e: AppEvent) => {
      reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    bus.on('event', onEvent);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25000);
    req.raw.on('close', () => {
      clearInterval(ping);
      bus.off('event', onEvent);
    });
  });

  await registerRoutes(app);

  // HOST=0.0.0.0 để truy cập từ máy khác/Docker. Mặc định localhost (an toàn).
  await app.listen({ port: config.port, host: config.host });

  console.log(`\n  Dashboard:  http://localhost:${config.port}`);
  console.log(`  OmniRoute:  ${config.omniroute.url}`);
  console.log(`  Accounts:   ${store.listAccounts().length} | Proxies: ${store.listProxies().length}\n`);

  /**
   * Cảnh báo phơi nhiễm khi lắng nghe ngoài localhost.
   * .env.example có ghi chú nhưng KHÔNG cưỡng chế được: deploy quên đặt thì dashboard
   * (hiện token + cho export backup chứa toàn bộ refresh token) và /proxy/v1 mở cho bất
   * kỳ ai chạm được cổng. gatewayApiKey rỗng nghĩa là bỏ qua auth hoàn toàn, không phải
   * "chưa cấu hình" — xem `if (!key) return true` trong gateway/routes.ts.
   */
  const exposed = config.host === '0.0.0.0' || config.host === '::';
  if (exposed) {
    const weak: string[] = [];
    if (verifyPassword('123456', config.dashboardPassword)) weak.push('DASHBOARD_PASSWORD vẫn là mặc định 123456');
    if (!config.gateway.apiKey) weak.push('GATEWAY_API_KEY trống → /proxy/v1 KHÔNG kiểm tra key');
    if (weak.length) {
      console.log(`  ⚠ Đang lắng nghe ${config.host} (truy cập được từ máy khác):`);
      for (const w of weak) console.log(`      · ${w}`);
      console.log('    Đặt trong .env rồi khởi động lại trước khi dùng thật.\n');
    }
  }

  // Kiểm tra kết nối OmniRoute (không chặn khởi động)
  omniroute
    .ensureAuth()
    .then(() => console.log('  ✓ OmniRoute login OK'))
    .catch((e) => console.log(`  ⚠ OmniRoute chưa kết nối được: ${e instanceof Error ? e.message : e}`));

  // Vòng lặp tự kiểm token health định kỳ
  startHealthLoop(config.tokenHealthHours);
}

/**
 * Service chạy dài: một promise reject lạc (fetch upstream hỏng giữa chừng, stream bị
 * client ngắt…) mặc định làm Node THOÁT hẳn — mất cả pool đang phục vụ chỉ vì một request.
 * Ghi log rồi chạy tiếp; lỗi thật sự chết người vẫn nổi lên qua health check.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.stack ?? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.stack ?? err);
});

// SIGTERM: docker stop / systemd restart / `agyproxy stop` đều gửi tín hiệu này.
// savePersist() có DEBOUNCE timer nên thoát ngay sẽ mất state vừa đổi (counter, cooldown,
// enabled…) — phải flushPersist() trước khi exit.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    // Ghi thẳng fd 1: khi stdout bị redirect ra file/pipe nó được buffer, mà process.exit()
    // cắt ngay không flush → dòng log biến mất dù handler đã chạy.
    try { writeSync(1, `\n  ${sig} — đang lưu state rồi dừng…\n`); } catch { /* stdout đóng */ }
    try { flushPersist(); } catch { /* vẫn thoát dù ghi lỗi */ }
    process.exit(0);
  });
}

main().catch((e) => {
  console.error('Boot failed:', e);
  process.exit(1);
});
