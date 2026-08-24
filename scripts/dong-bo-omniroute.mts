/**
 * Đồng bộ credential agy-proxy → OmniRoute, chạy tay khi cần.
 *
 * Lõi nằm ở `src/omniroute/sync.ts` — dùng chung với vòng nền và
 * `POST /api/omniroute/sync`, nên chạy tay hay tự động đều đi cùng một đường.
 *
 * Trước đây có bốn script `*omniroute*` copy-paste cùng một `parseCsv()` và `dangNhap()`;
 * chúng đọc `process.env` lúc module load nên không nhận được cấu hình từ dashboard.
 *
 * Chạy:
 *   npx tsx scripts/dong-bo-omniroute.mts           # cả hai provider
 *   npx tsx scripts/dong-bo-omniroute.mts agy
 *   npx tsx scripts/dong-bo-omniroute.mts kiro
 */
import { dongBo, trangThai } from '../src/omniroute/sync.js';

const target = process.argv[2] as 'agy' | 'kiro' | undefined;
if (target && target !== 'agy' && target !== 'kiro') {
  console.error(`target không hợp lệ: ${target} (chỉ 'agy' hoặc 'kiro')`);
  process.exit(2);
}

const kq = await dongBo(target);

if (kq.boQua) {
  console.log(`Bỏ qua: ${kq.chiTiet}`);
  console.log('Đặt mật khẩu ở Cấu hình → OmniRoute (hoặc biến OMNIROUTE_PASSWORD).');
  process.exit(0);
}

for (const r of kq.ketQua) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.email.split('@')[0]} · ${r.target}${r.loi ? ` → ${r.loi}` : ''}`);
}
console.log(`\n${kq.chiTiet}`);

const t = await trangThai();
if (t.ketNoi) {
  const dong = Object.entries(t.omniroute).map(([k, v]) => `${k} ${v}`).join(' · ');
  console.log(`OmniRoute hiện có: ${dong || '(trống)'}`);
} else if (t.loi) {
  console.log(`Không đọc được trạng thái OmniRoute: ${t.loi}`);
}

if (!kq.ok) process.exitCode = 1;
