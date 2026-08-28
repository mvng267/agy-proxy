/**
 * Đánh dấu tài khoản chết hẳn (đã xoá khỏi Google Workspace) là `needs_human`.
 *
 * Chạy:
 *   npx tsx scripts/danh-dau-tk-chet.mts 300-346          # đánh dấu
 *   npx tsx scripts/danh-dau-tk-chet.mts 300-346 --thu    # chỉ in, không ghi
 *   npx tsx scripts/danh-dau-tk-chet.mts 300-346 --go     # bỏ đánh dấu, về 'failed'
 */
import { store } from '../src/store/index.js';
import { danhDauChet, docKhoang, LY_DO_XOA } from '../src/store/danhDauChet.js';
import { FLOW_KEYS, statusField } from '../src/store/models.js';

const DOMAIN = 'luongthevinhhp.edu.vn';
const khoang = process.argv[2];
const thuThoi = process.argv.includes('--thu');
const go = process.argv.includes('--go');

if (!khoang) {
  console.error('Thiếu khoảng. Ví dụ: npx tsx scripts/danh-dau-tk-chet.mts 300-346');
  process.exit(2);
}

store.load();
const so = docKhoang(khoang);
let doi = 0, boQua = 0, khongCo = 0;

for (const n of so) {
  const email = `agyproxy${n}@${DOMAIN}`;
  const acc = store.getAccount(email);
  if (!acc) { khongCo++; continue; }

  if (go) {
    const moi = { ...acc, note: '' };
    let co = false;
    for (const f of FLOW_KEYS) {
      const k = statusField(f);
      if (moi[k] === 'needs_human') { (moi as unknown as Record<string, string>)[k] = 'failed'; co = true; }
    }
    if (!co) { boQua++; continue; }
    if (!thuThoi) store.upsertAccount(moi);
    console.log(`  ↩ ${email} → failed`);
    doi++;
    continue;
  }

  const moi = danhDauChet(acc, LY_DO_XOA);
  if (!moi) { boQua++; continue; }
  if (!thuThoi) store.upsertAccount(moi);
  console.log(`  ✗ ${email} → needs_human`);
  doi++;
}

console.log(
  `\n${thuThoi ? '[THỬ] ' : ''}Đổi ${doi}/${so.length}` +
  `${boQua ? ` · đã đúng ${boQua}` : ''}${khongCo ? ` · không có trong store ${khongCo}` : ''}`,
);
