import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ConcurrencyLimiter } from '../../src/gateway/pool.js';

/**
 * `ConcurrencyLimiter` chặn số stream chạy song song (mặc định 6, `AGY_STREAM_CONCURRENCY`).
 * Class thuần, không mạng, không I/O — nhưng đang 0 test dù nằm trên đường nóng:
 * `engine.ts:483` acquire trước mỗi stream, `engine.ts:602` release ở `finally`.
 *
 * Hỏng thì hỏng theo hai kiểu, cả hai đều âm thầm:
 *  - release không đẩy hàng đợi → request kẹt VĨNH VIỄN, client treo tới timeout
 *  - đếm sai → vượt trần, mất tác dụng chống quá tải
 */

/** Chờ microtask lắng để biết chắc promise nào đã resolve. */
const settle = () => new Promise((r) => setImmediate(r));

describe('ConcurrencyLimiter', () => {
  test('dưới trần thì cấp slot ngay, không xếp hàng', async () => {
    const l = new ConcurrencyLimiter(2);
    const r1 = await l.acquire();
    const r2 = await l.acquire();
    assert.equal(typeof r1, 'function', 'acquire phải trả về hàm release');
    assert.equal(typeof r2, 'function');
    r1(); r2();
  });

  test('chạm trần thì request thứ N+1 phải CHỜ', async () => {
    const l = new ConcurrencyLimiter(1);
    const r1 = await l.acquire();

    let vao = false;
    const cho = l.acquire().then((rel) => { vao = true; return rel; });

    await settle();
    assert.equal(vao, false, 'trần 1 mà slot đang bận thì không được cấp thêm');

    r1();
    const r2 = await cho;
    assert.equal(vao, true, 'release xong phải đánh thức người đang chờ');
    r2();
  });

  test('release đẩy hàng đợi ĐÚNG THỨ TỰ vào trước ra trước', async () => {
    const l = new ConcurrencyLimiter(1);
    const r0 = await l.acquire();

    const thutu: number[] = [];
    const cho = [1, 2, 3].map((i) => l.acquire().then((rel) => { thutu.push(i); return rel; }));

    r0();
    // Mỗi release chỉ mở đúng MỘT slot: phải giải phóng tuần tự mới hết hàng đợi.
    for (const p of cho) (await p)();

    assert.deepEqual(thutu, [1, 2, 3], 'hàng đợi phải FIFO — đảo thứ tự là request đến trước bị đói');
  });

  test('không rò slot: acquire/release nhiều vòng vẫn nhận ngay', async () => {
    const l = new ConcurrencyLimiter(2);
    for (let i = 0; i < 50; i++) {
      const a = await l.acquire();
      const b = await l.acquire();
      a(); b();
    }
    // Nếu bộ đếm rò thì tới đây đã kẹt và test timeout.
    const cuoi = await l.acquire();
    assert.equal(typeof cuoi, 'function', 'sau 50 vòng vẫn phải cấp được slot');
    cuoi();
  });

  test('release gọi trước khi có ai chờ vẫn an toàn', async () => {
    const l = new ConcurrencyLimiter(1);
    const rel = await l.acquire();
    rel();
    // Gọi thừa: engine có finally, đường lỗi có thể release hai lần.
    assert.doesNotThrow(() => rel());
    const lai = await l.acquire();
    assert.equal(typeof lai, 'function', 'release thừa không được làm hỏng limiter');
    lai();
  });

  test('nhiều người chờ, mỗi release chỉ mở ĐÚNG một slot', async () => {
    const l = new ConcurrencyLimiter(1);
    const r0 = await l.acquire();

    let soVao = 0;
    const cho = [0, 1, 2].map(() => l.acquire().then((rel) => { soVao++; return rel; }));

    await settle();
    assert.equal(soVao, 0, 'trần đang bận thì chưa ai vào được');

    r0();
    await settle();
    assert.equal(soVao, 1, 'một release chỉ được mở một slot — mở nhiều là vượt trần');

    for (const p of cho) (await p)();
  });
});
