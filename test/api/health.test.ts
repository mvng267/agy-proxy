import { describe, it } from 'node:test';
import assert from 'node:assert';

const BASE = process.env.HEALTH_TEST_URL ?? 'http://localhost:7788';

/** Server có đang chạy không? Test này là INTEGRATION test — không tự dựng server. */
async function serverUp(): Promise<boolean> {
  try {
    await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

describe('GET /api/health', () => {
  it('should return ok status and providers array', async (t) => {
    // Bỏ qua thay vì fail khi không có server: trước đây test này đỏ ngẫu nhiên mỗi lần
    // chạy suite lúc server tắt (vd đang restart), làm cả suite trông như có bug thật.
    // Đặt HEALTH_TEST_URL để trỏ sang instance khác.
    if (!(await serverUp())) {
      t.skip(`Bỏ qua: không có server tại ${BASE} (integration test cần server chạy)`);
      return;
    }
    const res = await fetch(`${BASE}/api/health`);
    assert.strictEqual(res.ok, true, 'Response should be 2xx');

    const data = await res.json() as {
      status: string;
      uptime: number;
      version: string;
      accounts: number;
      poolSize: number;
      providers: Array<{
        id: string;
        total: number;
        ok: number;
        failed: number;
        needsHuman: number;
      }>;
    };

    assert.strictEqual(data.status, 'ok', 'status field should be "ok"');
    assert.ok(Array.isArray(data.providers), 'providers should be an array');
    assert.ok(typeof data.uptime === 'number', 'uptime should be a number');
    assert.ok(typeof data.accounts === 'number', 'accounts should be a number');
    assert.ok(typeof data.poolSize === 'number', 'poolSize should be a number');
  });
});
