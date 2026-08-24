/**
 * Đặt lại mật khẩu dashboard + gỡ khoá "sai quá nhiều lần".
 *
 * Vì sao cần: mật khẩu lưu dạng scrypt hash trong `state.db` — không đọc ngược được. Quên
 * hoặc mất DB (ví dụ sau khi làm mới máy) thì chỉ còn cách đặt lại. Sai 5 lần là IP bị khoá
 * 15 phút, nên script gỡ luôn bộ đếm để khỏi phải chờ.
 *
 * Chạy TRÊN MÁY có dashboard:
 *   npx tsx scripts/dat-lai-mat-khau.mts 123456
 *   npx tsx scripts/dat-lai-mat-khau.mts 123456 --passcode   # bàn phím số 6 chữ số
 *
 * Rồi khởi động lại để nạp giá trị mới:
 *   node bin/agyproxy.mjs restart      (hoặc: systemctl --user restart agyproxy)
 */
import { hashPassword } from '../src/security.js';
import { db, setSetting } from '../src/store/db.js';

const mk = process.argv[2];
const passcode = process.argv.includes('--passcode');

if (!mk) {
  console.error('Thiếu mật khẩu.  Dùng: npx tsx scripts/dat-lai-mat-khau.mts <mật-khẩu> [--passcode]');
  process.exit(2);
}

/**
 * Bàn phím số trên trang đăng nhập khoá cứng 6 CHỮ SỐ và tự gửi khi đủ — mật khẩu ngắn hơn
 * hoặc có chữ sẽ không bao giờ gửi được qua đường đó. `passcodeMode` quyết định trang mở ở
 * ô chữ hay bàn phím số, nên phải khớp với dạng mật khẩu vừa đặt.
 */
if (passcode && !/^\d{6}$/.test(mk)) {
  console.error(`--passcode cần đúng 6 chữ số, nhận được "${mk}"`);
  process.exit(2);
}

setSetting('dashboardPassword', hashPassword(mk));
setSetting('passcodeMode', passcode ? '1' : '');

// Gỡ khoá: xoá mọi lần đăng nhập hỏng của MỌI IP (không chỉ IP hiện tại — người dùng có
// thể thử từ máy khác, và bảng này chỉ dùng để đếm khoá).
const n = db.prepare('DELETE FROM auth_log WHERE ok = 0').run();

console.log(`✓ Mật khẩu mới: ${mk}`);
console.log(`✓ Chế độ nhập : ${passcode ? 'bàn phím 6 số' : 'ô mật khẩu chữ'}`);
console.log(`✓ Gỡ khoá     : xoá ${n.changes} lần đăng nhập hỏng`);
console.log('\nKhởi động lại để nạp:  node bin/agyproxy.mjs restart');
