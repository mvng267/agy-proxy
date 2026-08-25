import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Đồng bộ credential sang OmniRoute.
 *
 * Ba điều phải đúng, mỗi cái đều đã hỏng thật một lần:
 *
 * 1. **Chưa cấu hình = im lặng tuyệt đối.** Lần tích hợp trước bị gỡ hẳn (commit 55bce31)
 *    vì OmniRoute trả 401 mọi lần khởi động và sinh 303 dòng cảnh báo trong `run_logs`.
 * 2. **Lỗi không được lọt ra.** OmniRoute là thành phần tuỳ chọn; nó hỏng thì agy-proxy
 *    vẫn phải chạy.
 * 3. **Chia lô đúng 50.** Trần của `importAgyAuthBulkSchema` — gửi 51 là cả lô bị từ chối.
 */

/**
 * KHÔNG đặt `process.env.AGY_HOME` ở đây.
 *
 * File này không chạm store — nó chỉ kiểm `dangBat()`, khoá chống chạy chồng, và nội dung
 * mã nguồn. Nhưng `node --test` chạy mọi file trong CÙNG process, nên `AGY_HOME` đặt ở đây
 * thắng luôn file khác load sau: `test/api/anthropic-tools.test.ts` gieo credential Kiro vào
 * thư mục tạm của NÓ, rồi `loadCredentials()` đọc CSV của thư mục NÀY và không thấy gì →
 * pool hết account Kiro → 503 thay vì 200. Chạy riêng thì pass, chạy cả bộ thì hỏng.
 */
const TMP = mkdtempSync(resolve(tmpdir(), 'agy-omni-'));

let sync: typeof import('../../src/omniroute/sync.js');
let cfg: typeof import('../../src/config.js');

before(async () => {
  cfg = await import('../../src/config.js');
  sync = await import('../../src/omniroute/sync.js');
});
after(() => rmSync(TMP, { recursive: true, force: true }));

describe('dangBat — cổng duy nhất quyết định có gọi OmniRoute không', () => {
  test('mật khẩu rỗng ⇒ tắt', () => {
    cfg.config.omniroute.password = '';
    assert.equal(sync.dangBat(), false);
  });

  test('có mật khẩu ⇒ bật', () => {
    cfg.config.omniroute.password = 'x';
    assert.equal(sync.dangBat(), true);
    cfg.config.omniroute.password = '';
  });
});

describe('dongBo — chưa cấu hình thì bỏ qua êm', () => {
  test('trả boQua, KHÔNG ném lỗi, không đụng mạng', async () => {
    cfg.config.omniroute.password = '';
    const kq = await sync.dongBo();
    assert.equal(kq.ok, true, 'bỏ qua không phải là thất bại');
    assert.equal(kq.boQua, true);
    assert.equal(kq.ketQua.length, 0);
  });
});

describe('dongBo — OmniRoute hỏng thì nuốt lỗi', () => {
  test('URL không tồn tại ⇒ ok:false nhưng KHÔNG ném', async () => {
    // Cổng 1 chắc chắn không có ai nghe → mọi request hỏng ngay.
    cfg.config.omniroute.password = 'x';
    cfg.config.omniroute.url = 'http://127.0.0.1:1';
    const kq = await sync.dongBo();
    assert.equal(kq.ok, false);
    assert.ok(typeof kq.chiTiet === 'string' && kq.chiTiet.length > 0, 'phải nói rõ hỏng vì gì');
    cfg.config.omniroute.password = '';
  });
});

describe('trangThai — luôn trả lời được, kể cả khi OmniRoute chết', () => {
  test('chưa bật ⇒ bat:false, vẫn đếm được credential phía agy-proxy', async () => {
    cfg.config.omniroute.password = '';
    const t = await sync.trangThai();
    assert.equal(t.bat, false);
    assert.equal(t.ketNoi, false);
    assert.ok(typeof t.agyproxy === 'object', 'phải luôn có số liệu phía mình');
  });

  test('bật mà không kết nối được ⇒ ketNoi:false kèm lý do', async () => {
    cfg.config.omniroute.password = 'x';
    cfg.config.omniroute.url = 'http://127.0.0.1:1';
    const t = await sync.trangThai();
    assert.equal(t.bat, true);
    assert.equal(t.ketNoi, false);
    assert.ok(t.loi, 'phải kèm lý do để người dùng biết sửa gì');
    cfg.config.omniroute.password = '';
  });
});

describe('importAgyBulk — chia lô theo trần 50 của OmniRoute', () => {
  test('gửi 120 entry ⇒ đúng 3 lượt gọi (50+50+20)', async () => {
    const { omniroute } = await import('../../src/omniroute/client.js');
    const goi: number[] = [];
    // Chặn tầng HTTP: chỉ quan tâm SỐ entry mỗi lượt, không cần server thật.
    const goc = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => {
      const b = JSON.parse(String(init?.body ?? '{}')) as { entries?: unknown[]; password?: string };
      if (b.entries) goi.push(b.entries.length);
      return new Response(JSON.stringify({ success: true, authenticated: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      cfg.config.omniroute.password = 'x';
      cfg.config.omniroute.url = 'http://127.0.0.1:20128';
      omniroute.reset();
      const entries = Array.from({ length: 120 }, (_, i) => ({ json: {}, email: `a${i}@t` }));
      await omniroute.importAgyBulk(entries);
      assert.deepEqual(goi, [50, 50, 20]);
    } finally {
      globalThis.fetch = goc;
      cfg.config.omniroute.password = '';
    }
  });
});

describe('dongBo — không chạy chồng', () => {
  /**
   * Vòng nền và nút bấm tay gọi `dongBo()` cùng lúc là chuyện thường. Hai lượt chồng nhau
   * thì cửa sổ đổi tên `agy`↔`antigravity` của lượt này rơi vào giữa lượt kia, `import-bulk`
   * không thấy hàng cũ nên tạo bản mới — đo thật: 20 email nở thành 25 rồi 40 hàng.
   */
  test('hai lời gọi song song dùng CHUNG một lượt', async () => {
    cfg.config.omniroute.password = 'x';
    cfg.config.omniroute.url = 'http://127.0.0.1:1';

    const [a, b] = await Promise.all([sync.dongBo(), sync.dongBo()]);
    assert.deepEqual(a, b, 'lượt sau phải nhận đúng kết quả của lượt đang chạy');

    cfg.config.omniroute.password = '';
  });

  test('gọi lại SAU khi xong thì chạy lượt mới', async () => {
    // Khoá phải nhả ra, nếu không lần đồng bộ kế tiếp không bao giờ chạy.
    cfg.config.omniroute.password = 'x';
    cfg.config.omniroute.url = 'http://127.0.0.1:1';

    const a = await sync.dongBo();
    const b = await sync.dongBo();
    assert.notEqual(a, b, 'phải là hai object khác nhau, không dùng lại kết quả cũ');

    cfg.config.omniroute.password = '';
  });
});

describe('gomHangKiro — đăng nhập lại không đẻ thêm connection', () => {
  /**
   * `kiroImportSchema` không nhận `name`/`email`, và OmniRoute để `null` với token social.
   * Hàng không tên thì chỉ còn `refreshToken` để nhận diện — mà token ĐỔI sau mỗi lần đăng
   * nhập lại, nên OmniRoute coi đó là account mới. Đo thật: đăng nhập lại một account,
   * connection Kiro nhảy 20 → 21.
   *
   * Test này khoá hành vi ở tầng mã: phải có bước gắn tên + xoá bản cũ cùng tên sau import.
   */
  test('sync.ts có bước gộp hàng trùng sau mỗi lần import Kiro', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../../src/omniroute/sync.ts'), 'utf8');
    const than = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    assert.match(than, /await omniroute\.importKiro\([\s\S]{0,80}?await gomHangKiro\(/,
      'gộp phải chạy NGAY sau import, không để hàng vô danh tồn tại');
    assert.match(than, /UPDATE provider_connections SET name/, 'phải đặt tên cho hàng mới');
    assert.match(than, /DELETE FROM provider_connections[\s\S]{0,200}name = \?/,
      'phải xoá bản cũ cùng tên, giữ hàng mới mang token còn hạn');
  });
});

describe('dongBo — tự nạp store khi chạy độc lập', () => {
  /**
   * `store.load()` không tự chạy lúc import: server gọi ở `index.ts`, script thì không.
   * Thiếu bước này `listCredentials()` trả rỗng và hàm báo "không có credential nào" dù
   * CSV có 694 dòng — đã bị đúng vậy khi chạy `dong-bo-server.sh` trên production.
   */
  test('sync.ts nạp store trước khi đọc credential', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../../src/omniroute/sync.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    // Mẫu đúng: `if (!store.listCredentials().length) store.load();` — kiểm rỗng rồi mới
    // nạp, để trong server (store đã có sẵn) không phải đọc đĩa thừa.
    assert.match(
      src,
      /if\s*\(!store\.listCredentials\(\)\.length\)\s*store\.load\(\)/,
      'phải nạp store khi rỗng, trước khi lọc credential',
    );
    /**
     * Và phải nằm trong `dongBoThat` TRƯỚC lời gọi `dongBoAgy()/dongBoKiro()`.
     *
     * So vị trí khai báo hàm là sai — `dongBoAgy` khai báo ở đầu file nhưng CHẠY sau.
     * Phải so với lời GỌI.
     */
    const than = src.slice(src.indexOf('async function dongBoThat'));
    const iNap = than.indexOf('store.load()');
    const iGoi = than.indexOf('await dongBoAgy()');
    assert.ok(iNap >= 0, 'nạp phải nằm trong dongBoThat');
    assert.ok(iNap < iGoi, 'nạp phải chạy trước khi gọi dongBoAgy()');
  });
});
