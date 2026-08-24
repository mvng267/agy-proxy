/**
 * Bản vá dedupe Kiro cho OmniRoute — mẫu tìm/thay và hàm kiểm/áp.
 *
 * Vì sao cần vá: Kiro free-tier cấp **chung một `profileArn`** cho mọi tài khoản Google
 * (đo 20/20 account đều ra `profile/EHGA3GRVQMUK`). OmniRoute dùng ARN đó để phân biệt
 * account, nên nó coi N account là MỘT và ghi đè lẫn nhau còn 1 hàng.
 *
 * Nguy hiểm hơn cả là **nó im lặng**: API trả `{"success":true}` cả N lần, dashboard hiện
 * xanh, gọi model vẫn ra kết quả. Chỉ khi đếm connection mới thấy 1 thay vì 400.
 *
 * Vá sống trong `dist/.build` (Next.js đã build) nên **mất mỗi lần `npm update -g omniroute`**
 * — gói npm không ship `app/` lẫn `next.config` nên không build lại từ nguồn được.
 * Module này để agy-proxy tự phát hiện và vá lại, khỏi phải nhớ.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Thân hàm `findKiroConnectionByIdentity`: chèn nhánh khớp refreshToken TRƯỚC profileArn. */
const HAM_CU =
  'let o=r(n.authType),a=o?e.filter(e=>r(e.authType)===o):e,s=t(n.profileArn);if(s){';
const HAM_MOI =
  'let o=r(n.authType),a=o?e.filter(e=>r(e.authType)===o):e,_rt=t(n.refreshToken);' +
  'if(_rt){let e=a.find(e=>t(e.refreshToken)===_rt||t(i(e).refreshToken)===_rt);' +
  'if(e)return e;let _em=r(n.email);if(_em){let x=a.find(e=>r(e.email)===_em);if(x)return x}' +
  'let _nm=r(n.name);if(_nm){let x=a.find(e=>r(e.name)===_nm);if(x)return x}return null}' +
  'let s=t(n.profileArn);if(s){';

/** Dấu nhận biết thân hàm đã vá. */
const DAU_THAN = '_rt=t(n.refreshToken)';

/**
 * BỐN nơi gọi — thiếu một là chỗ đó vẫn dedupe theo ARN dùng chung và sinh bản trùng.
 * Đã bị đúng vậy: vá 2 nơi đầu xong, luồng import vẫn đẻ ra hàng thứ 21.
 */
const GOI: Array<[string, string]> = [
  ['await x(a,o,{profileArn:g,clientId:u,email:n})',
   'await x(a,o,{refreshToken:o.refreshToken,profileArn:g,clientId:u,email:n})'],
  ['await x(a,R,{profileArn:E,clientId:b.clientId,email:S})',
   'await x(a,R,{refreshToken:R.refreshToken,profileArn:E,clientId:b.clientId,email:S})'],
  // luồng social-exchange / device-code
  ['findKiroConnectionByIdentity)(m,{authType:"oauth",profileArn:l.profileArn,email:d})',
   'findKiroConnectionByIdentity)(m,{authType:"oauth",refreshToken:g.refreshToken,profileArn:l.profileArn,email:d})'],
  // hàm chung x(e,t,r) — t là object connection
  ['findKiroConnectionByIdentity)(i,{authType:"oauth",...r})',
   'findKiroConnectionByIdentity)(i,{authType:"oauth",refreshToken:t?.refreshToken,...r})'],
];

const NGUONG_THAN = 4;
const NGUONG_GOI = 4;

export interface TrangThaiVa {
  /** Thư mục chunk có tồn tại không — sai đường dẫn hoặc OmniRoute chưa cài. */
  timThay: boolean;
  /** Số chunk có thân hàm đã vá. */
  than: number;
  /** Số chỗ gọi đã truyền refreshToken. */
  goi: number;
  /** Đủ cả hai vế mới coi là áp xong. */
  daAp: boolean;
}

function duongDanChunk(goc: string): string {
  return resolve(goc, 'dist/.build/next/server/chunks');
}

/**
 * Bản vá còn áp không.
 *
 * Đếm CẢ thân hàm lẫn nơi gọi: chỉ đếm một vế sẽ báo "đang áp" cho một bản vá hỏng — thân
 * hàm có mà nơi gọi không truyền token thì nhánh mới không bao giờ chạy.
 */
export function xemTrangThai(goc: string): TrangThaiVa {
  const chunks = duongDanChunk(goc);
  let ds: string[];
  try {
    ds = readdirSync(chunks);
  } catch {
    return { timThay: false, than: 0, goi: 0, daAp: false };
  }

  let than = 0;
  let goi = 0;
  for (const f of ds) {
    let s: string;
    try {
      s = readFileSync(resolve(chunks, f), 'utf8');
    } catch {
      continue;
    }
    if (s.includes(DAU_THAN)) than++;
    for (const [, moi] of GOI) if (s.includes(moi)) goi++;
  }
  return { timThay: true, than, goi, daAp: than >= NGUONG_THAN && goi >= NGUONG_GOI };
}

/** Áp bản vá. Trả số chunk đã sửa; 0 = không có gì để sửa (đã vá, hoặc mẫu không khớp). */
export function apVa(goc: string): number {
  const chunks = duongDanChunk(goc);
  let ds: string[];
  try {
    ds = readdirSync(chunks);
  } catch {
    return 0;
  }

  let n = 0;
  for (const f of ds) {
    const p = resolve(chunks, f);
    let s: string;
    try {
      s = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    let moi = s;
    if (moi.includes(HAM_CU)) moi = moi.split(HAM_CU).join(HAM_MOI);
    for (const [cu, thay] of GOI) if (moi.includes(cu)) moi = moi.split(cu).join(thay);
    if (moi === s) continue;
    try {
      writeFileSync(p, moi);
      n++;
    } catch {
      // Không ghi được (quyền, đĩa đầy) → bỏ qua chunk này, đừng làm hỏng cả vòng.
    }
  }
  return n;
}
