import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { store } from '../store/index.js';
import { refreshAccessToken } from '../gateway/antigravity.js';
import { parseKiroCredential } from '../gateway/kiro.js';
import { omniroute } from './client.js';

/**
 * Đẩy credential của agy-proxy sang OmniRoute.
 *
 * Vì sao cần: hai gateway lưu credential riêng và KHÔNG tự nối nhau — cột
 * `omniroute_connection_id` trong `credentials.csv` rỗng 100% từ khi tích hợp cũ bị gỡ.
 * Đăng nhập lại ở agy-proxy mà không đẩy sang thì OmniRoute vẫn dùng token chết.
 *
 * Hai provider đi hai đường khác nhau:
 *
 *   agy  → `POST /api/providers/agy-auth/import-bulk`  (50 credential/lượt)
 *   kiro → `POST /api/oauth/kiro/import`               (từng cái một)
 *
 * Chọn `import-bulk` cho `agy` thay vì `paste-credentials` vì nó nhận `email`, nên OmniRoute
 * dedupe đúng bằng `findExistingAgyConnection(email)` và tự lấy `projectId`. Đường
 * `paste-credentials` không có email nên trước đây phải chắp vá bằng SQL trực tiếp vào
 * `~/.omniroute/storage.sqlite` — thứ chỉ chạy được khi hai hệ ở CÙNG MÁY.
 *
 * ⚠ Kiro vẫn cần bản vá dedupe của OmniRoute (`tools/va-omniroute`): nó không có bulk, và
 * Kiro free-tier cấp CHUNG một `profileArn` cho mọi tài khoản Google nên OmniRoute gốc gộp
 * cả 20 account thành 1 connection.
 */

export interface KetQuaMot {
  email: string;
  target: string;
  ok: boolean;
  loi?: string;
}

export interface KetQuaDongBo {
  ok: boolean;
  /** Bỏ qua vì chưa cấu hình mật khẩu — không phải lỗi. */
  boQua?: boolean;
  ketQua: KetQuaMot[];
  chiTiet: string;
}

/** Chưa đặt mật khẩu = tắt hẳn. Không gọi, không cảnh báo. */
export function dangBat(): boolean {
  return Boolean(config.omniroute.password);
}

function tomTat(ketQua: KetQuaMot[]): string {
  const ok = ketQua.filter((k) => k.ok).length;
  return `${ok}/${ketQua.length}`;
}

/**
 * Antigravity: gom thành lô rồi đẩy một lượt.
 *
 * `import-bulk` cần `json` là token response thô của Google (`refresh_token` + `access_token`),
 * nên phải refresh trước — agy-proxy chỉ lưu refresh token.
 */
/**
 * OmniRoute LƯU connection Antigravity dưới provider `agy`, nhưng lúc PHỤC VỤ lại tìm
 * `antigravity` — không đổi thì mọi request trả `No active credentials for provider:
 * antigravity` dù bảng có đủ 20 hàng. Đã đo: xoá hết hàng `antigravity`, để lại 20 hàng
 * `agy`, gọi model liền hỏng.
 *
 * Phải đi thẳng SQLite vì API không cho sửa: `PATCH /api/providers/:id` trả 405, `PUT` trả
 * *"No valid fields to update"*. Cột `provider` KHÔNG mã hoá (chỉ token mới bị AES-GCM) nên
 * ghi tay an toàn — khác hẳn việc ghi token, thứ sẽ tạo hàng không đọc được.
 *
 * Ràng buộc: chỉ chạy khi OmniRoute ở CÙNG MÁY. Máy khác thì bỏ qua êm, connection vẫn nằm
 * dưới `agy` và người dùng phải tự đổi — thà vậy còn hơn ném lỗi giữa chừng.
 */
/**
 * Mở SQLite của OmniRoute ở chế độ ghi, có chờ khoá.
 *
 * OmniRoute đang chạy và giữ khoá ghi — mở thẳng thì `UPDATE` ném `SQLITE_BUSY` và trước
 * đây `catch` nuốt im lặng. Hậu quả đo trên production: đổi tên không xảy ra → `import-bulk`
 * không thấy hàng cũ → mỗi email sinh 2 hàng (499 hàng cho 337 email).
 *
 * `busy_timeout` cho SQLite tự chờ thay vì hỏng ngay.
 */
async function moDbOmni(): Promise<InstanceType<typeof import('node:sqlite').DatabaseSync> | null> {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(`${process.env.HOME}/.omniroute/storage.sqlite`);
    db.exec('PRAGMA busy_timeout = 15000');
    return db;
  } catch {
    return null; // OmniRoute ở máy khác → bỏ qua, không phải lỗi
  }
}

async function doiTenProvider(tu: 'agy' | 'antigravity', den: 'agy' | 'antigravity'): Promise<void> {
  const db = await moDbOmni();
  if (!db) return;
  try {
    const n = db.prepare('UPDATE provider_connections SET provider=? WHERE provider=?').run(den, tu);
    if (n.changes) logger.info(`Đổi tên connection ${tu} → ${den}`, { so: n.changes });
  } catch (e) {
    // KHÔNG nuốt im lặng: đây là bước quyết định dedupe có chạy hay không.
    logger.warn(`Đổi tên ${tu} → ${den} HỎNG — sẽ sinh bản trùng`, {
      loi: (e instanceof Error ? e.message : String(e)).slice(0, 120),
    });
  }
}

/**
 * Dọn bản trùng theo email — chốt cuối, không phụ thuộc đổi tên có chạy hay không.
 *
 * Giữ hàng MỚI NHẤT vì nó mang token còn hạn. Không dedupe theo `refresh_token` được:
 * OmniRoute mã hoá AES-GCM với IV ngẫu nhiên nên cùng token ghi hai lần ra hai chuỗi khác.
 */
async function donTrungTheoEmail(): Promise<void> {
  const db = await moDbOmni();
  if (!db) return;
  try {
    const n = db.prepare(`
      DELETE FROM provider_connections
      WHERE provider IN ('agy','antigravity','kiro')
        AND email IS NOT NULL AND email <> ''
        AND id NOT IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (
              PARTITION BY provider, email ORDER BY updated_at DESC, created_at DESC
            ) rn
            FROM provider_connections
            WHERE provider IN ('agy','antigravity','kiro') AND email IS NOT NULL AND email <> ''
          ) WHERE rn = 1
        )`).run();
    if (n.changes) logger.info('Dọn connection trùng email', { bo: n.changes });
  } catch (e) {
    logger.warn('Dọn trùng hỏng', { loi: (e instanceof Error ? e.message : String(e)).slice(0, 120) });
  }
}

async function dongBoAgy(): Promise<KetQuaMot[]> {
  const creds = store.listCredentials().filter((c) => c.target === 'agy' || c.target === 'antigravity');
  if (!creds.length) return [];

  const entries: Array<{ json: unknown; email: string }> = [];
  const ketQua: KetQuaMot[] = [];

  for (const c of creds) {
    const rt = String(c.value ?? '').trim();
    if (!rt.startsWith('1//')) {
      ketQua.push({ email: c.email, target: 'agy', ok: false, loi: 'không phải refresh token Google' });
      continue;
    }
    try {
      const tok = await refreshAccessToken(rt);
      entries.push({
        email: c.email,
        json: {
          access_token: tok.accessToken,
          refresh_token: rt,
          expires_in: Math.max(60, Math.floor((tok.expiresAt - Date.now()) / 1000)),
          token_type: 'Bearer',
        },
      });
    } catch (e) {
      ketQua.push({
        email: c.email,
        target: 'agy',
        ok: false,
        loi: (e instanceof Error ? e.message : String(e)).slice(0, 160),
      });
    }
  }

  if (entries.length) {
    const { imported, loi } = await omniroute.importAgyBulk(entries);
    // Route trả tổng chứ không map theo từng entry, nên đánh dấu theo thứ tự: `imported`
    // cái đầu là thành công, phần còn lại nhận thông điệp lỗi tương ứng nếu có.
    entries.forEach((e, i) => {
      const thanhCong = i < imported;
      ketQua.push({
        email: e.email,
        target: 'agy',
        ok: thanhCong,
        ...(thanhCong ? {} : { loi: loi[i - imported] ?? loi[0] ?? 'import-bulk từ chối' }),
      });
    });
  }

  return ketQua;
}

/**
 * Gắn tên cho hàng Kiro vừa import, và gộp bản trùng của cùng account.
 *
 * Vì sao phải dọn thay vì chỉ đặt tên: `kiroImportSchema` không nhận `name`/`email` (gửi
 * lên bị strip) và OmniRoute để `null` với token social. Hàng không tên thì chỉ còn
 * `refreshToken` để nhận diện — mà token ĐỔI sau mỗi lần đăng nhập lại, nên OmniRoute luôn
 * coi đó là account mới và tạo thêm hàng. Đo thật: đăng nhập lại một account, 20 → 21.
 *
 * Trình tự: đặt tên cho hàng mới nhất (chưa có tên), rồi xoá mọi hàng CŨ cùng tên. Giữ hàng
 * mới vì nó mang token còn hạn.
 *
 * Cột `name`/`email` không mã hoá nên ghi thẳng an toàn. OmniRoute khác máy thì bỏ qua —
 * chỉ mất khả năng gộp, không hỏng gì.
 */
async function gomHangKiro(email: string): Promise<void> {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(`${process.env.HOME}/.omniroute/storage.sqlite`);

    // Token trong DB đã mã hoá nên không so trực tiếp được — hàng vừa chạm là hàng mới
    // nhất chưa có tên.
    db.prepare(
      `UPDATE provider_connections SET name = ?, email = ?
       WHERE id = (SELECT id FROM provider_connections
                   WHERE provider = 'kiro' AND (name IS NULL OR name = '')
                   ORDER BY updated_at DESC LIMIT 1)`,
    ).run(email, email);

    const bo = db.prepare(
      `DELETE FROM provider_connections
       WHERE provider = 'kiro' AND name = ?
         AND id <> (SELECT id FROM provider_connections
                    WHERE provider = 'kiro' AND name = ?
                    ORDER BY updated_at DESC LIMIT 1)`,
    ).run(email, email);
    if (bo.changes) logger.info('Gộp connection Kiro trùng', { email, bo: bo.changes });
  } catch {
    // OmniRoute khác máy → bỏ qua.
  }
}

/** Kiro: không có bulk, gọi lẻ từng credential. */
async function dongBoKiro(): Promise<KetQuaMot[]> {
  const creds = store.listCredentials().filter((c) => c.target === 'kiro');
  const ketQua: KetQuaMot[] = [];

  for (const c of creds) {
    const cred = parseKiroCredential(String(c.value ?? ''));
    if (!cred) {
      ketQua.push({ email: c.email, target: 'kiro', ok: false, loi: 'credential không đọc được' });
      continue;
    }
    try {
      await omniroute.importKiro(cred);
      await gomHangKiro(c.email);
      ketQua.push({ email: c.email, target: 'kiro', ok: true });
    } catch (e) {
      ketQua.push({
        email: c.email,
        target: 'kiro',
        ok: false,
        loi: (e instanceof Error ? e.message : String(e)).slice(0, 160),
      });
    }
  }

  return ketQua;
}

/**
 * Đồng bộ. `target` bỏ trống = cả hai provider.
 *
 * KHÔNG ném lỗi ra ngoài: OmniRoute là thành phần tuỳ chọn, nó hỏng thì agy-proxy vẫn phải
 * chạy bình thường. Đây chính là bài học từ lần tích hợp trước — lỗi OmniRoute lọt ra làm
 * ngập `run_logs` 303 dòng cảnh báo và cuối cùng cả tích hợp bị gỡ.
 */
/**
 * Khoá chống chạy chồng.
 *
 * Vòng nền và nút bấm tay có thể gọi `dongBo()` cùng lúc. Hai lượt chồng nhau thì cửa sổ
 * đổi tên `agy`↔`antigravity` của lượt này rơi vào giữa lượt kia: `import-bulk` không thấy
 * hàng cũ (đang mang tên bên kia) nên tạo bản mới. Đo thật: 20 email nở thành 25 rồi 40
 * hàng, log hiện rõ hai lượt xen kẽ nhau.
 *
 * Lượt sau dùng chung kết quả của lượt đang chạy — không xếp hàng, vì đồng bộ là thao tác
 * "đưa về trạng thái mới nhất", chạy hai lần liên tiếp không thêm giá trị gì.
 */
let dangChay: Promise<KetQuaDongBo> | null = null;

export async function dongBo(target?: 'agy' | 'kiro'): Promise<KetQuaDongBo> {
  if (dangChay) return dangChay;
  dangChay = dongBoThat(target).finally(() => {
    dangChay = null;
  });
  return dangChay;
}

async function dongBoThat(target?: 'agy' | 'kiro'): Promise<KetQuaDongBo> {
  /**
   * Nạp store nếu chưa có gì.
   *
   * `store.load()` KHÔNG tự chạy lúc import — server gọi nó ở `index.ts`, còn script chạy
   * độc lập thì không. Thiếu bước này `listCredentials()` trả rỗng và hàm báo "không có
   * credential nào" dù CSV có 694 dòng (đã bị đúng vậy khi chạy trên production).
   *
   * Chỉ nạp khi rỗng: trong server, store đã có sẵn và nạp lại là đọc đĩa thừa.
   */
  if (!store.listCredentials().length) store.load();

  if (!dangBat()) {
    return { ok: true, boQua: true, ketQua: [], chiTiet: 'chưa cấu hình mật khẩu OmniRoute' };
  }

  try {
    // Đăng nhập TRƯỚC khi lọc credential.
    //
    // Không có bước này thì store rỗng ⇒ không gọi mạng lần nào ⇒ `ok: true` dù OmniRoute
    // đã chết — báo thành công cho việc chưa hề xảy ra. Ép xác thực ngay khiến "đã bật
    // nhưng không kết nối được" luôn hiện thành thất bại, đúng thứ dashboard cần biết.
    await omniroute.ensureAuth();

    /**
     * Đổi tên bao quanh phần `agy` và CHỈ phần đó.
     *
     * `import-bulk` dedupe theo email trong nhóm provider `agy`, còn gateway lại phục vụ
     * dưới tên `antigravity` — nên phải đổi ngược trước, đổi xuôi ngay sau. Đặt hai mốc
     * này sát nhau là cố ý: lần trước tôi để `dongBoKiro()` chạy xen vào giữa, cửa sổ đó
     * đủ dài để vòng nền chen ngang và sinh 40 hàng cho 20 email.
     */
    const ketQua: KetQuaMot[] = [];
    if (!target || target === 'agy') {
      await doiTenProvider('antigravity', 'agy');
      try {
        ketQua.push(...(await dongBoAgy()));
      } finally {
        await doiTenProvider('agy', 'antigravity');
      }
    }
    if (!target || target === 'kiro') ketQua.push(...(await dongBoKiro()));

    // Chốt cuối: dọn bản trùng dù đổi tên có chạy hay không.
    await donTrungTheoEmail();

    /**
     * Đổi tên xuôi LẦN NỮA ở bước cuối cùng.
     *
     * Lần đổi trong `finally` phía trên chỉ bao phần `agy`, nên hàng còn sót lại từ lượt
     * TRƯỚC bị lỗi giữa chừng vẫn mang tên `agy`. Gateway phục vụ dưới tên `antigravity`
     * nên chúng vô hình: đo trên production thấy `agy 337 · kiro 349` mà gọi model trả
     * "No active credentials for provider: antigravity".
     *
     * Chạy lại ở cuối là idempotent — không còn hàng `agy` nào thì `changes = 0`.
     */
    await doiTenProvider('agy', 'antigravity');

    const agy = ketQua.filter((k) => k.target === 'agy');
    const kiro = ketQua.filter((k) => k.target === 'kiro');
    const phan: string[] = [];
    if (agy.length) phan.push(`agy ${tomTat(agy)}`);
    if (kiro.length) phan.push(`kiro ${tomTat(kiro)}`);
    const chiTiet = phan.join(' · ') || 'không có credential nào';

    const hong = ketQua.filter((k) => !k.ok);
    if (hong.length) {
      logger.warn('Đồng bộ OmniRoute có lỗi', { chiTiet, hong: hong.length, viDu: hong[0]?.loi });
    } else {
      logger.info('Đồng bộ OmniRoute xong', { chiTiet });
    }

    return { ok: hong.length === 0, ketQua, chiTiet };
  } catch (e) {
    const loi = e instanceof Error ? e.message : String(e);
    logger.warn('Bỏ qua đồng bộ OmniRoute', { loi: loi.slice(0, 200) });
    return { ok: false, ketQua: [], chiTiet: loi.slice(0, 200) };
  }
}

/** Trạng thái để dashboard hiển thị: OmniRoute đang có gì so với agy-proxy. */
export async function trangThai(): Promise<{
  bat: boolean;
  url: string;
  ketNoi: boolean;
  loi?: string;
  omniroute: Record<string, number>;
  agyproxy: Record<string, number>;
}> {
  const agyproxy: Record<string, number> = {};
  for (const c of store.listCredentials()) {
    agyproxy[c.target] = (agyproxy[c.target] ?? 0) + 1;
  }

  if (!dangBat()) {
    return { bat: false, url: config.omniroute.url, ketNoi: false, omniroute: {}, agyproxy };
  }

  try {
    const conns = await omniroute.listConnections();
    const dem: Record<string, number> = {};
    for (const c of conns) dem[c.provider] = (dem[c.provider] ?? 0) + 1;
    return { bat: true, url: config.omniroute.url, ketNoi: true, omniroute: dem, agyproxy };
  } catch (e) {
    return {
      bat: true,
      url: config.omniroute.url,
      ketNoi: false,
      loi: (e instanceof Error ? e.message : String(e)).slice(0, 200),
      omniroute: {},
      agyproxy,
    };
  }
}
