/**
 * Tiện ích xem/sửa connection của OmniRoute qua HTTP API.
 *
 * Vì sao qua API chứ không đọc thẳng storage.sqlite: token được mã hoá AES-GCM bằng
 * STORAGE_ENCRYPTION_KEY, ghi tay sẽ tạo hàng không đọc được. API là đường duy nhất
 * để OmniRoute tự mã hoá đúng.
 *
 * Dùng:
 *   node scripts/omni-conn.mjs ls                 # liệt kê connection kiro
 *   node scripts/omni-conn.mjs rm <id>            # xoá một connection
 *   node scripts/omni-conn.mjs rmall              # xoá hết connection kiro
 *   node scripts/omni-conn.mjs import <n>         # import credential account n
 *   node scripts/omni-conn.mjs tach <id> <nhan>   # đổi profileArn/clientId để hết trùng
 *   node scripts/omni-conn.mjs dodo <từ> <đến>    # import + tách lần lượt (đường vòng)
 */
import { readFileSync } from 'node:fs';
const OMNI = process.env.OMNIROUTE_URL ?? 'http://localhost:20128';
const MAT_KHAU = process.env.OMNIROUTE_PASSWORD ?? 'CHANGEME';

async function dangNhap() {
  const res = await fetch(`${OMNI}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: MAT_KHAU }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`đăng nhập hỏng ${res.status}`);
  const ck = res.headers.getSetCookie?.() ?? [];
  return ck.map((c) => c.split(';')[0]).join('; ');
}

async function api(cookie, path, init = {}) {
  const res = await fetch(`${OMNI}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
}

/** Lọc ra connection của provider kiro từ mọi hình dạng payload có thể. */
function locKiro(body) {
  const arr = Array.isArray(body) ? body : (body?.connections ?? body?.providers ?? body?.data ?? []);
  return (Array.isArray(arr) ? arr : []).filter((c) => String(c?.provider ?? '').toLowerCase() === 'kiro');
}

/** Parser CSV đúng chuẩn — value là JSON chứa dấu phẩy. */
function parseCsv(t) {
  const rows = [];
  let f = '', row = [], q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

function credKiro(n) {
  const rows = parseCsv(readFileSync(process.env.HOME + '/.agyproxy/data/credentials.csv', 'utf8'));
  const head = rows[0];
  const rec = rows.slice(1).filter((r) => r[0])
    .map((r) => Object.fromEntries(head.map((k, i) => [k, r[i] ?? ''])))
    .find((o) => o.target === 'kiro' && o.email === `agyproxy${n}@luongthevinhhp.edu.vn`);
  return rec ? JSON.parse(rec.value) : null;
}

async function importOne(cookie, n) {
  const c = credKiro(n);
  if (!c) return { ok: false, status: 0, body: `không có credential kiro cho account ${n}` };
  return api(cookie, '/api/oauth/kiro/import?targetProvider=kiro', {
    method: 'POST',
    body: JSON.stringify({ refreshToken: c.refreshToken, region: c.region ?? 'us-east-1' }),
  });
}

/**
 * Đổi `profileArn` + `clientId` của một connection thành giá trị riêng.
 *
 * Vì sao cần: Kiro free-tier cấp CHUNG một profileArn cho mọi tài khoản, mà
 * `findKiroConnectionByIdentity` khớp profileArn trước tiên → mọi import sau đều bị coi là
 * tài khoản cũ và đè lên. Gắn hậu tố vào ARN của hàng đã có thì lần import kế tiếp không
 * khớp nữa, buộc OmniRoute tạo hàng mới.
 */
async function tach(cookie, id, nhan) {
  const cur = await api(cookie, '/api/providers');
  const c = locKiro(cur.body).find((x) => x.id === id);
  if (!c) return { ok: false, status: 404, body: 'không thấy connection' };
  const psd = { ...(c.providerSpecificData ?? {}) };
  psd.profileArn = `${String(psd.profileArn ?? '').split('--')[0]}--${nhan}`;
  psd.clientId = `${String(psd.clientId ?? 'x').split('--')[0]}--${nhan}`;
  return api(cookie, `/api/providers/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({ name: nhan, providerSpecificData: psd }),
  });
}

const lenh = process.argv[2] ?? 'ls';
const cookie = await dangNhap();

if (lenh === 'ls') {
  const r = await api(cookie, '/api/providers');
  const ks = locKiro(r.body);
  console.log(`HTTP ${r.status} · connection kiro: ${ks.length}`);
  for (const c of ks) {
    console.log(`  id=${c.id}`);
    console.log(`     name=${c.name ?? '(null)'} · email=${c.email ?? '(null)'} · auth=${c.authType ?? c.auth_type}`);
    const psd = c.providerSpecificData ?? c.provider_specific_data;
    if (psd) console.log(`     psd=${JSON.stringify(psd).slice(0, 160)}`);
  }
  if (!ks.length) console.log('  (payload thô)', JSON.stringify(r.body).slice(0, 300));
} else if (lenh === 'rm') {
  const id = process.argv[3];
  if (!id) { console.error('thiếu id'); process.exit(2); }
  const r = await api(cookie, `/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
  console.log(`xoá ${id} → HTTP ${r.status}`, JSON.stringify(r.body).slice(0, 200));
} else if (lenh === 'rmall') {
  const r = await api(cookie, '/api/providers');
  const ks = locKiro(r.body);
  for (const c of ks) {
    const d = await api(cookie, `/api/providers/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
    console.log(`  xoá ${c.id} → HTTP ${d.status}`);
  }
  console.log(`đã xoá ${ks.length} connection`);
} else if (lenh === 'import') {
  const r = await importOne(cookie, process.argv[3]);
  console.log(`HTTP ${r.status}`, JSON.stringify(r.body).slice(0, 200));
} else if (lenh === 'tach') {
  const r = await tach(cookie, process.argv[3], process.argv[4]);
  console.log(`HTTP ${r.status}`);
} else if (lenh === 'dodo') {
  // Đường vòng: import một cái → tách ngay để nó không nuốt cái kế tiếp.
  const tu = Number(process.argv[3] ?? 1);
  const den = Number(process.argv[4] ?? 20);
  for (let n = tu; n <= den; n++) {
    const imp = await importOne(cookie, n);
    if (!imp.ok) { console.log(`  ✗ acc${n} import → HTTP ${imp.status}`); continue; }
    const id = imp.body?.connection?.id;
    const t = await tach(cookie, id, `agyproxy${n}`);
    const ds = locKiro((await api(cookie, '/api/providers')).body);
    console.log(`  ${t.ok ? '✓' : '✗'} acc${n} → id=${String(id).slice(0, 8)} · tổng connection: ${ds.length}`);
  }
} else if (lenh === 'put') {
  // Sửa tuỳ ý một connection: node omni-conn.mjs put <id> '<json>'
  const r = await api(cookie, `/api/providers/${encodeURIComponent(process.argv[3])}`, {
    method: 'PUT',
    body: process.argv[4],
  });
  console.log(`HTTP ${r.status}`);
} else if (lenh === 'goi') {
  // Gọi model qua MỘT connection cụ thể — phép đo duy nhất đáng tin sau khi sửa profileArn.
  const id = process.argv[3];
  const r = await api(cookie, '/v1/chat/completions', {
    method: 'POST',
    headers: id ? { 'x-omniroute-connection': id } : {},
    body: JSON.stringify({
      model: process.argv[4] ?? 'kr/claude-sonnet-4.5',
      messages: [{ role: 'user', content: '1+1? Trả lời đúng một số.' }],
      stream: false,
    }),
  });
  const noi = r.body?.choices?.[0]?.message?.content;
  console.log(`HTTP ${r.status} → ${noi !== undefined ? JSON.stringify(noi) : JSON.stringify(r.body).slice(0, 260)}`);
} else {
  console.error(`lệnh lạ: ${lenh}`);
  process.exit(2);
}
