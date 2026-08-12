import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Mọi route admin phải THẬT SỰ được đăng ký sau khi app boot.
 *
 * Lý do test này tồn tại: `admin.ts` từng dài 1.140 dòng và được cắt làm hai
 * (`admin.ts` + `reports.ts`). Toàn bộ test đang có cho nhóm này chỉ QUÉT CHỮ trong file
 * nguồn — chúng vẫn xanh khi module con tồn tại nhưng người ta quên gọi
 * `registerReportRoutes(app)`. Khi đó dashboard 404 sạch phần báo cáo mà CI không kêu.
 *
 * Ở đây boot Fastify thật rồi bắn từng đường: chỉ cần route vắng mặt là 404 và test đỏ.
 * Không kiểm nội dung trả về — chuyện đó đã có test riêng của từng nhóm.
 *
 * AGY_HOME trỏ thư mục tạm TRƯỚC mọi import chạm dữ liệu — xem test/data-safety.test.ts.
 */
const TMP_HOME = mkdtempSync(resolve(tmpdir(), 'agy-adminroutes-'));
process.env.AGY_HOME = TMP_HOME;

const { store } = await import('../../src/store/index.js');
const { config } = await import('../../src/config.js');
const { registerGatewayRoutes } = await import('../../src/gateway/routes.js');
const Fastify = (await import('fastify')).default;
const formbody = (await import('@fastify/formbody')).default;
type FastifyInstance = import('fastify').FastifyInstance;

let app: FastifyInstance;

before(async () => {
  store.load();
  config.gateway.enabled = true;
  app = Fastify();
  await app.register(formbody);
  await registerGatewayRoutes(app);
  await app.ready();
});

after(async () => {
  await app?.close();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

/** Nhóm báo cáo — đây là phần vừa rời khỏi `admin.ts`, nên là phần dễ rơi nhất. */
const BAO_CAO = [
  '/api/combos/runs',
  '/api/gateway/usage',
  '/api/gateway/usage/logs',
  '/api/gateway/usage/compare',
  '/api/gateway/usage/export.csv',
  '/api/gateway/quota/history',
  '/api/metrics/history',
];

/** Nhóm trạng thái pool tức thời — vừa rời sang `poolStatus.ts`. */
const POOL_STATUS = [
  '/api/metrics',
  '/api/gateway/stats',
  '/api/gateway/quota-summary',
];

/**
 * Nhóm thử nghiệm — vừa rời sang `adminTest.ts`.
 *
 * Toàn POST và chúng TỐN QUOTA THẬT, nên ở đây chỉ kiểm sự có mặt bằng cách bắn GET:
 * route tồn tại thì Fastify trả 404 kèm thân `Route GET:... not found`, còn vắng mặt thì
 * cũng 404 — không phân biệt được. Dùng `printRoutes` thay vì gọi thẳng.
 */
const THU_NGHIEM = [
  '/api/gateway/chat',
  '/api/gateway/accounts/check',
  '/api/gateway/accounts/test-bulk',
  '/api/gateway/models/check',
  '/api/gateway/probe',
];

/** Vài đường tiêu biểu còn ở `admin.ts` — để lần tách sau không kéo nhầm chúng đi. */
const CON_LAI = [
  '/api/gateway/accounts',
  '/api/gateway/config',
  '/api/gateway/keys',
  '/api/combos',
  '/api/gateway/models',
  '/api/cli/connect',
];

describe('route admin có mặt sau khi boot', () => {
  for (const url of [...BAO_CAO, ...POOL_STATUS, ...CON_LAI]) {
    test(`GET ${url} không 404`, async () => {
      const r = await app.inject({ method: 'GET', url });
      assert.notEqual(r.statusCode, 404, `${url} chưa được đăng ký (route bị rơi khi tách file?)`);
      // 500 cũng là hỏng — nhưng phân biệt được với "vắng mặt" nên nói rõ trong thông điệp.
      assert.ok(r.statusCode < 500, `${url} trả ${r.statusCode}: ${r.body.slice(0, 200)}`);
    });
  }

  for (const url of THU_NGHIEM) {
    test(`POST ${url} có trong bảng route`, () => {
      /**
       * Không `inject` — gọi thật là tiêu quota thật. Bảng route đủ để biết nó có mặt.
       *
       * Phải khớp ĐƯỜNG ĐẦY ĐỦ. Bản đầu dò theo hậu tố (`url.split('/').pop()`) và
       * `/api/gateway/chat` khớp nhầm `/v1/chat/completions` — test vẫn xanh sau khi gỡ
       * hẳn `registerTestRoutes`, đúng loại lỗi mà chính test này sinh ra để bắt.
       */
      assert.ok(app.hasRoute({ method: 'POST', url }), `${url} không thấy trong bảng route`);
    });
  }

  test('mọi đường báo cáo nằm đúng trong bảng route với method GET', () => {
    /**
     * `inject` ở trên chứng minh đường CHẠY được, nhưng nó đi qua tầng xác thực nên một
     * ngày nào đó hook auth trả sớm là mọi khẳng định "không 404" thành vô nghĩa —
     * chuyện này ĐÃ xảy ra khi kiểm trên production: `/api/khong-he-ton-tai` cũng trả
     * 401 y hệt đường có thật, vì hook auth chạy trước routing.
     *
     * `hasRoute` hỏi thẳng bảng định tuyến, không qua hook nào.
     */
    for (const url of [...BAO_CAO, ...POOL_STATUS]) {
      assert.ok(app.hasRoute({ method: 'GET', url }), `${url} không có trong bảng route`);
    }
  });
});

describe('cắt file không làm mất endpoint', () => {
  test('số route ít nhất bằng lúc trước khi tách', () => {
    /**
     * ĐO thật, không ước: boot cả hai bản (trước và sau khi cắt `admin.ts`) rồi đếm
     * `printRoutes` — cả hai đều ra **48**. Con số này chỉ được TĂNG; giảm nghĩa là một
     * nhóm rơi mất trong lúc dọn file, thứ khó thấy nhất vì typecheck vẫn sạch và mọi
     * test quét-chữ vẫn xanh.
     */
    const cay = app.printRoutes({ commonPrefix: false });
    const n = cay.split('\n').filter((l) => /\((GET|POST|PATCH|DELETE)/.test(l)).length;
    assert.ok(n >= 48, `chỉ còn ${n} route, trước khi tách có 48 — có nhóm bị rơi`);
  });
});
