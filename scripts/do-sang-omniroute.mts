/**
 * Đổ credential Kiro của agy-proxy sang OmniRoute — bỏ qua luồng device code.
 *
 * Vì sao đi đường này: dashboard OmniRoute chỉ có luồng device code (cấp mã ngắn, đợi
 * người vào app.kiro.dev nhập). 400 lần bấm tay là không thực tế. `POST /api/oauth/kiro/import`
 * nhận thẳng credential dựng sẵn, và `kiroImportSchema` của OmniRoute cần đúng những trường
 * agy-proxy đã lưu: refreshToken (bắt buộc), region, authMethod, profileArn.
 *
 * Không ghi thẳng SQLite vì `STORAGE_ENCRYPTION_KEY` có đặt → token phải qua lớp mã hoá
 * AES-GCM của OmniRoute; ghi tay sẽ tạo hàng không đọc được.
 *
 * Chạy:
 *   npx tsx scripts/do-sang-omniroute.mts            # đổ mọi credential kiro
 *   npx tsx scripts/do-sang-omniroute.mts --thu      # chỉ in ra, không gửi
 */
import { readFileSync } from 'node:fs';

const OMNI = process.env.OMNIROUTE_URL ?? 'http://localhost:20128';
const CSV = process.env.HOME + '/.agyproxy/data/credentials.csv';
const MAT_KHAU_OMNI = process.env.OMNIROUTE_PASSWORD ?? 'CHANGEME';
const thuThoi = process.argv.includes('--thu');

/**
 * Đăng nhập lấy cookie phiên — mọi endpoint `/api/oauth/*` đều trả 401 nếu thiếu.
 * Trả về chuỗi Cookie để gắn vào request sau.
 */
async function dangNhap(): Promise<string> {
  const res = await fetch(`${OMNI}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: MAT_KHAU_OMNI }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`đăng nhập OmniRoute hỏng (${res.status}) — đặt OMNIROUTE_PASSWORD nếu đã đổi`);
  const ck = res.headers.getSetCookie?.() ?? [];
  const cookie = ck.map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('đăng nhập OK nhưng không nhận được cookie');
  return cookie;
}

/** Parser CSV đúng chuẩn — value là JSON chứa dấu phẩy, split(',') sẽ lệch cột. */
function parseCsv(t: string): string[][] {
  const rows: string[][] = [];
  let f = '', row: string[] = [], q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

interface CredKiro {
  refreshToken: string;
  profileArn?: string;
  region?: string;
  authMethod?: string;
}

const rows = parseCsv(readFileSync(CSV, 'utf8'));
const head = rows[0]!;
const recs = rows.slice(1)
  .filter((r) => r[0])
  .map((r) => Object.fromEntries(head.map((k, i) => [k, r[i] ?? ''])) as Record<string, string>)
  .filter((o) => o.target === 'kiro');

if (!recs.length) {
  console.error('Không có credential target=kiro nào trong ' + CSV);
  process.exit(1);
}

console.log(`Đổ ${recs.length} credential Kiro sang ${OMNI}${thuThoi ? ' (THỬ, không gửi)' : ''}\n`);

const cookie = thuThoi ? '' : await dangNhap();

let ok = 0, hong = 0;
for (const rec of recs) {
  let cred: CredKiro;
  try {
    cred = JSON.parse(rec.value!) as CredKiro;
  } catch {
    console.log(`  ✗ ${rec.email} → value không phải JSON`);
    hong++;
    continue;
  }
  if (!cred.refreshToken) {
    console.log(`  ✗ ${rec.email} → thiếu refreshToken`);
    hong++;
    continue;
  }

  const body = {
    refreshToken: cred.refreshToken,
    region: cred.region ?? 'us-east-1',
    ...(cred.profileArn ? { profileArn: cred.profileArn } : {}),
    ...(cred.authMethod ? { authMethod: cred.authMethod } : {}),
  };

  if (thuThoi) {
    console.log(`  · ${rec.email} → sẽ gửi ${JSON.stringify({ ...body, refreshToken: body.refreshToken.slice(0, 12) + '…' })}`);
    continue;
  }

  try {
    const res = await fetch(`${OMNI}/api/oauth/kiro/import?targetProvider=kiro`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      console.log(`  ✗ ${rec.email} → HTTP ${res.status}: ${text.slice(0, 120)}`);
      hong++;
      continue;
    }
    console.log(`  ✓ ${rec.email}`);
    ok++;
  } catch (e) {
    console.log(`  ✗ ${rec.email} → ${e instanceof Error ? e.message : String(e)}`);
    hong++;
  }
}

if (!thuThoi) console.log(`\nThành công ${ok}/${recs.length}${hong ? ` · hỏng ${hong}` : ''}`);
