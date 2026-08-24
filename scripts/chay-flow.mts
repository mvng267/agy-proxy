/**
 * Chạy flow đăng nhập cho một/nhiều account — gọi THẲNG scheduler, không qua HTTP.
 *
 * Vì sao không dùng `POST /api/run`: dashboard local yêu cầu passcode mà DB vừa khôi phục
 * từ backup nên giữ hash cũ, không đảo ngược được. Đường này bỏ qua lớp auth hoàn toàn,
 * và tiện hơn cho đợt chạy 20 account vì không phải giữ cookie.
 *
 * Chạy:
 *   npx tsx scripts/chay-flow.mts agy 1          # account agyproxy1, flow agy
 *   npx tsx scripts/chay-flow.mts agy 1-20       # 20 account
 *   npx tsx scripts/chay-flow.mts kiro 1-20
 */
import { store } from '../src/store/index.js';
import { scheduler } from '../src/queue/scheduler.js';
import { FLOW_KEYS } from '../src/store/models.js';
import { config } from '../src/config.js';
import type { FlowKey } from '../src/store/models.js';

const DOMAIN = 'luongthevinhhp.edu.vn';
const MAT_KHAU = 'agyproxy@th4G';

/** "1" → [1] · "1-20" → [1..20] */
function docKhoang(s: string): number[] {
  const m = /^(\d+)(?:-(\d+))$/.exec(s) ?? /^(\d+)$/.exec(s);
  if (!m) throw new Error(`khoảng không hợp lệ: ${s} (dùng "1" hoặc "1-20")`);
  const dau = Number(m[1]);
  const cuoi = m[2] ? Number(m[2]) : dau;
  if (cuoi < dau) throw new Error('cuối < đầu');
  return Array.from({ length: cuoi - dau + 1 }, (_, i) => dau + i);
}

const flow = process.argv[2] as FlowKey;
const khoang = process.argv[3] ?? '1';

if (!FLOW_KEYS.includes(flow)) {
  console.error(`flow không hợp lệ: ${flow} (có: ${FLOW_KEYS.join(', ')})`);
  process.exit(2);
}

const so = docKhoang(khoang);
console.log(`Flow "${flow}" cho ${so.length} account (agyproxy${so[0]}..${so[so.length - 1]})\n`);

for (const n of so) {
  const email = `agyproxy${n}@${DOMAIN}`;
  // upsert: chạy lại script không tạo trùng, và bổ sung mật khẩu nếu account đã có sẵn
  store.upsertAccount({ email, password: MAT_KHAU, totp_secret: '', proxy: '', note: 'đợt thử 20' });
  void scheduler.runNow(email, flow);
  console.log(`  xếp hàng: ${email}`);
}

console.log(`\nĐã xếp ${so.length} job · tuần tự, giãn nhịp ${config.pacing.minSec}-${config.pacing.maxSec}s.\n`);

/**
 * Giữ process sống tới khi hàng đợi cạn.
 *
 * `runNow()` chỉ xếp hàng rồi trả về ngay — thoát luôn thì scheduler chết theo process và
 * không job nào chạy (đã bị đúng lỗi này lần đầu). Poll `status()` là cách duy nhất biết
 * xong, vì scheduler không phát sự kiện "hết việc".
 */
/**
 * Mốc dừng là `done >= batchTotal`, KHÔNG phải `running === false`.
 *
 * Scheduler giãn nhịp 180–600s giữa hai job, và trong khoảng nghỉ đó `running` là false
 * còn `queued` là 0 — nhìn vào hai cờ ấy thì tưởng đã xong và thoát sớm (đã bị đúng lỗi
 * này: process chết sau 10 giây, job Kiro chưa kịp chạy). `done`/`batchTotal` là bộ đếm
 * thật của đợt nên không bị khoảng nghỉ đánh lừa.
 */
/**
 * Trần đứng im: máy ngủ làm `interruptibleSleep` của scheduler không tỉnh lại, tiến trình
 * kẹt vô hạn ở "chờ nhịp" — đã mất 17 giờ rồi 27 giờ đúng theo cách này, sáng ra mới biết
 * chưa job nào chạy. Thà thoát và báo còn hơn treo im lặng.
 */
const TRAN_DUNG_IM_MS = 15 * 60_000;

let truoc = -1;
let mocDoi = Date.now();
let treo = false;
for (;;) {
  const st = scheduler.status();
  if (st.done >= st.batchTotal) break;
  if (st.done !== truoc || st.current) {
    if (st.done !== truoc) mocDoi = Date.now();
    truoc = st.done;
    const dang = st.current ? `${st.current.email} · ${st.current.flow}` : 'chờ nhịp';
    const eta = st.etaSec ? ` · còn ~${Math.ceil(st.etaSec / 60)} phút` : '';
    console.log(`  [${new Date().toLocaleTimeString('vi-VN')}] ${st.done}/${st.batchTotal} · ${dang}${eta}`);
  }
  if (Date.now() - mocDoi > TRAN_DUNG_IM_MS) {
    console.log(`\n⚠ Đứng im ${TRAN_DUNG_IM_MS / 60_000} phút ở ${st.done}/${st.batchTotal} — nhiều khả năng máy đã ngủ. Thoát.`);
    treo = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 5000));
}

console.log('\nXong. Kết quả:');
let songSot = 0;
for (const n of so) {
  const email = `agyproxy${n}@${DOMAIN}`;
  const acc = store.listAccounts().find((a) => a.email === email);
  const st = (acc?.[`status_${flow}` as keyof typeof acc] as string) || 'new';
  if (st === 'ok') songSot++;
  console.log(`  ${st === 'ok' ? '✓' : '✗'} ${email} → ${st}`);
}
console.log(`\n${songSot}/${so.length} account ok.`);

/**
 * Đồng bộ sang OmniRoute ngay — hai hệ lưu credential riêng và KHÔNG tự nối nhau, nên
 * token vừa làm mới ở đây sẽ không tới OmniRoute nếu bỏ bước này. Chạy tự động để khỏi
 * phải nhớ, và bỏ qua êm khi OmniRoute không bật (nó là tuỳ chọn, không phải phụ thuộc).
 */
if (songSot > 0 && !process.argv.includes('--khong-dong-bo')) {
  const { dongBo } = await import('../src/omniroute/sync.js');
  const kq = await dongBo(flow === 'kiro' ? 'kiro' : 'agy');
  console.log(kq.boQua ? `Bỏ qua đồng bộ OmniRoute (${kq.chiTiet})` : `Đồng bộ OmniRoute: ${kq.chiTiet}`);
}

if (treo) process.exitCode = 3;
