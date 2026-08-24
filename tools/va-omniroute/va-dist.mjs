#!/usr/bin/env node
/**
 * Vá THẲNG vào bản build của OmniRoute (dist/.build) — chạy lại được nhiều lần.
 *
 * Vì sao không vá src rồi build: gói npm KHÔNG ship `app/`, `next.config`, và
 * `scripts/build/assembleStandalone.mjs`, nên `npm run build` chết ngay ở bước import.
 * Sửa `src/lib/oauth/kiroConnectionIdentity.ts` cũng vô ích vì runtime chạy từ dist.
 *
 * Vá hai chỗ:
 *   1) thân hàm findKiroConnectionByIdentity — thêm nhánh khớp refreshToken TRƯỚC profileArn
 *   2) hai nơi gọi — truyền refreshToken vào identity (trước đó chỉ có profileArn/clientId/email)
 *
 * Chạy:  node va-dist.mjs [đường/dẫn/tới/omniroute]
 * Gỡ:    node va-dist.mjs --go
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GOC = process.argv.includes('--go');
const XEM = process.argv.includes('--xem');
/**
 * Tham số vị trí đầu tiên không phải cờ = thư mục OmniRoute.
 *
 * Bản trước bắt bằng `argv.find(a => a.includes('omniroute'))` — đường dẫn của CHÍNH script
 * này cũng khớp, nên chạy từ thư mục khác thì nó tưởng mình là thư mục OmniRoute và báo
 * "không thấy .../va-dist.mjs/dist/.build/next/server/chunks".
 */
const TU_THAM_SO = process.argv.slice(2).find((a) => !a.startsWith('--'));
const ROOT = TU_THAM_SO ?? resolve(process.env.HOME ?? '', '.local/lib/node_modules/omniroute');
const CHUNKS = resolve(ROOT, 'dist/.build/next/server/chunks');
const SAO = resolve(dirname(fileURLToPath(import.meta.url)), 'dist-backup');

if (!existsSync(CHUNKS)) { console.error('không thấy', CHUNKS); process.exit(1); }
mkdirSync(SAO, { recursive: true });

const HAM_CU = `let o=r(n.authType),a=o?e.filter(e=>r(e.authType)===o):e,s=t(n.profileArn);if(s){`;
const HAM_MOI = `let o=r(n.authType),a=o?e.filter(e=>r(e.authType)===o):e,_rt=t(n.refreshToken);if(_rt){let e=a.find(e=>t(e.refreshToken)===_rt||t(i(e).refreshToken)===_rt);return e||null}let s=t(n.profileArn);if(s){`;
/**
 * BỐN nơi gọi — thiếu một là chỗ đó vẫn dedupe theo profileArn dùng chung và sinh bản trùng.
 * (Đã bị đúng vậy: vá 2 nơi đầu xong, luồng import vẫn đẻ ra hàng thứ 21.)
 */
const GOI = [
  [`await x(a,o,{profileArn:g,clientId:u,email:n})`,
   `await x(a,o,{refreshToken:o.refreshToken,profileArn:g,clientId:u,email:n})`],
  [`await x(a,R,{profileArn:E,clientId:b.clientId,email:S})`,
   `await x(a,R,{refreshToken:R.refreshToken,profileArn:E,clientId:b.clientId,email:S})`],
  // luồng social-exchange / device-code
  [`findKiroConnectionByIdentity)(m,{authType:"oauth",profileArn:l.profileArn,email:d})`,
   `findKiroConnectionByIdentity)(m,{authType:"oauth",refreshToken:g.refreshToken,profileArn:l.profileArn,email:d})`],
  // hàm chung x(e,t,r) — t là object connection
  [`findKiroConnectionByIdentity)(i,{authType:"oauth",...r})`,
   `findKiroConnectionByIdentity)(i,{authType:"oauth",refreshToken:t?.refreshToken,...r})`],
];

/**
 * `--xem`: bản vá còn áp không.
 *
 * Phải đếm CẢ thân hàm lẫn nơi gọi — lần vá đầu tôi chỉ vá 2/4 nơi gọi, thân hàm có mà
 * luồng import vẫn sinh bản trùng. Chỉ đếm một vế sẽ báo "ĐANG ÁP" cho một bản vá hỏng.
 */
if (XEM) {
  let than = 0, goi = 0;
  for (const f of readdirSync(CHUNKS)) {
    let s;
    try { s = readFileSync(resolve(CHUNKS, f), 'utf8'); } catch { continue; }
    if (s.includes('_rt=t(n.refreshToken)')) than++;
    for (const [, moi] of GOI) if (s.includes(moi)) goi++;
  }
  const ok = than >= 4 && goi >= 4;
  console.log(`  thân hàm : ${than} chunk`);
  console.log(`  nơi gọi  : ${goi} chỗ`);
  console.log(ok ? '  → ĐANG ÁP' : than || goi ? '  → ÁP THIẾU (vá lại: node va-dist.mjs)' : '  → CHƯA ÁP');
  process.exit(ok ? 0 : 1);
}

let n = 0;
for (const f of readdirSync(CHUNKS)) {
  const p = resolve(CHUNKS, f);
  let s;
  try { s = readFileSync(p, 'utf8'); } catch { continue; }

  if (GOC) {
    const bak = resolve(SAO, f);
    if (existsSync(bak)) { writeFileSync(p, readFileSync(bak, 'utf8')); console.log('  khôi phục', f); n++; }
    continue;
  }

  let moi = s;
  if (moi.includes(HAM_CU)) moi = moi.split(HAM_CU).join(HAM_MOI);
  for (const [cu, mm] of GOI) if (moi.includes(cu)) moi = moi.split(cu).join(mm);
  if (moi === s) continue;

  if (!existsSync(resolve(SAO, f))) writeFileSync(resolve(SAO, f), s);
  writeFileSync(p, moi);
  console.log('  vá', f);
  n++;
}
console.log(GOC ? `khôi phục ${n} chunk` : `đã vá ${n} chunk — khởi động lại OmniRoute để áp dụng`);
if (!n && !GOC) console.log('(0 chunk — có thể đã vá rồi, hoặc phiên bản OmniRoute đã đổi)');
