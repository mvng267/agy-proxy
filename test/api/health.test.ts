import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('GET /api/health', () => {
  it('should return ok status and providers array', async () => {
    // Giả định server đã chạy trên localhost:7788 (hoặc config khác)
    // Test này là integration test — cần server thật chạy trước khi run
    const res = await fetch('http://localhost:7788/api/health');
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
