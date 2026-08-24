/**
 * Chạy lại các account hỏng — nhận danh sách số rời, không phải khoảng.
 *
 * `chay-tat-ca.mts` in sẵn lệnh này ở cuối đợt. Lỗi thường là hạ tầng (cửa sổ browser đóng,
 * captcha một lần) nên chạy lại phần lớn là được.
 *
 *   npx tsx scripts/chay-lai.mts agy 12,45,89
 */
import { store } from '../src/store/index.js';
import { scheduler } from '../src/queue/scheduler.js';
import { FLOW_KEYS } from '../src/store/models.js';
import type { FlowKey } from '../src/store/models.js';

const DOMAIN = 'luongthevinhhp.edu.vn';
const flow = process.argv[2] as FlowKey;
const ds = (process.argv[3] ?? '').split(',').map((x) => Number(x.trim())).filter((n) => n > 0);

if (!FLOW_KEYS.includes(flow) || !ds.length) {
  console.error('dùng: npx tsx scripts/chay-lai.mts <agy|kiro> <12,45,89>');
  process.exit(2);
}

console.log(`Chạy lại ${ds.length} account · flow ${flow}\n`);
for (const n of ds) void scheduler.runNow(`agyproxy${n}@${DOMAIN}`, flow);

let truoc = -1;
let mocDoi = Date.now();
for (;;) {
  const st = scheduler.status();
  if (st.done >= st.batchTotal) break;
  if (st.done !== truoc) {
    truoc = st.done;
    mocDoi = Date.now();
    console.log(`  [${new Date().toLocaleTimeString('vi-VN')}] ${st.done}/${st.batchTotal} · ${st.current?.email.split('@')[0] ?? 'chờ nhịp'}`);
  }
  if (Date.now() - mocDoi > 15 * 60_000) { console.log('\n⚠ Đứng im 15 phút — dừng.'); break; }
  await new Promise((r) => setTimeout(r, 5000));
}

let ok = 0;
const con: number[] = [];
for (const n of ds) {
  const acc = store.listAccounts().find((a) => a.email === `agyproxy${n}@${DOMAIN}`);
  const st = (acc?.[`status_${flow}` as keyof typeof acc] as string) || 'new';
  if (st === 'ok') ok++;
  else con.push(n);
}
console.log(`\n${ok}/${ds.length} ok`);
if (con.length) console.log(`còn hỏng: ${con.join(',')}`);

try {
  const { dongBo } = await import('../src/omniroute/sync.js');
  const kq = await dongBo(flow === 'kiro' ? 'kiro' : 'agy');
  console.log(`Đồng bộ OmniRoute: ${kq.chiTiet}`);
} catch { /* OmniRoute tắt → bỏ qua */ }
