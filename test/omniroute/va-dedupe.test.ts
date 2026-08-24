import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { xemTrangThai, apVa } from '../../src/omniroute/vaDedupe.js';

/**
 * Bản vá dedupe Kiro sống trong `dist/.build` của OmniRoute nên **mất mỗi lần
 * `npm update -g omniroute`**. Quên vá lại thì 400 account Kiro gộp thành 1 — và nó IM
 * LẶNG: API trả success cả 400 lần, dashboard xanh, gọi model vẫn ra kết quả.
 *
 * Test dựng chunk giả đúng hình dạng bản build thật để không phải cài OmniRoute.
 */

const TMP = mkdtempSync(resolve(tmpdir(), 'agy-va-'));
const CHUNKS = resolve(TMP, 'dist/.build/next/server/chunks');

// Bốn mẫu nơi gọi + thân hàm, trích từ bản build thật (v3.8.49).
const THAN = 'e.s(["findKiroConnectionByIdentity",0,function(e,n){let o=r(n.authType),a=o?e.filter(e=>r(e.authType)===o):e,s=t(n.profileArn);if(s){let e=a.find(e=>t(i(e).profileArn)===s);if(e)return e}return null}])';
const GOI_MAU = [
  'await x(a,o,{profileArn:g,clientId:u,email:n})',
  'await x(a,R,{profileArn:E,clientId:b.clientId,email:S})',
  'findKiroConnectionByIdentity)(m,{authType:"oauth",profileArn:l.profileArn,email:d})',
  'findKiroConnectionByIdentity)(i,{authType:"oauth",...r})',
];

before(() => {
  mkdirSync(CHUNKS, { recursive: true });
  // 4 chunk chứa thân hàm (bản build thật lặp lại y hệt ở 4 chunk), mỗi chunk kèm 1 nơi gọi.
  for (let i = 0; i < 4; i++) {
    writeFileSync(resolve(CHUNKS, `chunk-${i}.js`), `module.exports=[${THAN};${GOI_MAU[i]};`);
  }
  // Chunk không liên quan — không được đụng tới.
  writeFileSync(resolve(CHUNKS, 'khac.js'), 'module.exports=[1,2,3]');
});
after(() => rmSync(TMP, { recursive: true, force: true }));

describe('xemTrangThai — phát hiện vá đã mất', () => {
  test('chunk gốc ⇒ CHƯA áp', () => {
    const t = xemTrangThai(TMP);
    assert.equal(t.timThay, true);
    assert.equal(t.daAp, false, 'bản gốc không được coi là đã vá');
    assert.equal(t.than, 0);
  });

  test('đường dẫn sai ⇒ timThay=false, KHÔNG ném lỗi', () => {
    // Vòng nền gọi hàm này mỗi phút — ném lỗi ở đây là làm chết vòng.
    const t = xemTrangThai(resolve(TMP, 'khong-ton-tai'));
    assert.equal(t.timThay, false);
    assert.equal(t.daAp, false);
  });
});

describe('apVa — vá lại được sau khi update ghi đè', () => {
  test('vá đủ 4 chunk và đủ 4 nơi gọi', () => {
    const n = apVa(TMP);
    assert.equal(n, 4, 'đúng 4 chunk có mẫu; chunk `khac.js` không được sửa');

    const t = xemTrangThai(TMP);
    assert.equal(t.daAp, true);
    assert.ok(t.than >= 4, `thân hàm phải ≥4, được ${t.than}`);
    assert.ok(t.goi >= 4, `nơi gọi phải ≥4, được ${t.goi}`);
  });

  test('chunk không liên quan giữ nguyên', () => {
    assert.equal(readFileSync(resolve(CHUNKS, 'khac.js'), 'utf8'), 'module.exports=[1,2,3]');
  });

  test('vá lần hai không đổi gì — chạy lại được nhiều lần', () => {
    // Vòng nền có thể gọi nhiều lần; vá đè lên chính nó sẽ làm hỏng mã.
    const truoc = readFileSync(resolve(CHUNKS, 'chunk-0.js'), 'utf8');
    assert.equal(apVa(TMP), 0, 'đã vá rồi thì không sửa thêm');
    assert.equal(readFileSync(resolve(CHUNKS, 'chunk-0.js'), 'utf8'), truoc);
  });

  test('THIẾU nơi gọi ⇒ vẫn báo CHƯA áp, không báo xong nửa vời', () => {
    /**
     * Lỗi thật đã mắc: vá 2/4 nơi gọi, thân hàm có đủ nên tưởng xong, nhưng luồng import
     * vẫn sinh bản trùng (20 email → 21 hàng). Chỉ đếm thân hàm là không đủ.
     */
    const t2 = mkdtempSync(resolve(tmpdir(), 'agy-va2-'));
    const c2 = resolve(t2, 'dist/.build/next/server/chunks');
    mkdirSync(c2, { recursive: true });
    for (let i = 0; i < 4; i++) {
      // thân hàm ĐÃ vá, nhưng nơi gọi để nguyên
      writeFileSync(resolve(c2, `c${i}.js`), `x;_rt=t(n.refreshToken);y;${GOI_MAU[i]};`);
    }
    const t = xemTrangThai(t2);
    assert.equal(t.than, 4);
    assert.equal(t.goi, 0);
    assert.equal(t.daAp, false, 'thân hàm đủ mà nơi gọi thiếu vẫn là CHƯA áp');
    rmSync(t2, { recursive: true, force: true });
  });
});

describe('duongDanOmniroute — tìm thư mục cài', () => {
  test('trả null khi không thấy, KHÔNG ném lỗi', async () => {
    // Vòng nền gọi mỗi 10 phút. Máy không cài OmniRoute (hoặc OmniRoute ở máy khác) là
    // chuyện thường — phải bỏ qua êm chứ không làm chết vòng.
    const { duongDanOmniroute } = await import('../../src/omniroute/client.js');
    const kq = duongDanOmniroute();
    assert.ok(kq === null || typeof kq === 'string');
    if (kq) assert.ok(kq.includes('omniroute'), 'đường dẫn phải trỏ tới omniroute');
  });
});

describe('vòng tự vá đã nối vào background', () => {
  test('startOmnirouteVaLoop được gọi lúc khởi động', () => {
    const src = readFileSync(
      resolve(import.meta.dirname, '../../src/gateway/background.ts'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.match(src, /startOmnirouteVaLoop\(\)/, 'phải được gọi, không chỉ định nghĩa');
    assert.match(src, /void chay\(\)/, 'phải kiểm NGAY lúc khởi động — đó là lúc hay mất vá nhất');
  });
});
