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

  // Docker: đặt HOST=0.0.0.0 để truy cập từ ngoài container. Mặc định localhost (an toàn).
  await app.listen({ port: config.port, host: process.env.HOST ?? '127.0.0.1' });

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
