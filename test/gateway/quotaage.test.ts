import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tuoiQuota } from '../../src/gateway/poolScore.js';

/**
 * Tuổi quota phải NHÌN THẤY ĐƯỢC — nếu không, vòng nền chết im lặng suốt nhiều ngày.
 *
 * Sự cố 12/08/2026 ẩn được 28 giờ vì không chỗ nào hiển thị quota được đo khi nào.
 * Dashboard hiện số quota rất đẹp, nhưng số đó cũ 28 giờ và không ai biết:
 *
 *   lần đo gần nhất : 28,3 giờ trước
 *   702/703 account : quota quá 24h
 *
 * Hậu quả không nằm ở màn hình mà ở chất lượng phục vụ — `bucketPct()` đọc đúng những con
 * số cũ đó để chọn account, nên tải dồn vào bể Gemini đã cạn (278/351 account) trong khi
 * 149 account còn nguyên hạn mức Claude nằm không.
 *
 * Cùng loại lỗi (vòng nền chết im lặng) đã xảy ra ở sự cố 331/351 account Kiro trước đó.
 */

const gio = (h: number) => Date.now() - h * 3600_000;

describe('tuoiQuota — đo độ tươi của dữ liệu quota', () => {
  test('không account nào có quota → null, không phải 0', () => {
    /**
     * 0 nghĩa là "vừa đo xong", null nghĩa là "chưa biết". Trả 0 ở đây sẽ hiện KPI xanh
     * trong khi thực tế chưa có dữ liệu nào.
     */
    const r = tuoiQuota([{}, {}]);
    assert.equal(r.moiNhatMin, null);
    assert.equal(r.cuNhatMin, null);
    assert.equal(r.coQuota, 0);
  });

  test('tính được tuổi mới nhất và cũ nhất theo phút', () => {
    const r = tuoiQuota([
      { quota: { fetchedAt: gio(1) } },
      { quota: { fetchedAt: gio(5) } },
      { quota: { fetchedAt: gio(3) } },
    ]);
    assert.equal(r.moiNhatMin, 60);
    assert.equal(r.cuNhatMin, 300);
    assert.equal(r.coQuota, 3);
  });

  test('bỏ qua account chưa có quota, không coi là cũ vô hạn', () => {
    // Account mới thêm chưa đo lần nào không được kéo "cũ nhất" lên trời.
    const r = tuoiQuota([{ quota: { fetchedAt: gio(2) } }, {}, {}]);
    assert.equal(r.cuNhatMin, 120);
    assert.equal(r.coQuota, 1);
    assert.equal(r.tong, 3);
  });

  test('trung vị chịu được vài giá trị lệch', () => {
    /**
     * Trung vị chứ không phải trung bình: một account vừa được refresh tay sẽ kéo trung
     * bình xuống và che mất việc 700 cái còn lại đều cũ.
     */
    const r = tuoiQuota([
      { quota: { fetchedAt: gio(28) } },
      { quota: { fetchedAt: gio(28) } },
      { quota: { fetchedAt: gio(28) } },
      { quota: { fetchedAt: gio(0) } },
    ]);
    assert.equal(r.trungViMin, 28 * 60);
  });

  test('tái hiện đúng số đo production 12/08/2026', () => {
    // 702 account cũ ~28h, 1 account không có quota.
    const list = Array.from({ length: 702 }, () => ({ quota: { fetchedAt: gio(28.3) } }));
    list.push({} as never);
    const r = tuoiQuota(list);
    assert.equal(r.coQuota, 702);
    assert.ok(r.trungViMin! > 24 * 60, 'phải phát hiện được quota quá 24 giờ');
  });
});

const ROOT = resolve(import.meta.dirname, '../..');
function code(f: string): string {
  return readFileSync(resolve(ROOT, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('tuổi quota được phơi ra API và hiển thị', () => {
  test('/api/overview trả quotaAge', () => {
    const s = code('src/routes.ts');
    assert.match(s, /tuoiQuota\(/, 'routes.ts phải tính tuổi quota');
    assert.match(s, /quotaAge/, 'payload phải có trường quotaAge');
  });

  test('dashboard hiển thị tuổi quota', () => {
    const s = code('web/src/components/Overview.tsx');
    assert.match(s, /quotaAge/, 'Overview phải đọc quotaAge');
    assert.match(s, /TuoiQuota/, 'phải có component hiện tuổi');
  });

  test('cảnh báo khi quota quá cũ, không chỉ hiện số', () => {
    /**
     * Hiện "28 giờ" mà không tô gì thì vẫn dễ lướt qua. Quá ngưỡng phải đổi màu — và dùng
     * token `warning`, không hard-code màu (luật số 1 của dashboard).
     */
    const s = code('web/src/components/Overview.tsx');
    assert.match(s, /text-warning/, 'phải tô cảnh báo bằng design token');
  });
});
