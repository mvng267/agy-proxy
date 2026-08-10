import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isPermanentAuthError, Pool } from '../../src/gateway/pool.js';

/**
 * 403 kèm TRANG HTML không phải token bị thu hồi.
 *
 * Sự cố thật trên production: 331/351 account Kiro bị đánh `health='dead'`, khiến provider
 * chỉ còn 14/351 account khả dụng. Nhưng 313 trong số đó vẫn có `liveStatus='ok'` — mâu
 * thuẫn hiển nhiên. Gọi thử `thehien120` thì nó trả lời trong 1 giây, cả checklive lẫn
 * gọi model thật.
 *
 * Nguyên nhân: `isPermanentAuthError` coi MỌI 403 là chết vĩnh viễn. Nhưng lỗi thật gặp
 * là `Kiro refresh 403: <!DOCTYPE HTML PUBLIC…` — trang HTML nghĩa là bị chặn ở tầng
 * mạng (WAF/CDN/rate-limit biên), request chưa tới được API. API thật luôn trả JSON.
 *
 * Cái giá của hai loại nhầm lẫn KHÔNG đối xứng:
 *   coi nhầm account chết là còn sống → tốn thêm một lượt thử
 *   coi nhầm account sống là chết     → mất khỏi pool VĨNH VIỄN (chỉ người gỡ được)
 * Nên khi không chắc, phải nghiêng về "còn sống".
 */

describe('403 HTML = bị chặn tạm, KHÔNG phải token hỏng', () => {
  test('403 kèm <!DOCTYPE html> → không đánh dead', () => {
    // Đây là chuỗi lỗi THẬT lấy từ production.
    const msg = 'Kiro refresh 403: <!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">';
    assert.equal(isPermanentAuthError(msg, 403), false, 'account sống bị giết oan');
  });

  test('403 kèm <html> → không đánh dead', () => {
    assert.equal(isPermanentAuthError('403: <html><body>Access Denied</body></html>', 403), false);
  });

  test('403 JSON thường VẪN đánh dead — đó là từ chối thật từ API', () => {
    assert.equal(isPermanentAuthError('{"error":"forbidden"}', 403), true);
  });

  test('401 vẫn đánh dead dù có HTML hay không', () => {
    // 401 là "chưa xác thực" — rõ ràng hơn 403, và không phải mã mà WAF hay trả.
    assert.equal(isPermanentAuthError('unauthorized', 401), true);
    assert.equal(isPermanentAuthError('<html>401</html>', 401), true);
  });

  test('token thu hồi thật vẫn đánh dead theo THÔNG ĐIỆP, không cần status', () => {
    for (const m of ['invalid_grant', 'token has been expired or revoked', 'unauthorized_client']) {
      assert.equal(isPermanentAuthError(m, undefined), true, `"${m}" phải là chết vĩnh viễn`);
    }
  });

  test('lỗi hạ tầng không bao giờ đánh dead', () => {
    for (const [m, s] of [['fetch failed', undefined], ['timeout', undefined], ['HTTP 500', 500]] as const) {
      assert.equal(isPermanentAuthError(m, s), false);
    }
  });
});

describe('pool.report không giết account vì 403 HTML', () => {
  const mk = () => {
    const p = new Pool();
    p.upsert({ provider: 'kr', email: 'k@x', refreshToken: 't', credential: 't', proxyLabel: '', health: 'alive' });
    return { p, a: p.get('k@x', 'kr')! };
  };

  test('403 HTML → giữ nguyên health, chỉ ghi nhận lỗi', () => {
    const { p, a } = mk();
    p.report(a, { ok: false, status: 403, err: 'Kiro refresh 403: <!DOCTYPE HTML PUBLIC' });
    assert.notEqual(a.health, 'dead', 'đây chính là bug đã giết 331 account');
  });

  test('403 JSON → vẫn đánh dead', () => {
    const { p, a } = mk();
    p.report(a, { ok: false, status: 403, err: '{"message":"forbidden"}' });
    assert.equal(a.health, 'dead');
  });
});
