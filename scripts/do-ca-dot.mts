/**
 * Bảng số của đợt thử: mỗi account có tự cấp GCP project và gọi được model thật không.
 *
 * Vì sao đo cả hai bước riêng: `status_agy = ok` chỉ nói ĐĂNG NHẬP xong, không nói gọi
 * được model. Production từng xanh hết trên dashboard mà thực tế chết — nên phép đo duy
 * nhất đáng tin là gọi model trả về nội dung thật.
 */
import { readFileSync } from 'node:fs';
import { refreshAccessToken, discoverProject, generate } from '../src/gateway/antigravity.js';

const MODEL = process.argv[2] ?? 'gemini-3.5-flash-low';

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
  .filter((o) => o.target === 'agy' || o.target === 'antigravity');

if (!recs.length) { console.error('không có credential agy nào'); process.exit(1); }

console.log(`Đo ${recs.length} account · model ${MODEL}\n`);

/**
 * Chạy song song có giới hạn — tuần tự thì 100 account mất ~15 phút vì mỗi cái phải
 * refresh token + onboard project + gọi model. Giữ 6 luồng: đủ nhanh mà không dồn dập
 * làm Google trả 429.
 */
const LUONG = 6;
let coProject = 0, goiDuoc = 0, iNext = 0;

async function motLuong(): Promise<void> {
  for (;;) {
    const i = iNext++;
    if (i >= recs.length) return;
    const rec = recs[i]!;
    const ten = rec.email!.split('@')[0];
    const rt = (rec.value ?? '').trim();
    if (!rt.startsWith('1//')) { console.log(`  ✗ ${ten} → credential không phải refresh token`); continue; }
    try {
      const { accessToken } = await refreshAccessToken(rt);
      const projectId = await discoverProject(accessToken);
      coProject++;
      const r = await generate({
        accessToken, projectId, model: MODEL,
        messages: [{ role: 'user', content: '1+1?' }],
      } as never);
      const text = String((r as { text?: string }).text ?? '').trim().slice(0, 20);
      goiDuoc++;
      console.log(`  ✓ ${ten} · ${projectId} → "${text}"`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  ✗ ${ten} → ${msg.slice(0, 110)}`);
    }
  }
}

await Promise.all(Array.from({ length: LUONG }, () => motLuong()));

console.log(`\nTự cấp project : ${coProject}/${recs.length}`);
console.log(`Gọi được model : ${goiDuoc}/${recs.length}`);
