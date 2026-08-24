/**
 * Đổ credential Antigravity (`agy`) của agy-proxy sang OmniRoute.
 *
 * Khác Kiro: Antigravity không nhận refresh token trần mà cần **credential blob**
 * `omniroute-cred-v1.<base64url(JSON)>` qua `POST /api/oauth/agy/paste-credentials`.
 * Blob vốn sinh bởi `omniroute login antigravity` (chạy OAuth trên máy có loopback),
 * nhưng định dạng chỉ là `{v, provider, tokens}` nên dựng thẳng từ refresh token đã có
 * — khỏi phải đăng nhập lại 400 lần.
 *
 * OmniRoute tự chạy onboarding phía server sau khi nhận blob, nên nó tự lấy được
 * GCP project (thứ agy-proxy làm bằng `discoverProject`).
 *
 * Chạy:
 *   npx tsx scripts/do-agy-omniroute.mts          # đổ hết
 *   npx tsx scripts/do-agy-omniroute.mts --thu    # chỉ in, không gửi
 */
import { readFileSync } from 'node:fs';
import { refreshAccessToken } from '../src/gateway/antigravity.js';

const OMNI = process.env.OMNIROUTE_URL ?? 'http://localhost:20128';
const MAT_KHAU = process.env.OMNIROUTE_PASSWORD ?? 'CHANGEME';
const CSV = process.env.HOME + '/.agyproxy/data/credentials.csv';
const thuThoi = process.argv.includes('--thu');

function parseCsv(t: string): string[][] {
  const rows: string[][] = [];
  let f = '', row: string[] = [], q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

/**
 * `omniroute-cred-v1.` + base64url(JSON) — theo src/lib/oauth/credentialBlob.ts.
 *
 * Bắt buộc có `access_token`: decoder từ chối blob thiếu nó
 * (`invalid payload — missing access_token`). agy-proxy chỉ lưu refresh token, nên phải
 * refresh lấy access token trước khi dựng blob.
 */
function dungBlob(refreshToken: string, accessToken: string, expiresIn: number): string {
  const payload = {
    v: 1,
    provider: 'agy',
    tokens: { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn },
  };
  return 'omniroute-cred-v1.' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

async function dangNhap(): Promise<string> {
  const res = await fetch(`${OMNI}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: MAT_KHAU }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`đăng nhập OmniRoute hỏng (${res.status})`);
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('không nhận được cookie');
  return cookie;
}

const rows = parseCsv(readFileSync(CSV, 'utf8'));
const head = rows[0]!;
const recs = rows.slice(1).filter((r) => r[0])
  .map((r) => Object.fromEntries(head.map((k, i) => [k, r[i] ?? ''])) as Record<string, string>)
  .filter((o) => o.target === 'agy' || o.target === 'antigravity');

if (!recs.length) { console.error('không có credential agy nào trong ' + CSV); process.exit(1); }

console.log(`Đổ ${recs.length} credential Antigravity sang ${OMNI}${thuThoi ? ' (THỬ)' : ''}\n`);

const cookie = thuThoi ? '' : await dangNhap();
let ok = 0, hong = 0;

for (const rec of recs) {
  const ten = rec.email!.split('@')[0];
  const rt = (rec.value ?? '').trim();
  if (!rt.startsWith('1//')) { console.log(`  ✗ ${ten} → không phải refresh token Google`); hong++; continue; }

  if (thuThoi) { console.log(`  · ${ten} → sẽ refresh rồi dựng blob`); continue; }

  try {
    const tok = await refreshAccessToken(rt);
    const conLai = Math.max(60, Math.floor((tok.expiresAt - Date.now()) / 1000));
    const blob = dungBlob(rt, tok.accessToken, conLai);
    const res = await fetch(`${OMNI}/api/oauth/agy/paste-credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ blob }),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    if (!res.ok) { console.log(`  ✗ ${ten} → HTTP ${res.status}: ${text.slice(0, 130)}`); hong++; continue; }
    console.log(`  ✓ ${ten}`);
    ok++;
  } catch (e) {
    console.log(`  ✗ ${ten} → ${(e instanceof Error ? e.message : String(e)).slice(0, 110)}`);
    hong++;
  }
}

if (!thuThoi) console.log(`\nThành công ${ok}/${recs.length}${hong ? ` · hỏng ${hong}` : ''}`);
