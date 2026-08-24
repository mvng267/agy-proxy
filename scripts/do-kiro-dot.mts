/**
 * Bảng số Kiro: mỗi credential có refresh được token và gọi được model thật không.
 *
 * Tách khỏi `do-ca-dot.mts` (Antigravity) vì hai provider khác hẳn đường xác thực:
 * Antigravity cần cấp GCP project, Kiro cần profileArn + refresh qua endpoint riêng.
 */
import { readFileSync } from 'node:fs';
import { parseKiroCredential, refreshKiroToken } from '../src/gateway/kiro.js';
import { kiroProvider } from '../src/gateway/providers/kiro.js';

const MODEL = process.argv[2] ?? 'claude-sonnet-4.5';

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

const rows = parseCsv(readFileSync(process.env.HOME + '/.agyproxy/data/credentials.csv', 'utf8'));
const head = rows[0]!;
const recs = rows.slice(1).filter((r) => r[0])
  .map((r) => Object.fromEntries(head.map((k, i) => [k, r[i] ?? ''])) as Record<string, string>)
  .filter((o) => o.target === 'kiro');

if (!recs.length) { console.error('không có credential kiro nào'); process.exit(1); }

console.log(`Đo ${recs.length} credential Kiro · model ${MODEL}\n`);

/** Song song có giới hạn — xem ghi chú cùng loại trong `do-ca-dot.mts`. */
const LUONG = 6;
let refreshOk = 0, goiDuoc = 0, iNext = 0;

async function motLuong(): Promise<void> {
  for (;;) {
    const i = iNext++;
    if (i >= recs.length) return;
    const rec = recs[i]!;
    const ten = rec.email!.split('@')[0];
    const cred = parseKiroCredential(rec.value ?? '');
    if (!cred) { console.log(`  ✗ ${ten} → credential không parse được`); continue; }
    try {
      const tok = await refreshKiroToken(cred.refreshToken);
      refreshOk++;
      const r = await kiroProvider.generate({
        session: {
          accessToken: tok.accessToken,
          profileArn: tok.profileArn ?? cred.profileArn,
          region: cred.region ?? 'us-east-1',
        },
        model: MODEL,
        messages: [{ role: 'user', content: '1+1?' }],
      } as never);
      const text = String((r as { text?: string }).text ?? '').trim().slice(0, 20);
      goiDuoc++;
      console.log(`  ✓ ${ten} → "${text}"`);
    } catch (e) {
      console.log(`  ✗ ${ten} → ${(e instanceof Error ? e.message : String(e)).slice(0, 110)}`);
    }
  }
}

await Promise.all(Array.from({ length: LUONG }, () => motLuong()));

console.log(`\nRefresh được  : ${refreshOk}/${recs.length}`);
console.log(`Gọi được model: ${goiDuoc}/${recs.length}`);
