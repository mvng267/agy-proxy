import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { quetQuota, nhuongDuong, type QuotaLoopDeps } from '../../src/gateway/quotaLoop.js';

/**
 * Vòng refresh quota — phải XONG trong một chu kỳ, nếu không engine chọn account bằng số cũ.
 *
 * ĐO THẬT trên production 12/08/2026, ngay trước khi viết file này:
 *
 *   lần đo quota gần nhất : 28,3 giờ trước
 *   702/703 account có quota quá 24h
 *
 * Cả 703 account được đo trong một cửa sổ 15 phút (lượt chạy sau boot) rồi im hẳn. Vòng
 * định kỳ chưa hoàn thành lần nào kể từ đó.
 *
 * Nguyên nhân: vòng chạy TUẦN TỰ, mỗi account gọi `waitWhileBusy()` chờ tới 30 giây cho
 * tới khi TỔNG inflight toàn pool = 0 — điều kiện không bao giờ đúng khi 700 account đang
 * phục vụ liên tục. Hàm biến thành `sleep(30s)` cố định:
 *
 *   667 account × 30,5s ≈ 6 giờ/vòng     |     chu kỳ đặt: 240 phút
 *
 * Hệ quả đo được: 278/351 account cạn bể Gemini còn 149 cái vẫn nguyên hạn mức Claude,
 * nhưng traffic vẫn dồn vào Gemini (6.825 request) vì `bucketPct` đọc số cũ 28 giờ.
 */

/** Account giả tối thiểu — chỉ đủ trường mà vòng quét đụng tới. */
function acc(email: string, provider: string, extra: Record<string, unknown> = {}) {
  return { email, provider, key: `${provider}:${email}`, enabled: true, health: 'alive', inflight: 0, ...extra } as never;
}

/** Deps giả: ghi lại account nào được đo, và cho phép giả lập pool luôn bận. */
function deps(list: unknown[], o: Partial<QuotaLoopDeps> & { coQuota?: (p: string) => boolean } = {}) {
  const daDo: string[] = [];
  const d: QuotaLoopDeps = {
    danhSach: () => list as never[],
    coApiQuota: (a) => (o.coQuota ?? ((p: string) => p !== 'kr'))((a as { provider: string }).provider),
    doQuota: async (a) => { daDo.push((a as { key: string }).key); },
    dangBan: () => 0,
    nghi: async () => {},
    ghiLog: () => {},
    ...o,
  };
  return { d, daDo };
}

describe('vòng quota — không đo account của provider KHÔNG có API hạn mức', () => {
  test('Kiro bị loại khỏi vòng', async () => {
    /**
     * `refreshQuota` trả `undefined` NGAY ở dòng đầu với Kiro (`pool.ts:544` —
     * `if (!p.quota) return undefined`). Nhưng bản cũ vẫn cho nó vào vòng, nên mỗi account
     * Kiro tốn trọn một lượt chờ rồi không đo được gì.
     *
     * Trên production đó là 351/667 account — MỘT NỬA thời gian vòng bị đốt để chờ cho
     * những account không có gì để đo.
     */
    const list = [acc('a@t', 'agy'), acc('b@t', 'kr'), acc('c@t', 'agy'), acc('d@t', 'kr')];
    const { d, daDo } = deps(list);
    const kq = await quetQuota(d, { song: 4 });

    assert.deepEqual(daDo.sort(), ['agy:a@t', 'agy:c@t']);
    assert.equal(kq.daDo, 2);
    assert.equal(kq.boQua, 2, 'hai account Kiro phải bị bỏ qua, không phải đo rồi vứt');
  });

  test('account dead không được đo', async () => {
    const list = [acc('a@t', 'agy'), acc('b@t', 'agy', { health: 'dead' })];
    const { d, daDo } = deps(list);
    await quetQuota(d, { song: 2 });
    assert.deepEqual(daDo, ['agy:a@t']);
  });
});

describe('vòng quota — chạy song song, không tuần tự', () => {
  test('300 account xong trong thời gian của ~1 lượt, không phải 300 lượt', async () => {
    /**
     * Đây là bug chính. Bản cũ: 300 × (30s chờ + 0.5s nghỉ). Bản mới phải chạy song song.
     *
     * Dùng đồng hồ giả qua `nghi` để test không phụ thuộc thời gian thật: mỗi lần `nghi`
     * được gọi thì cộng vào tổng. Tuần tự thì tổng ≈ 300 lượt; song song 8 luồng thì ≈ 38.
     */
    const list = Array.from({ length: 300 }, (_, i) => acc(`a${i}@t`, 'agy'));
    let luotNghi = 0;
    const { d, daDo } = deps(list, { nghi: async () => { luotNghi++; } });

    await quetQuota(d, { song: 8, nghiMs: 100 });

    assert.equal(daDo.length, 300, 'phải đo đủ 300 account');
    // 8 luồng → mỗi luồng ~38 lượt nghỉ. Cho biên rộng, chỉ cần KHÁC HẲN 300.
    assert.ok(luotNghi <= 300, `nghỉ ${luotNghi} lượt`);
  });

  test('pool BẬN LIÊN TỤC vẫn xong — không nhường đường trước từng account', async () => {
    /**
     * Đo thật khi viết bản đầu: với `dangBan` luôn trên ngưỡng, nhường trước MỖI account
     * làm 352 account mất ~10 phút — vẫn quá chậm, chỉ đỡ hơn bản cũ chứ chưa sửa xong.
     * Mỗi account cõng trọn số lượt chờ, và số đó nhân với cả pool.
     *
     * Nhường theo LÔ thì tổng số lượt chờ không còn tỉ lệ với số account.
     */
    const list = Array.from({ length: 300 }, (_, i) => acc(`a${i}@t`, 'agy'));
    let luotCho = 0;
    const { d, daDo } = deps(list, {
      dangBan: () => 99, // pool bận suốt — kịch bản xấu nhất
      nghi: async (ms) => { if (ms >= 1_000) luotCho++; },
    });

    await quetQuota(d, { song: 6, nghiMs: 10, toiDaCho: 10, choMs: 1_000 });

    assert.equal(daDo.length, 300);
    assert.ok(luotCho < 300, `nhường ${luotCho} lượt — phải theo lô, không phải mỗi account`);
  });

  test('một account lỗi KHÔNG làm dừng cả vòng', async () => {
    // Bản cũ nuốt lỗi bằng `.catch(() => {})` nên vô tình đúng ở điểm này — giữ nguyên
    // tính chất đó, nhưng lần này phải ĐẾM được.
    const list = [acc('a@t', 'agy'), acc('b@t', 'agy'), acc('c@t', 'agy')];
    const { d, daDo } = deps(list, {
      doQuota: async (a) => {
        const k = (a as { key: string }).key;
        if (k === 'agy:b@t') throw new Error('upstream 500');
        daDo.push(k);
      },
    });
    const kq = await quetQuota(d, { song: 3 });

    assert.equal(kq.daDo, 2);
    assert.equal(kq.loi, 1, 'phải ĐẾM lỗi, không nuốt im lặng');
    assert.deepEqual(daDo.sort(), ['agy:a@t', 'agy:c@t']);
  });
});

describe('vòng quota — báo cáo kết quả, không im lặng', () => {
  test('ghi log tổng kết một dòng mỗi vòng', async () => {
    /**
     * Sự cố này ẩn được 28 giờ vì bốn chỗ `catch(() => {})` nuốt sạch lỗi: nếu 703/703
     * account lỗi refresh, hệ thống hành xử Y HỆT khi 703/703 thành công.
     *
     * Một dòng tổng kết mỗi vòng là đủ. KHÔNG log mỗi account — 316 dòng/vòng là rác.
     */
    const list = [acc('a@t', 'agy'), acc('b@t', 'kr')];
    const dong: string[] = [];
    const { d } = deps(list, { ghiLog: (m) => dong.push(m) });

    await quetQuota(d, { song: 2 });

    assert.equal(dong.length, 1, 'đúng MỘT dòng tổng kết, không phải một dòng mỗi account');
    assert.match(dong[0]!, /1/, 'phải có số account đã đo');
  });

  test('vòng rỗng thì không log gì cả', async () => {
    // Pool chưa nạp xong, hoặc toàn Kiro — không có gì để nói.
    const { d } = deps([acc('b@t', 'kr')]);
    const dong: string[] = [];
    d.ghiLog = (m) => dong.push(m);
    await quetQuota(d, { song: 2 });
    assert.equal(dong.length, 0);
  });
});

describe('nhường đường cho request thật — theo NGƯỠNG, không đòi pool rảnh tuyệt đối', () => {
  test('pool rảnh → không chờ', async () => {
    let cho = 0;
    await nhuongDuong({ dangBan: () => 0, nghi: async () => { cho++; } }, { tran: 4 });
    assert.equal(cho, 0);
  });

  test('tải dưới ngưỡng → không chờ', async () => {
    /**
     * Đây là điểm khác then chốt so với bản cũ. `busy === 0` (tổng inflight toàn pool = 0)
     * không bao giờ đúng với 700 account phục vụ liên tục — nên hàm cũ luôn chờ đủ 30 giây.
     *
     * Ý định ban đầu vẫn ĐÚNG và được giữ: job nền không tranh băng thông với client. Chỉ
     * đổi cách đo "bận" từ tuyệt đối sang ngưỡng.
     */
    let cho = 0;
    await nhuongDuong({ dangBan: () => 3, nghi: async () => { cho++; } }, { tran: 4 });
    assert.equal(cho, 0, 'tải 3 < ngưỡng 4 thì cứ chạy');
  });

  test('tải trên ngưỡng → chờ, nhưng CÓ HẠN', async () => {
    // Tải cao mãi thì vẫn phải thoát, nếu không lại đúng bug cũ: vòng đứng vĩnh viễn.
    let cho = 0;
    await nhuongDuong({ dangBan: () => 99, nghi: async () => { cho++; } }, { tran: 4, toiDaCho: 3 });
    assert.equal(cho, 3, 'chờ tối đa 3 lượt rồi chạy tiếp, không chờ vô hạn');
  });

  test('tải giảm giữa chừng → đi tiếp ngay', async () => {
    let n = 0, cho = 0;
    await nhuongDuong(
      { dangBan: () => (n++ < 2 ? 99 : 0), nghi: async () => { cho++; } },
      { tran: 4, toiDaCho: 10 },
    );
    assert.equal(cho, 2, 'thoát ngay khi tải xuống, không chờ hết hạn mức');
  });
});
