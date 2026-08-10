import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, geminiPct } from '../../src/gateway/pool.js';

/**
 * Tự TẮT account cạn hạn mức, tự BẬT LẠI khi Google reset.
 *
 * Vì sao cần: đo thật trên production — pool 351 account có 66 cái quota 0% nằm lẫn với
 * 203 cái còn 100%. Chiến lược xoay vẫn chọn phải chúng, mỗi lần tốn ~6 giây rồi 429.
 * Có request thử 20 account liên tiếp, mất hơn 2 phút rồi vẫn hỏng trong khi 203 account
 * đầy quota nằm không.
 */

const ROOT = resolve(import.meta.dirname, '../..');
const BG = readFileSync(resolve(ROOT, 'src/gateway/background.ts'), 'utf8');

/** Dựng account với % quota cho trước. */
function mk(p: Pool, email: string, pct: number, enabled = true) {
  p.upsert({ provider: 'agy', email, refreshToken: '1//x', credential: '1//x', proxyLabel: '', health: 'alive' });
  const a = p.get(email, 'agy')!;
  a.quota = { tier: 't', groups: [{ name: 'Gemini', pct }], models: [], fetchedAt: Date.now() } as any;
  a.enabled = enabled;
  return a;
}

/** Bản sao quyết định của vòng quét — để test ngưỡng mà không gọi mạng. */
function quyetDinh(a: { enabled: boolean }, pct: number | null, off: number, on: number): 'tat' | 'bat' | 'giu' {
  if (pct == null) return 'giu';
  if (a.enabled && pct <= off) return 'tat';
  if (!a.enabled && pct >= on) return 'bat';
  return 'giu';
}

describe('ngưỡng tắt/bật', () => {
  const off = 0, on = 20;

  test('quota cạn → tắt', () => {
    const p = new Pool();
    const a = mk(p, 'can@x', 0);
    assert.equal(quyetDinh(a, geminiPct(a), off, on), 'tat');
  });

  test('quota còn → giữ nguyên', () => {
    const p = new Pool();
    for (const pct of [1, 10, 50, 100]) {
      const a = mk(p, `a${pct}@x`, pct);
      assert.equal(quyetDinh(a, geminiPct(a), off, on), 'giu', `quota ${pct}% không được tắt`);
    }
  });

  test('account đã tắt, quota hồi ≥ ngưỡng → bật lại', () => {
    const p = new Pool();
    const a = mk(p, 'hoi@x', 100, false);
    assert.equal(quyetDinh(a, geminiPct(a), off, on), 'bat');
  });

  test('VÙNG ĐỆM: hồi chưa đủ ngưỡng thì vẫn tắt', () => {
    /**
     * Đây là lý do ngưỡng bật phải CAO hơn ngưỡng tắt. Nếu dùng chung một mốc, account
     * dao động quanh mốc đó sẽ bật/tắt liên tục mỗi ngày — và mỗi lần bật lại là một
     * đợt 429 mới cho tới khi bị tắt tiếp.
     */
    const p = new Pool();
    for (const pct of [1, 10, 19]) {
      const a = mk(p, `d${pct}@x`, pct, false);
      assert.equal(quyetDinh(a, geminiPct(a), off, on), 'giu', `quota ${pct}% chưa đủ để bật lại`);
    }
  });

  test('chưa đo được quota → KHÔNG đoán', () => {
    // `null` nghĩa là chưa fetch được, khác hẳn 0 (đã đo và cạn thật).
    const p = new Pool();
    const a = mk(p, 'chuabiet@x', 0);
    a.quota = undefined;
    assert.equal(geminiPct(a), null);
    assert.equal(quyetDinh(a, geminiPct(a), off, on), 'giu');
  });
});

describe('bẫy đã tránh', () => {
  test('account TẮT vẫn được refresh quota khi bật autoDisable', () => {
    /**
     * BẪY CHẾT NGƯỜI: vòng refresh quota vốn lọc `x.enabled`. Nếu giữ nguyên, account bị
     * job này tắt sẽ không bao giờ được refresh → quota đóng băng ở giá trị cũ → không
     * bao giờ đủ điều kiện bật lại. Tính năng "tự bật lại" sẽ chết âm thầm.
     */
    const i = BG.indexOf('config.gateway.autoDisable?.enabled');
    assert.ok(i > 0, 'vòng refresh phải xét autoDisable khi chọn account');
    const seg = BG.slice(i, i + 200);
    assert.match(seg, /health !== 'dead'/, 'khi bật autoDisable thì lọc theo health, KHÔNG lọc enabled');
  });

  test('account dead bị bỏ qua — quota không cứu được', () => {
    // 'dead' = 401/invalid_grant, hỏng vĩnh viễn. Bật lại chỉ tạo lỗi.
    assert.match(BG, /if \(a\.health === 'dead'\) \{ skipped\+\+; continue; \}/);
  });

  test('ngưỡng bật LUÔN cao hơn ngưỡng tắt, kể cả khi cấu hình sai', () => {
    // Người dùng đặt onAtPct = offAtPct = 0 thì phải tự nâng, không được tin mù quáng.
    assert.match(BG, /Math\.max\(off \+ 1, cfg\.onAtPct\)/);
  });

  test('hẹn giờ theo MỐC tuyệt đối, không phải setInterval 24h', () => {
    // setInterval trôi dần theo thời gian xử lý và nhảy lung tung sau khi máy ngủ/thức.
    const i = BG.indexOf('function startAutoDisableLoop');
    assert.ok(i > 0, 'thiếu hàm hẹn giờ');
    // Cắt tới hết hàm, rồi BỎ COMMENT trước khi soi — chính lời giải thích "không dùng
    // setInterval" cũng chứa chữ đó, nên soi cả comment là bắt nhầm văn bản của mình.
    const fn = BG.slice(i, BG.indexOf('\n}', i))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.match(fn, /next\.setHours/, 'phải tính mốc giờ cụ thể');
    assert.doesNotMatch(fn, /setInterval/, 'không dùng setInterval cho lịch hằng ngày');
  });
});
