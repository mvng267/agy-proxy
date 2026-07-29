import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import { config, PUBLIC_DIR, SCREENSHOTS_DIR } from './config.js';
import { store } from './store/index.js';
import { registerRoutes } from './routes.js';
import { bus, type AppEvent } from './events.js';
import { omniroute } from './omniroute/client.js';
import { startHealthLoop } from './health/tokenHealth.js';

async function main() {
  store.load();

  const app = Fastify({ logger: false });
  await app.register(formbody);

  // Bảo vệ dashboard + /api/* bằng Basic auth khi có DASHBOARD_PASSWORD.
  // (/proxy/v1/* dùng GATEWAY_API_KEY riêng nên bỏ qua ở đây.)
  if (config.dashboardPassword) {
    app.addHook('onRequest', async (req, reply) => {
      if (req.url.startsWith('/proxy/v1')) return;
      const h = (req.headers['authorization'] || '') as string;
      if (h.startsWith('Basic ')) {
        const [, pass] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
        if (pass === config.dashboardPassword) return;
      }
      reply.header('www-authenticate', 'Basic realm="agyproxy"').code(401).send('Unauthorized');
    });
  }

  // Static: dashboard + screenshots
  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: '/' });
  await app.register(fastifyStatic, {
    root: SCREENSHOTS_DIR,
    prefix: '/screenshots/',
    decorateReply: false,
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

  // Kiểm tra kết nối OmniRoute (không chặn khởi động)
  omniroute
    .ensureAuth()
    .then(() => console.log('  ✓ OmniRoute login OK'))
    .catch((e) => console.log(`  ⚠ OmniRoute chưa kết nối được: ${e instanceof Error ? e.message : e}`));

  // Vòng lặp tự kiểm token health định kỳ
  startHealthLoop(config.tokenHealthHours);
}

main().catch((e) => {
  console.error('Boot failed:', e);
  process.exit(1);
});
