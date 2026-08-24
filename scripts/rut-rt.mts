/**
 * In refresh token Kiro của một account ra stdout — để script shell lấy dùng.
 *
 * Dùng: npx tsx scripts/rut-rt.mts 6
 */
import { readFileSync } from 'node:fs';

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

const n = process.argv[2];
if (!n) { console.error('thiếu số account'); process.exit(2); }

const rows = parseCsv(readFileSync(process.env.HOME + '/.agyproxy/data/credentials.csv', 'utf8'));
const head = rows[0]!;
const rec = rows.slice(1).filter((r) => r[0])
  .map((r) => Object.fromEntries(head.map((k, i) => [k, r[i] ?? ''])) as Record<string, string>)
  .find((o) => o.target === 'kiro' && o.email === `agyproxy${n}@luongthevinhhp.edu.vn`);

if (!rec) { console.error(`không có credential kiro cho account ${n}`); process.exit(1); }
process.stdout.write((JSON.parse(rec.value!) as { refreshToken: string }).refreshToken);
