/**
 * Đo model nào THẬT SỰ gọi được, qua cả agy-proxy (7788) lẫn OmniRoute (20128).
 *
 * Vì sao cần: `PROVIDERS[].models` chỉ là danh sách khai báo. Upstream có thể hết chỗ (503),
 * account không đủ quyền, hoặc model đã đổi tên — danh sách vẫn hiện đủ. Production từng
 * "xanh" trên dashboard trong khi 92% credential đã chết.
 *
 * Chạy:
 *   npx tsx scripts/do-model-hai-cong.mts                        # localhost
 *   MAY=100.112.240.4 KEY=agy_xxx npx tsx scripts/do-model-hai-cong.mts
 *
 * `KEY` là API key của agy-proxy (tạo bằng `agyproxy api POST /api/gateway/keys '{"name":"x"}'`).
 * Thiếu KEY thì bỏ qua cổng 7788, chỉ đo OmniRoute.
 */
const MAY = process.env.MAY ?? 'localhost';
const KEY = process.env.KEY ?? '';
const MK_OMNI = process.env.OMNIROUTE_PASSWORD ?? 'CHANGEME';

/** Mỗi provider vài model đại diện — đủ để thấy provider sống hay chết, không cần quét hết. */
const MODELS = [
  'agy/gemini-3-flash',
  'agy/gemini-3-pro-low',
  'agy/gemini-2.5-flash',
  'agy/gemini-3.5-flash-low',
  'agy/claude-sonnet-4-6',
  'kr/claude-sonnet-4.5',
  'kr/claude-haiku-4.5',
  'kr/deepseek-3.2',
  'kr/glm-5',
];

interface KetQua { ok: boolean; mo: string; giay: number }

async function goi(cong: number, model: string, headers: Record<string, string>): Promise<KetQua> {
  const t0 = Date.now();
  try {
    const res = await fetch(`http://${MAY}:${cong}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '1+1? Trả lời đúng một số.' }],
        stream: false,
      }),
      signal: AbortSignal.timeout(90_000),
    });
    const j = (await res.json()) as { error?: { message?: string }; choices?: Array<{ message?: { content?: string } }> };
    const giay = (Date.now() - t0) / 1000;
    if (j.error) return { ok: false, mo: String(j.error.message ?? 'lỗi').slice(0, 38), giay };
    const txt = String(j.choices?.[0]?.message?.content ?? '').trim().replace(/\s+/g, ' ').slice(0, 14);
    return { ok: true, mo: `"${txt}"`, giay };
  } catch (e) {
    return { ok: false, mo: (e instanceof Error ? e.message : String(e)).slice(0, 38), giay: (Date.now() - t0) / 1000 };
  }
}

/** OmniRoute dùng cookie phiên; agy-proxy dùng Bearer API key. */
async function cookieOmni(): Promise<string> {
  try {
    const res = await fetch(`http://${MAY}:20128/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: MK_OMNI }),
      signal: AbortSignal.timeout(20_000),
    });
    return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  } catch {
    return '';
  }
}

const ck = await cookieOmni();
const hOmni = ck ? { cookie: ck } : {};
const hAgy = KEY ? { authorization: `Bearer ${KEY}` } : null;

if (!hAgy) console.log('⚠ Không có KEY → bỏ qua cổng 7788, chỉ đo OmniRoute.\n');

console.log(`Máy ${MAY}\n`);
console.log('model                       agy-proxy (7788)        OmniRoute (20128)');
console.log('─'.repeat(78));

let okAgy = 0, okOmni = 0, tongAgy = 0;
for (const m of MODELS) {
  const a = hAgy ? await goi(7788, m, hAgy) : null;
  const o = await goi(20128, m, hOmni);
  if (a) { tongAgy++; if (a.ok) okAgy++; }
  if (o.ok) okOmni++;

  const cotA = a ? `${a.ok ? '✓' : '✗'} ${a.mo} ${a.giay.toFixed(1)}s`.padEnd(24) : '—'.padEnd(24);
  console.log(`  ${m.padEnd(26)}${cotA}${o.ok ? '✓' : '✗'} ${o.mo} ${o.giay.toFixed(1)}s`);
}

console.log('─'.repeat(78));
if (hAgy) console.log(`  agy-proxy : ${okAgy}/${tongAgy} model gọi được`);
console.log(`  OmniRoute : ${okOmni}/${MODELS.length} model gọi được`);
