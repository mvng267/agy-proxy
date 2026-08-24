/**
 * Chạy CẢ BỘ 400 account, cả hai flow, rồi đồng bộ sang OmniRoute.
 *
 * Vì sao chỉ hai flow: `agy` và `kiro`. "Antigravity" và "Antigravity CLI" dùng CHUNG một
 * credential `agy` (chung client_id + endpoint Google — xem `flows/oauthProvider.ts`), nên
 * một lần đăng nhập phục vụ cả hai. Flow `gcli` là *Gemini* CLI, đã ngừng dùng (ném lỗi cứng).
 *
 * Lỗi thì BỎ QUA và chạy tiếp — cuối đợt in danh sách để chạy lại, không dừng cả lượt vì
 * một account hỏng.
 *
 * Xếp theo PIPELINE (`agy` rồi `kiro` cho CÙNG account, liên tiếp) thay vì chạy hết 400 `agy`
 * rồi mới quay lại 400 `kiro`. Scheduler chỉ chạy MỘT job tại một thời điểm nên không có
 * chuyện song song thật; nhưng đi theo account thì phiên Google còn nóng khi `kiro` chạy
 * ngay sau `agy` — đỡ một lần đăng nhập lại, và mỗi account xong hẳn trước khi sang cái kế,
 * nên dừng giữa chừng vẫn có account dùng được trọn vẹn.
 *
 * Chạy ở tiền cảnh để xem log trực tiếp; Ctrl-C dừng an toàn (scheduler nhả sau job hiện tại).
 *
 *   npx tsx scripts/chay-tat-ca.mts            # cả 400
 *   npx tsx scripts/chay-tat-ca.mts 1-100      # một khoảng
 *   npx tsx scripts/chay-tat-ca.mts 1-400 kiro # chỉ một flow
 */
import { store } from '../src/store/index.js';
import { scheduler } from '../src/queue/scheduler.js';
import { config } from '../src/config.js';
import type { FlowKey } from '../src/store/models.js';

const DOMAIN = 'luongthevinhhp.edu.vn';
const MAT_KHAU = 'agyproxy@th4G';
const FLOWS: FlowKey[] = ['agy', 'kiro'];

function docKhoang(s: string): number[] {
  const m = /^(\d+)-(\d+)$/.exec(s) ?? /^(\d+)$/.exec(s);
  if (!m) throw new Error(`khoảng không hợp lệ: ${s}`);
  const dau = Number(m[1]);
  const cuoi = m[2] ? Number(m[2]) : dau;
  return Array.from({ length: cuoi - dau + 1 }, (_, i) => dau + i);
}

const so = docKhoang(process.argv[2] ?? '1-400');
const chiFlow = process.argv[3] as FlowKey | undefined;
const flows = chiFlow ? [chiFlow] : FLOWS;

const gio = () => new Date().toLocaleTimeString('vi-VN');
const phut = (ms: number) => `${Math.round(ms / 60000)} phút`;

console.log(`\n╭─ CHẠY ${so.length} ACCOUNT × ${flows.length} FLOW = ${so.length * flows.length} lần đăng nhập`);
console.log(`│  agyproxy${so[0]}..${so[so.length - 1]} · flow: ${flows.join(', ')}`);
console.log(`│  giãn nhịp ${config.pacing.minSec}-${config.pacing.maxSec}s · trần ${config.dailyLoginCap} login/24h`);
console.log(`╰─ Ctrl-C để dừng (an toàn, nhả sau job đang chạy)\n`);

for (const n of so) {
  store.upsertAccount({
    email: `agyproxy${n}@${DOMAIN}`,
    password: MAT_KHAU,
    totp_secret: '',
    proxy: '',
    note: 'bộ 400',
  });
}

const batDau = Date.now();

/**
 * Bỏ qua account ĐÃ có credential của flow đó.
 *
 * Không lọc thì `1-400` chạy lại từ đầu cả những account đã xong — lãng phí ~200 lần đăng
 * nhập, và mỗi lần thừa là một lượt rủi ro captcha không cần thiết. Thêm `--lam-lai` khi
 * thật sự muốn làm mới token.
 */
const lamLai = process.argv.includes('--lam-lai');
// `store.load()` KHÔNG tự chạy lúc import — server gọi nó, script thì phải tự gọi. Thiếu
// dòng này thì `listCredentials()` trả rỗng và bộ lọc vô tác dụng (đã bị: xếp đủ 800 job,
// bỏ qua 0, chạy lại từ đầu cả 99 account đã xong).
store.load();
const daCo = new Set(store.listCredentials().map((c) => `${c.email}|${c.target}`));

let xep = 0, boQua = 0;
for (const n of so) {
  const email = `agyproxy${n}@${DOMAIN}`;
  const con = lamLai ? flows : flows.filter((f) => !daCo.has(`${email}|${f}`));
  if (!con.length) { boQua++; continue; }
  scheduler.enqueuePipeline(email, con);
  xep += con.length;
}
console.log(`Xếp ${xep} job · bỏ qua ${boQua} account đã đủ credential${lamLai ? ' (--lam-lai: xếp hết)' : ''}\n`);
if (!xep) { console.log('Không còn gì để chạy.'); process.exit(0); }

// Bộ đếm `done`/`batchTotal` là mốc thật; `running`/`queued` đều false/0 trong khoảng giãn
// nhịp nên nhìn vào chúng sẽ tưởng đã xong và thoát sớm.
let truoc = -1;
let mocDoi = Date.now();
for (;;) {
  const st = scheduler.status();
  if (st.done >= st.batchTotal) break;

  if (st.done !== truoc) {
    truoc = st.done;
    mocDoi = Date.now();
    const dang = st.current ? `${st.current.email.split('@')[0]} · ${st.current.flow}` : 'chờ nhịp';
    const con = st.etaSec ? ` · còn ~${phut(st.etaSec * 1000)}` : '';
    console.log(`  [${gio()}] ${st.done}/${st.batchTotal} · ${dang}${con}`);
  }
  // Máy ngủ làm scheduler kẹt vô hạn ở "chờ nhịp" — đã mất 17 rồi 27 tiếng vì im lặng.
  if (Date.now() - mocDoi > 15 * 60_000) {
    console.log(`\n⚠ Đứng im 15 phút ở ${st.done}/${st.batchTotal} — máy có thể đã ngủ. Dừng.`);
    process.exitCode = 3;
    break;
  }
  await new Promise((r) => setTimeout(r, 5000));
}

// ---- tổng kết ----
console.log(`\n╭─ KẾT QUẢ · ${phut(Date.now() - batDau)}`);
const hong: Record<string, string[]> = {};
for (const flow of flows) {
  let ok = 0;
  hong[flow] = [];
  for (const n of so) {
    const email = `agyproxy${n}@${DOMAIN}`;
    const acc = store.listAccounts().find((a) => a.email === email);
    const st = (acc?.[`status_${flow}` as keyof typeof acc] as string) || 'new';
    if (st === 'ok') ok++;
    else hong[flow]!.push(`${n}:${st}`);
  }
  console.log(`│  ${flow}: ${ok}/${so.length} ok`);
}
for (const [flow, ds] of Object.entries(hong)) {
  if (!ds.length) continue;
  console.log(`│  ${flow} hỏng (${ds.length}): ${ds.slice(0, 25).join(' ')}${ds.length > 25 ? ' …' : ''}`);
}
console.log('╰─');

// ---- đồng bộ ----
try {
  const { dongBo } = await import('../src/omniroute/sync.js');
  console.log('\nĐồng bộ OmniRoute…');
  const kq = await dongBo();
  console.log(`  ${kq.chiTiet}`);
} catch (e) {
  console.log(`  bỏ qua (${(e instanceof Error ? e.message : String(e)).slice(0, 80)})`);
}

// Gợi ý lệnh chạy lại — lỗi thường là hạ tầng (cửa sổ đóng, captcha), chạy lại là được.
for (const [flow, ds] of Object.entries(hong)) {
  if (!ds.length) continue;
  const nums = ds.map((x) => x.split(':')[0]).join(',');
  console.log(`\nChạy lại ${flow}: npx tsx scripts/chay-lai.mts ${flow} ${nums}`);
}
