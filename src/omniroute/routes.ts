import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { omniroute } from './client.js';
import { dongBo, trangThai, dangBat } from './sync.js';

/**
 * API cho dashboard quản lý kết nối OmniRoute.
 *
 * Tách khỏi `src/routes.ts` (đã 586 dòng) và đăng ký từ `registerRoutes` giống
 * `registerToolRoutes`. Auth có sẵn: hook `onRequest` trong `src/auth.ts` bảo vệ mọi
 * `/api/*` không nằm trong `PUBLIC_PATHS`.
 *
 * Theo lối trả lỗi kiểu 2 của repo (`{ ok: false, error }` + HTTP 200) vì đây đều là thao
 * tác "thử" — OmniRoute hỏng không phải lỗi của người gọi.
 */
export function registerOmnirouteRoutes(app: FastifyInstance): void {
  app.get('/api/omniroute/status', async () => trangThai());

  app.post('/api/omniroute/sync', async (req) => {
    const { target } = (req.body ?? {}) as { target?: 'agy' | 'kiro' };
    const kq = await dongBo(target);
    return { ok: kq.ok, boQua: kq.boQua, chiTiet: kq.chiTiet, ketQua: kq.ketQua };
  });

  app.post('/api/omniroute/test', async () => {
    if (!dangBat()) return { ok: false, error: 'chưa đặt mật khẩu OmniRoute' };
    try {
      omniroute.reset();
      const conns = await omniroute.listConnections();
      return { ok: true, url: config.omniroute.url, connections: conns.length };
    } catch (e) {
      return { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
    }
  });
}
