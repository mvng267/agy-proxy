import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Trang KHÔNG được dùng `fetch` trần để nạp dữ liệu, và KHÔNG được nuốt lỗi im lặng.
 *
 * `lib/api` lo hai việc mà `fetch` trần bỏ qua:
 *   1. **401 → quay về đăng nhập.** Phiên hết hạn ở trang dùng fetch trần thì trang chỉ
 *      im lặng, người dùng ngồi nhìn số cũ mà không biết mình đã đăng xuất.
 *   2. Ném lỗi có thông điệp thật, thay vì để mỗi chỗ tự `if (!res.ok) throw`.
 *
 * Kèm theo, `setInterval` vẫn chạy khi tab ẩn còn `refetchInterval` của React Query thì
 * dừng — 700 account × poll 30s trong tab nền là lãng phí thật.
 *
 * Ba trang Combo/Pool/Quota từng vi phạm cả hai; file này chốt lại để không tái diễn.
 */

const ROOT = resolve(import.meta.dirname, '../..');

/** Bỏ comment trước khi soi — lời giải thích cũng nhắc đúng những chuỗi này. */
function code(f: string): string {
  return readFileSync(resolve(ROOT, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const TRANG = [
  'web/src/components/pages/Combo.tsx',
  'web/src/components/pages/Pool.tsx',
  'web/src/components/pages/Quota.tsx',
];

/**
 * Component con tách ra từ ba trang trên.
 *
 * Chúng KHÔNG chịu luật "phải có useQuery + POLL" — `AutoDisablePanel` nạp cấu hình đúng
 * một lần lúc mở, không cần poll. Nhưng luật "đi qua lib/api" và "không nuốt lỗi im lặng"
 * thì vẫn phải giữ: tách file ra khỏi danh sách quét là cách để một trang lách rào mà
 * không ai nhận ra.
 */
const CON = [
  'web/src/components/pages/quota/AutoDisablePanel.tsx',
  'web/src/components/pages/quota/QuotaHistory.tsx',
];

describe('nạp dữ liệu qua React Query, không phải setInterval', () => {
  for (const f of TRANG) {
    const ten = f.split('/').pop()!;

    test(`${ten} dùng useQuery + POLL`, () => {
      const s = code(f);
      assert.match(s, /useQuery\(/, 'phải nạp bằng useQuery');
      assert.match(s, /refetchInterval: POLL\./, 'phải dùng POLL chung, không tự đặt số');
    });

    test(`${ten} KHÔNG còn setInterval để poll`, () => {
      // `setInterval` chạy tiếp cả khi tab ẩn — 700 account thì đó là lãng phí thật.
      assert.doesNotMatch(code(f), /setInterval\(/, 'còn poll bằng setInterval');
    });
  }
});

describe('lệnh ghi đi qua lib/api (để 401 được xử lý)', () => {
  for (const f of TRANG) {
    const ten = f.split('/').pop()!;

    test(`${ten} không còn fetch trần cho lệnh GHI`, () => {
      /**
       * `fetch(..., { method: 'POST' | 'PATCH' | 'DELETE' })` là lệnh ghi — chúng phải đi
       * qua `api` để phiên hết hạn được nhận ra.
       */
      const raw = readFileSync(resolve(ROOT, f), 'utf8').split('\n');
      raw.forEach((l, i) => {
        if (!/fetch\(.*method:\s*"(POST|PATCH|DELETE)"/.test(l)) return;
        const truoc = raw.slice(Math.max(0, i - 6), i).join('\n');
        assert.match(truoc, /CỐ Ý|cố ý/, `${ten}:${i + 1} fetch trần cho lệnh ghi mà không ghi lý do`);
      });
      assert.doesNotMatch(code(f), /method:\s*"PATCH"/, `${ten}: PATCH phải dùng api.patch`);
    });

    test(`${ten} có import api`, () => {
      assert.match(code(f), /from "@\/lib\/api"/);
    });
  }

  test('không trang nào còn fetch("/api/...") để NẠP dữ liệu', () => {
    // GET qua fetch trần là chỗ dễ quên nhất — nó "chạy được" nên không ai để ý.
    for (const f of [...TRANG, ...CON]) {
      const s = code(f);
      assert.doesNotMatch(s, /await fetch\("\/api\/[^"]*"\)/, `${f}: còn GET bằng fetch trần`);
    }
  });
});

describe('không nuốt lỗi im lặng', () => {
  for (const f of TRANG) {
    const ten = f.split('/').pop()!;

    test(`${ten} không còn catch {} rỗng ở lệnh ghi`, () => {
      /**
       * `catch {}` rỗng làm người dùng bấm Lưu / Xoá / Bật-tắt mà không thấy gì xảy ra và
       * không hiểu tại sao. Combo từng có BA chỗ như vậy.
       *
       * Ngoại lệ chấp nhận được: catch có nội dung giải thích (đã bị strip ở trên nên
       * biểu hiện là `catch { }` với khoảng trắng) — ta chỉ bắt dạng rỗng hoàn toàn kèm
       * toast/log thiếu.
       */
      /**
       * Bỏ COMMENT trước khi soi, nhưng GIỮ comment nằm trong thân catch.
       *
       * `catch { /* lý do *\/ }` là chấp nhận được — nó nói rõ vì sao bỏ qua. Chỉ
       * `catch {}` trống trơn mới là nuốt lỗi. Soi bản thô thì chính lời giải thích
       * "catch {} rỗng làm người dùng…" trong code cũng bị bắt nhầm.
       */
      const raw = readFileSync(resolve(ROOT, f), 'utf8')
        .replace(/^\s*\/\/.*$/gm, '');
      const rong = [...raw.matchAll(/catch\s*\{\s*\}/g)].length;
      assert.equal(rong, 0, `${ten}: còn ${rong} chỗ catch {} trống trơn`);
    });
  }

  test('toast lỗi kèm thông điệp thật, không chỉ tiêu đề chung', () => {
    /**
     * "Lỗi khi cập nhật" một mình không cho biết là mất mạng, hết phiên, hay backend từ
     * chối. Phải có `description` lấy từ chính lỗi.
     */
    const pool = code('web/src/components/pages/Pool.tsx');
    assert.match(pool, /catch \(e\)[\s\S]{0,200}description: String\(e instanceof Error/);
  });
});

describe('fetch trần được GIỮ có chủ đích — phải kèm lý do', () => {
  test('mỗi fetch trần còn lại đều có comment giải thích', () => {
    /**
     * Vài endpoint trả HTTP 200 kèm `{ok:false, error, steps}` — đó là DỮ LIỆU cần hiển
     * thị, không phải lỗi tầng mạng. `api` sẽ ném và mất chúng. Những chỗ đó giữ `fetch`
     * trần là ĐÚNG, nhưng phải ghi rõ để người sau không "dọn dẹp" nhầm.
     */
    for (const f of [...TRANG, ...CON]) {
      const raw = readFileSync(resolve(ROOT, f), 'utf8');
      const lines = raw.split('\n');
      lines.forEach((l, i) => {
        if (!/await fetch\(/.test(l)) return;
        // Nhìn ngược 6 dòng tìm comment giải thích.
        const truoc = lines.slice(Math.max(0, i - 6), i).join('\n');
        assert.match(
          truoc,
          /CỐ Ý|cố ý/,
          `${f}:${i + 1} giữ fetch trần mà không ghi lý do:\n    ${l.trim()}`,
        );
      });
    }
  });
});

describe('cập nhật lạc quan vẫn còn — không đợi vòng poll kế', () => {
  test('Pool và Quota dùng setQueryData để sửa cache ngay', () => {
    /**
     * Bấm "Kiểm tra" rồi đợi 30 giây mới thấy kết quả là trải nghiệm tệ. Bản cũ dùng
     * `setAccounts(prev => ...)` đúng vì lý do đó — chuyển sang React Query mà bỏ mất thì
     * giao diện chậm hẳn đi.
     */
    for (const f of ['web/src/components/pages/Pool.tsx', 'web/src/components/pages/Quota.tsx']) {
      assert.match(code(f), /qc\.setQueryData/, `${f}: mất cập nhật lạc quan`);
    }
  });
});
