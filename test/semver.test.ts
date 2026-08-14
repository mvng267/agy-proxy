import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mucTangCua, mucTangGop, versionKeTiep } from '../src/lib/semver.js';

/**
 * Tính version từ commit — để không còn phải NHỚ bump.
 *
 * Đo ngày 12/08/2026: 8 commit liên tiếp đều giữ nguyên `2.18.1`, trong đó có bản vá vòng
 * quota tắc 28 giờ trên production. Nút Cập nhật so version nên báo "đã là bản mới nhất"
 * suốt cả tuần.
 */

describe('mucTangCua — đọc tiền tố Conventional Commit', () => {
  test('feat → minor', () => {
    assert.equal(mucTangCua('feat: thêm trang báo cáo'), 'minor');
    assert.equal(mucTangCua('feat(combo): chọn model bằng dropdown'), 'minor');
  });

  test('fix → patch', () => {
    assert.equal(mucTangCua('fix: pool mất trạng thái sau đồng bộ'), 'patch');
    assert.equal(mucTangCua('fix(quota): vòng làm mới tắc 28 giờ'), 'patch');
  });

  test('dấu ! hoặc BREAKING CHANGE → major', () => {
    assert.equal(mucTangCua('feat!: đổi định dạng credential'), 'major');
    assert.equal(mucTangCua('fix(api)!: bỏ /api/config'), 'major');
    assert.equal(mucTangCua('refactor: gom config\n\nBREAKING CHANGE: bỏ /api/config'), 'major');
  });

  test('refactor/test/chore/docs KHÔNG tăng', () => {
    /**
     * Chúng không đổi hành vi người dùng thấy. Tăng version cho mỗi lần dọn file là làm
     * số version mất nghĩa — 5 commit refactor liên tiếp thành 5 "bản mới" rỗng.
     */
    for (const s of [
      'refactor(pool): tách phần chấm điểm khỏi pool.ts',
      'test(routes): hỏi thẳng bảng định tuyến',
      'chore: dọn code chết',
      'docs: cập nhật README',
    ]) {
      assert.equal(mucTangCua(s), null, s);
    }
  });

  test('commit không theo quy ước → không tăng, không đoán', () => {
    assert.equal(mucTangCua('sửa linh tinh'), null);
    assert.equal(mucTangCua(''), null);
  });
});

describe('mucTangGop — lấy mức CAO NHẤT của cả loạt', () => {
  test('có feat lẫn fix → minor', () => {
    assert.equal(mucTangGop(['fix: a', 'feat: b', 'fix: c']), 'minor');
  });

  test('toàn fix → patch', () => {
    assert.equal(mucTangGop(['fix: a', 'chore: b', 'fix: c']), 'patch');
  });

  test('có một breaking giữa đám fix → major', () => {
    assert.equal(mucTangGop(['fix: a', 'feat!: b', 'fix: c']), 'major');
  });

  test('toàn refactor/chore → KHÔNG tăng', () => {
    // Đúng tình huống 8 commit vừa rồi: phần lớn là refactor.
    assert.equal(mucTangGop(['refactor: a', 'test: b', 'chore: c']), null);
  });

  test('danh sách rỗng → không tăng', () => {
    assert.equal(mucTangGop([]), null);
  });
});

describe('versionKeTiep', () => {
  test('patch tăng số cuối', () => {
    assert.equal(versionKeTiep('2.18.1', 'patch'), '2.18.2');
  });

  test('minor tăng giữa và ĐƯA patch về 0', () => {
    // Quên phần này là ra `2.19.1` — sai chuẩn semver và gây nhầm khi đối chiếu.
    assert.equal(versionKeTiep('2.18.1', 'minor'), '2.19.0');
  });

  test('major đưa cả minor lẫn patch về 0', () => {
    assert.equal(versionKeTiep('2.18.1', 'major'), '3.0.0');
  });

  test('không có gì đáng tăng → giữ nguyên', () => {
    assert.equal(versionKeTiep('2.18.1', null), '2.18.1');
  });

  test('tình huống thật của 8 commit ngày 12/08', () => {
    /**
     * Trong 8 commit đó có `fix(quota)` và `fix(livelog)`, còn lại là refactor/test/chore.
     * Đúng ra phải thành 2.18.2, nhưng thực tế vẫn nằm ở 2.18.1.
     */
    const that = [
      'fix(quota): vòng làm mới hạn mức tắc 28 giờ',
      'refactor(pool): tách phần chấm điểm khỏi pool.ts',
      'refactor(agy): tách phần convert khỏi antigravity.ts',
      'test(routes): bỏ phép dò hậu tố yếu',
      'refactor(quota): tách AutoDisablePanel + QuotaHistory',
    ];
    assert.equal(versionKeTiep('2.18.1', mucTangGop(that)), '2.18.2');
  });
});
