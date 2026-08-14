import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_KEYS, SECRET_KEYS, RESTART_KEYS, applyConfig, getConfigValue } from '../src/config.js';
import { CONFIG_FIELDS } from '../src/configMeta.js';

/**
 * Mỗi khoá cấu hình phải MÔ TẢ ĐƯỢC, để trang Settings tự sinh ra nó.
 *
 * Đo ngày 13/08/2026: chỉ 11/46 khoá chỉnh được từ dashboard. 35 khoá còn lại muốn đổi
 * phải SSH vào máy chủ ghi thẳng vào SQLite — kể cả `quotaIntervalMin`, thứ vừa phải đổi
 * để cứu vòng làm mới hạn mức đang tắc 28 giờ.
 *
 * Gốc rễ: thêm khoá mới phải sửa BA nơi (config.ts, admin.ts, Settings.tsx) và người ta
 * chỉ sửa hai. Test này chặn đúng chỗ đó.
 */

describe('mọi khoá cấu hình đều có mô tả', () => {
  test('không khoá nào trong CONFIG_KEYS bị bỏ quên', () => {
    const thieu = CONFIG_KEYS.filter((k) => !CONFIG_FIELDS[k]);
    assert.deepEqual(
      thieu,
      [],
      `${thieu.length} khoá thiếu mô tả trong configMeta.ts → chúng sẽ KHÔNG hiện trên trang Cấu hình`,
    );
  });

  test('không mô tả thừa cho khoá không tồn tại', () => {
    // Mô tả một khoá đã bị xoá khỏi SETTERS thì UI sinh ra ô không lưu được.
    const thua = Object.keys(CONFIG_FIELDS).filter((k) => !CONFIG_KEYS.includes(k));
    assert.deepEqual(thua, [], 'có mô tả cho khoá không nằm trong SETTERS');
  });

  test('nhãn phải bằng tiếng Việt và không rỗng', () => {
    for (const [k, f] of Object.entries(CONFIG_FIELDS)) {
      assert.ok(f.label.trim().length > 0, `${k} thiếu nhãn`);
      assert.ok(f.group.trim().length > 0, `${k} thiếu nhóm`);
    }
  });

  test('khoá secret phải khai type password', () => {
    // Nếu không, mật khẩu dashboard hiện nguyên văn trên màn hình.
    for (const k of SECRET_KEYS) {
      assert.equal(CONFIG_FIELDS[k]?.type, 'password', `${k} là secret nhưng không khai password`);
    }
  });

  test('kiểu int phải có min và max', () => {
    /**
     * Thiếu ràng buộc là nhận bất kỳ số nào: `quotaIntervalMin = 0` làm vòng nền quay
     * liên tục, `port = 99999` thì server không khởi động nổi.
     */
    for (const [k, f] of Object.entries(CONFIG_FIELDS)) {
      if (f.type !== 'int') continue;
      assert.equal(typeof f.min, 'number', `${k} thiếu min`);
      assert.equal(typeof f.max, 'number', `${k} thiếu max`);
      assert.ok(f.min! < f.max!, `${k} có min >= max`);
    }
  });

  test('kiểu enum phải liệt kê giá trị', () => {
    for (const [k, f] of Object.entries(CONFIG_FIELDS)) {
      if (f.type !== 'enum') continue;
      assert.ok(f.values?.length, `${k} là enum nhưng không có danh sách giá trị`);
    }
  });
});

describe('SPECS sinh TỪ mô tả — nhãn và luật kiểm không thể lệch nhau', () => {
  test('ràng buộc int được áp dụng thật', () => {
    // `quotaIntervalMin` khai min 1 max 1440 → 0 và 99999 phải bị từ chối.
    const a = applyConfig({ quotaIntervalMin: 0 });
    assert.ok(a.rejected.length, 'giá trị 0 phải bị từ chối');
    const b = applyConfig({ quotaIntervalMin: 99_999 });
    assert.ok(b.rejected.length, 'vượt max phải bị từ chối');
  });

  test('ràng buộc enum được áp dụng thật', () => {
    /**
     * Bản trước nhận BẤT KỲ chuỗi nào rồi `pool.pick()` rơi vào nhánh `default` IM LẶNG —
     * người dùng tưởng đã đổi chiến lược.
     */
    const r = applyConfig({ gatewayRotation: 'khong-ton-tai' });
    assert.ok(r.rejected.length, 'chiến lược lạ phải bị từ chối');
    assert.match(r.rejected[0]!.reason, /round-robin|smart/, 'lý do phải liệt kê giá trị hợp lệ');
  });

  test('giá trị hợp lệ vẫn đi qua', () => {
    const cu = getConfigValue('quotaIntervalMin');
    const r = applyConfig({ quotaIntervalMin: 45 });
    assert.deepEqual(r.rejected, []);
    assert.ok(r.changed.includes('quotaIntervalMin'));
    applyConfig({ quotaIntervalMin: cu }); // trả lại
  });
});

describe('RESTART_KEYS được đánh dấu để UI cảnh báo', () => {
  test('mọi khoá cần khởi động lại đều có mô tả', () => {
    for (const k of RESTART_KEYS) {
      assert.ok(CONFIG_FIELDS[k], `${k} cần khởi động lại nhưng không có mô tả → UI không cảnh báo được`);
    }
  });
});
