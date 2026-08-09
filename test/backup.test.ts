/**
 * Test backup/restore.
 *
 * CÔ LẬP DỮ LIỆU — bắt buộc, không phải cho gọn.
 *
 * `restoreBackup` GHI THẬT xuống `DATA_DIR`: accounts.csv, proxies.csv, credentials.csv,
 * gateway.json, state.db. Bản trước của file này không cô lập gì cả, nên chạy `npm test`
 * là ghi đè thẳng vào `~/.agyproxy/data/` — nơi giữ 700 credential thật. Nó "an toàn" chỉ
 * vì restore chính snapshot vừa dựng nên nội dung trùng nhau; một test hỏng giữa chừng,
 * một lần đổi thứ tự, hay `mode:'replace'` với dữ liệu thiếu là mất sạch.
 *
 * `paths.ts` đọc `AGY_HOME` ở THỜI ĐIỂM IMPORT, nên biến môi trường phải đặt xong TRƯỚC
 * khi bất cứ module nào của src/ được nạp → dùng `await import()` động, không `import` tĩnh.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const TMP = mkdtempSync(resolve(tmpdir(), 'agy-backup-test-'));
process.env.AGY_HOME = TMP;

// Dữ liệu mồi: có ít nhất một dòng thật thì các assert về counts mới có nghĩa,
// và restore mode 'replace' mới thực sự bị thử thách.
mkdirSync(resolve(TMP, 'data'), { recursive: true });
writeFileSync(
  resolve(TMP, 'data', 'credentials.csv'),
  'email,password\nt1@example.com,pw1\nt2@example.com,pw2\n',
);
writeFileSync(resolve(TMP, 'data', 'accounts.csv'), 'email,password\nt1@example.com,pw1\n');

const { store } = await import('../src/store/index.js');
const { buildBackup, restoreBackup } = await import('../src/backup.js');
const { DATA_DIR } = await import('../src/paths.js');
const { recordGatewayUsage } = await import('../src/store/db.js');

// Nếu dòng này đỏ thì mọi test dưới đang chạy trên dữ liệu thật — dừng ngay.
assert.ok(
  DATA_DIR.startsWith(TMP),
  `CÔ LẬP HỎNG: DATA_DIR=${DATA_DIR} nằm ngoài thư mục tạm ${TMP} → test sẽ ghi vào dữ liệu thật`,
);

store.load();

after(() => rmSync(TMP, { recursive: true, force: true }));

test('buildBackup: shape đầy đủ', () => {
  const b = buildBackup();
  assert.equal(b.version, 3);
  assert.ok(b.settings && typeof b.settings === 'object', 'v2 phải kèm settings');
  assert.ok(b.exportedAt);
  assert.ok(Array.isArray(b.accounts) && Array.isArray(b.proxies) && Array.isArray(b.credentials));
  assert.equal(b.counts.accounts, b.accounts.length);
  assert.equal(b.counts.proxies, b.proxies.length);
  assert.equal(b.counts.credentials, b.credentials.length);
  assert.ok(b.gateway && typeof b.gateway === 'object');
  assert.ok(b.config && b.config.gateway && b.config.pacing);
});

test('restoreBackup: identity (replace) giữ nguyên counts (không mất data)', () => {
  const before = buildBackup(); // snapshot hiện tại
  const r = restoreBackup(before, { mode: 'replace' }); // phục hồi chính nó = no-op an toàn
  assert.equal(r.restored.accounts, before.accounts.length);
  assert.equal(r.restored.proxies, before.proxies.length);
  assert.equal(r.restored.credentials, before.credentials.length);
  const after = buildBackup();
  assert.equal(after.counts.accounts, before.counts.accounts);
  assert.equal(after.counts.proxies, before.counts.proxies);
  assert.equal(after.counts.credentials, before.counts.credentials);
});

test('backup KHÔNG mang sessionSecret (lộ = giả được cookie phiên dashboard)', () => {
  const b = buildBackup();
  assert.ok(!('sessionSecret' in (b.settings ?? {})), 'sessionSecret phải bị loại khỏi export');
});

test('restoreBackup: từ chối file không hợp lệ', () => {
  assert.throws(() => restoreBackup({ version: 99 }));
  assert.throws(() => restoreBackup(null));
  assert.throws(() => restoreBackup({ accounts: [] })); // thiếu version
});

test('backup v2 kèm ĐỦ trạng thái: quota + liveStatus + cooldown + combo', () => {
  const b = buildBackup();
  assert.ok(Array.isArray(b.combos), 'phải có khối combos');
  const gw = Object.values(b.gateway ?? {}) as any[];
  if (gw.length) {
    // toPersist phải mang theo trạng thái đã đồng bộ, không chỉ counter
    const keys = new Set(gw.flatMap((x) => Object.keys(x)));
    for (const k of ['enabled', 'requests', 'quota', 'liveStatus', 'cooldownUntil', 'projectId']) {
      assert.ok(keys.has(k), `gateway state thiếu "${k}" → khôi phục sẽ mất trạng thái`);
    }
    // khoá phải là dạng ghép provider:email
    assert.ok(Object.keys(b.gateway).every((k) => k.includes(':')), 'khoá gateway phải là provider:email');
  }
});

test('restoreBackup: combo được khôi phục', () => {
  const b = buildBackup();
  const fake = { ...b, combos: [{ id: '__t_combo', name: 'T', strategy: 'priority', targets: [{ model: 'agy/gemini-2.5-flash' }], enabled: true }] };
  restoreBackup(fake, { mode: 'merge' });
  const after = buildBackup();
  assert.ok(after.combos!.some((c) => c.id === '__t_combo'), 'combo phải có sau khi khôi phục');
});

describe('backup v3 — chuyển toàn bộ hệ thống giữa server', () => {
  test('mặc định KHÔNG kèm lịch sử nhưng LUÔN có api_keys', () => {
    const b = buildBackup();
    assert.equal(b.version, 3);
    // api_keys lưu dạng hash → mất là phải phát lại key cho từng người dùng.
    assert.ok(b.tables, 'v3 phải có trường tables');
    assert.ok(!('quota_history' in (b.tables ?? {})), 'lịch sử không được vào backup mặc định');
    assert.ok(!('gateway_usage' in (b.tables ?? {})), 'lịch sử không được vào backup mặc định');
  });

  test('history:true mới kèm bảng lịch sử', () => {
    // Phải seed: DB tạm rỗng thì "không có bảng lịch sử" là đúng, và test sẽ đỏ vì
    // không có gì để xuất chứ không phải vì tuỳ chọn hỏng. Đây là điều kiện tiên quyết
    // của phép thử, không phải chi tiết phụ.
    recordGatewayUsage({
      ts: Date.now(), email: 't1@example.com', model: 'agy/x',
      promptTokens: 1, completionTokens: 1, ok: true, ms: 10,
    });

    const t = buildBackup({ history: true }).tables ?? {};
    // quota_history một mình chiếm ~71% dung lượng file, nên phải là lựa chọn.
    assert.ok('gateway_usage' in t, 'history:true phải kèm bảng lịch sử đã có dữ liệu');
    assert.ok(!('gateway_usage' in (buildBackup().tables ?? {})), 'mặc định vẫn không kèm');
  });

  test('backup kèm lịch sử NẶNG hơn hẳn — lý do tách tuỳ chọn', () => {
    const light = JSON.stringify(buildBackup()).length;
    const full = JSON.stringify(buildBackup({ history: true })).length;
    assert.ok(full >= light, 'bản đầy đủ không thể nhỏ hơn bản gọn');
  });

  test('restore chấp nhận cả v1/v2 (backup cũ) lẫn v3', () => {
    const b = buildBackup();
    for (const v of [1, 2, 3]) {
      assert.doesNotThrow(() => restoreBackup({ ...b, version: v }, { mode: 'merge' }), `v${v} phải nhận được`);
    }
    assert.throws(() => restoreBackup({ ...b, version: 99 }, { mode: 'merge' }), /không hợp lệ/);
  });

  test('bảng lạ trong file không làm hỏng restore', () => {
    // File từ bản tương lai có thể mang bảng mình chưa biết — phải bỏ qua êm.
    const b: any = buildBackup();
    b.tables = { ...(b.tables ?? {}), bang_khong_ton_tai: [{ x: 1 }] };
    assert.doesNotThrow(() => restoreBackup(b, { mode: 'merge' }));
  });
});
