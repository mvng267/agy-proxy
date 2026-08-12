import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { nousProvider, parseNousCredential, jwtExpiresAt, quotaFromHeaders } from '../../src/gateway/providers/nous.js';
import { PROVIDERS, PROVIDER_IDS, getProvider } from '../../src/gateway/providers/index.js';

/**
 * Provider Nous Research.
 *
 * Vì sao provider RIÊNG chứ không dùng `or` sẵn có: `openrouter.ts` khai `sessionFresh()`
 * luôn trả true vì giả định API key sống mãi. Nous phát JWT hết hạn sau 1 giờ (đo thật:
 * token trong ~/.hermes/auth.json còn 18 phút lúc kiểm) và có refresh_token. Dùng `or` thì
 * phải dán token thủ công mỗi giờ.
 *
 * Số liệu trong file này đo thật 11/08/2026 trên `tencent/hy3:free`.
 */

const ROOT = resolve(import.meta.dirname, '../..');

/** JWT giả — chỉ cần phần payload đúng, chữ ký không được kiểm ở phía client. */
function jwtGia(expSec: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64({ exp: expSec, scope: 'inference:invoke' })}.chuky`;
}

const cred = (o: Record<string, unknown>) => JSON.stringify(o);

describe('parseNousCredential', () => {
  test('nhận JSON có provider:nous', () => {
    assert.deepEqual(parseNousCredential(cred({ provider: 'nous', refreshToken: 'rt1' })), { refreshToken: 'rt1' });
  });

  test('nhận cả dạng cờ nous:true', () => {
    assert.deepEqual(parseNousCredential(cred({ nous: true, refreshToken: 'rt2' })), { refreshToken: 'rt2' });
  });

  test('TỪ CHỐI credential OpenRouter dạng JSON', () => {
    /**
     * Cả hai provider đều nhận credential JSON. Không có dấu hiệu riêng thì `accepts()` của
     * chúng tranh nhau và pool nạp account vào nhầm provider — gọi model là 401 hàng loạt.
     */
    assert.equal(parseNousCredential(cred({ apiKey: 'sk-or-v1-abc', baseUrl: 'https://x/v1' })), null);
    // Ca NGUY HIỂM: JSON mang CẢ HAI field. Không có kiểm tra `provider`/`nous` thì Nous
    // sẽ nhận luôn credential của OpenRouter — bỏ kiểm tra đó mà test vẫn xanh là test dối.
    assert.equal(
      parseNousCredential(cred({ apiKey: 'sk-or-v1-abc', baseUrl: 'https://x/v1', refreshToken: 'rt' })),
      null,
      'thiếu dấu hiệu provider:nous thì KHÔNG được nhận',
    );
  });

  test('từ chối key trần, chuỗi rỗng, JSON hỏng', () => {
    for (const v of ['sk-or-v1-abc', '', '   ', '{khong-phai-json', '1//refresh-token-google']) {
      assert.equal(parseNousCredential(v), null, `phải từ chối: ${v}`);
    }
  });

  test('thiếu refreshToken → null', () => {
    assert.equal(parseNousCredential(cred({ provider: 'nous' })), null);
  });
});

describe('jwtExpiresAt — hạn dùng đọc từ chính token', () => {
  test('đọc đúng claim exp (giây → ms)', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    assert.equal(jwtExpiresAt(jwtGia(exp)), exp * 1000);
  });

  test('token rác → 0 để BUỘC refresh ngay', () => {
    // Thà gọi refresh thừa còn hơn dùng token chết rồi cả pool báo 401.
    for (const v of ['', 'khong-phai-jwt', 'a.b', 'a.@@@.c']) {
      assert.equal(jwtExpiresAt(v), 0, `phải trả 0 với: ${v}`);
    }
  });

  test('payload không có exp → 0', () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    assert.equal(jwtExpiresAt(`${b64({})}.${b64({ scope: 'x' })}.k`), 0);
  });
});

describe('sessionFresh — làm mới TRƯỚC khi hết hạn', () => {
  const acc = (expMs: number) => ({
    provider: 'no' as const, email: 'a@t', key: 'no:a@t', refreshToken: 'rt',
    credential: cred({ provider: 'nous', refreshToken: 'rt' }), proxyLabel: '', health: 'alive',
    token: { accessToken: 'x', expiresAt: expMs },
  });

  test('còn 60 phút → tươi', () => {
    assert.equal(nousProvider.sessionFresh(acc(Date.now() + 60 * 60_000) as never, Date.now()), true);
  });

  test('còn 2 phút → KHÔNG tươi (biên an toàn 5 phút)', () => {
    /**
     * Request có thể chạy vài chục giây. Đợi tới lúc hết hạn mới làm mới thì token chết
     * giữa chừng — upstream trả 401 và pool đánh dấu account hỏng oan.
     */
    assert.equal(nousProvider.sessionFresh(acc(Date.now() + 2 * 60_000) as never, Date.now()), false);
  });

  test('đã hết hạn → không tươi', () => {
    assert.equal(nousProvider.sessionFresh(acc(Date.now() - 1000) as never, Date.now()), false);
  });

  test('chưa có token → không tươi', () => {
    const a = { ...acc(0), token: undefined };
    assert.equal(nousProvider.sessionFresh(a as never, Date.now()), false);
  });
});

describe('quotaFromHeaders — 4 bể từ header response', () => {
  /** Header thật đo được trên production 11/08/2026. */
  const THAT: Record<string, string> = {
    'x-ratelimit-limit-requests': '50',
    'x-ratelimit-remaining-requests': '49',
    'x-ratelimit-reset-requests': '59.999',
    'x-ratelimit-limit-requests-1h': '2100',
    'x-ratelimit-remaining-requests-1h': '2097',
    'x-ratelimit-limit-tokens': '500000',
    'x-ratelimit-remaining-tokens': '499943',
    'x-ratelimit-limit-tokens-1h': '6000000',
    'x-ratelimit-remaining-tokens-1h': '5999804',
  };

  test('bóc đủ 4 bể', () => {
    const q = quotaFromHeaders(THAT)!;
    assert.equal(q.groups.length, 4);
    assert.deepEqual(q.groups.map((g) => g.name), ['Request/phút', 'Request/giờ', 'Token/phút', 'Token/giờ']);
  });

  test('phần trăm tính đúng theo remaining/limit', () => {
    const q = quotaFromHeaders(THAT)!;
    assert.equal(q.groups[0]!.pct, 98, '49/50 = 98%');
    assert.equal(q.groups[1]!.pct, 100, '2097/2100 ≈ 100%');
  });

  test('desc giữ số thô để đối chiếu', () => {
    assert.equal(quotaFromHeaders(THAT)!.groups[0]!.desc, '49/50');
  });

  test('KHÔNG có header nào → undefined, KHÔNG bịa 0%', () => {
    /**
     * Model trả phí không gắn header này. Báo 0% sẽ khiến vòng auto-disable tắt oan
     * account đang khoẻ — đúng kiểu lỗi đã tắt nhầm 233 account Antigravity trước đây.
     */
    assert.equal(quotaFromHeaders({}), undefined);
    assert.equal(quotaFromHeaders({ 'content-type': 'application/json' }), undefined);
  });

  test('chỉ có MỘT bể → vẫn trả bể đó, không đòi đủ 4', () => {
    const q = quotaFromHeaders({ 'x-ratelimit-limit-requests': '50', 'x-ratelimit-remaining-requests': '10' })!;
    assert.equal(q.groups.length, 1);
    assert.equal(q.groups[0]!.pct, 20);
  });

  test('limit = 0 hoặc giá trị rác → bỏ qua bể đó, không chia cho 0', () => {
    assert.equal(quotaFromHeaders({ 'x-ratelimit-limit-requests': '0', 'x-ratelimit-remaining-requests': '0' }), undefined);
    assert.equal(quotaFromHeaders({ 'x-ratelimit-limit-requests': 'abc', 'x-ratelimit-remaining-requests': '1' }), undefined);
  });

  test('cạn sạch → 0%, không âm', () => {
    const q = quotaFromHeaders({ 'x-ratelimit-limit-requests': '50', 'x-ratelimit-remaining-requests': '0' })!;
    assert.equal(q.groups[0]!.pct, 0);
  });

  test('nhận cả Headers thật lẫn object thường', () => {
    const h = new Headers(THAT);
    assert.equal(quotaFromHeaders(h)!.groups.length, 4);
  });
});

describe('đăng ký provider', () => {
  test('có mặt trong PROVIDERS và PROVIDER_IDS', () => {
    assert.equal(PROVIDERS.no, nousProvider);
    assert.ok(PROVIDER_IDS.includes('no'));
  });

  test('alias `no` và `nous` cùng trỏ về nó', () => {
    assert.equal(getProvider('no'), nousProvider);
    assert.equal(getProvider('nous'), nousProvider);
    assert.equal(getProvider('NOUS'), nousProvider, 'không phân biệt hoa thường');
  });

  test('credentialTarget riêng, không đụng provider khác', () => {
    assert.equal(nousProvider.credentialTarget, 'nous');
    const targets = PROVIDER_IDS.map((id) => PROVIDERS[id].credentialTarget);
    assert.equal(new Set(targets).size, targets.length, 'hai provider trùng target là nạp nhầm account');
  });

  test('CHỈ khai model :free', () => {
    /**
     * Bản trả phí trả 404 "requires available credits" khi tài khoản chưa nạp tiền — chào
     * chúng ra là mời người dùng gọi vào lỗi.
     */
    for (const m of nousProvider.models) {
      assert.match(m.id, /:free$/, `model không free lọt vào danh sách: ${m.id}`);
    }
    assert.match(nousProvider.defaultModel, /:free$/);
  });
});

describe('không chép code — dùng chung openaiWire', () => {
  const doc = (f: string) => readFileSync(resolve(ROOT, f), 'utf8');

  test('cả openrouter lẫn nous đều import openaiWire', () => {
    /**
     * Hai upstream giống hệt nhau ở khâu gửi/nhận, chỉ khác auth. Chép lại 200 dòng parse
     * SSE cho mỗi provider mới là cách chắc chắn để hai bản lệch nhau dần.
     */
    assert.match(doc('src/gateway/providers/openrouter.ts'), /from '\.\/openaiWire\.js'/);
    assert.match(doc('src/gateway/providers/nous.ts'), /from '\.\/openaiWire\.js'/);
  });

  test('không còn bản sao của vòng parse SSE trong provider', () => {
    for (const f of ['src/gateway/providers/openrouter.ts', 'src/gateway/providers/nous.ts']) {
      assert.doesNotMatch(doc(f), /new TextDecoder\(\)/, `${f}: còn tự parse stream`);
    }
  });
});

describe('lỗi hết credit KHÔNG được coi là account chết', () => {
  test('404 "requires available credits" đổi thành 402', async () => {
    /**
     * Nhầm "chưa nạp tiền" với "model không tồn tại" là đánh dấu account chết oan — đúng
     * kiểu lỗi đã giết 331 account Kiro trước đây (403 kèm trang HTML bị coi là hỏng vĩnh
     * viễn). 402 để pool hiểu là hết hạn mức và cho cooldown thay vì loại bỏ.
     */
    const src = readFileSync(resolve(ROOT, 'src/gateway/providers/nous.ts'), 'utf8');
    assert.match(src, /requires available credits\|balance is too low/);
    assert.match(src, /status: 402/);
  });
});

describe('refresh token XOAY VÒNG — không lưu là account chết vĩnh viễn', () => {
  const SRC = readFileSync(resolve(ROOT, 'src/gateway/providers/nous.ts'), 'utf8');

  test('refreshNousToken trả về refresh_token mới', () => {
    /**
     * Nous vô hiệu token cũ ngay khi cấp token mới. Bỏ qua `refresh_token` trong response
     * thì lần refresh sau Portal trả:
     *   invalid_grant: Refresh token reuse detected; please re-authenticate
     * Đã gặp THẬT trên production khi nạp token copy từ hermes — hermes đã dùng nó và giữ
     * bản xoay vòng, nên bản tôi copy chết ngay lần gọi đầu.
     */
    assert.match(SRC, /refreshToken: j\.refresh_token/);
  });

  test('ensureReady lưu token mới vào CẢ credential, không chỉ RAM', () => {
    // Chỉ giữ trong RAM thì restart là mất, mà token cũ đã bị Portal vô hiệu.
    assert.match(SRC, /a\.refreshToken = r\.refreshToken/);
    assert.match(SRC, /a\.credential = JSON\.stringify\(\{ provider: 'nous', refreshToken/);
  });

  test('chỉ ghi khi token THỰC SỰ đổi', () => {
    // Ghi mỗi lần refresh là 700 lượt ghi CSV vô ích mỗi giờ.
    assert.match(SRC, /r\.refreshToken !== a\.refreshToken/);
  });

  test('dùng HOOK, không import store (quy tắc chống vòng lặp module)', () => {
    /**
     * Hook nay là CHUNG (`luuTokenXoay` trong `providers/types.ts`), không còn mang tên
     * Nous — vì Kiro cũng nhận `refreshToken` mới từ endpoint refresh mà trước đây vứt đi.
     * Xem `test/gateway/rotatehook.test.ts`.
     */
    assert.match(SRC, /luuTokenXoay\(/, 'phải báo lên qua hook chung');
    assert.doesNotMatch(SRC, /from '\.\.\/\.\.\/store\//, 'providers/ không được import store');
  });

  test('pool cắm hook để ghi xuống CSV', () => {
    const pool = readFileSync(resolve(ROOT, 'src/gateway/pool.ts'), 'utf8');
    assert.match(pool, /setRotateHook\(/);
    assert.match(pool, /store\.upsertCredential/);
  });
});
