/**
 * Vòng quét hạn mức — phần thuần, không phụ thuộc pool/config để test được.
 *
 * Vì sao tách ra: bản cũ nằm thẳng trong `background.ts`, chạy TUẦN TỰ và mỗi account chờ
 * `waitWhileBusy()` tới 30 giây với điều kiện "TỔNG inflight toàn pool = 0". Với 700
 * account phục vụ liên tục thì điều kiện đó không bao giờ đúng, nên hàm biến thành
 * `sleep(30s)` cố định:
 *
 *   667 account × 30,5s ≈ 6 giờ/vòng     |     chu kỳ đặt: 240 phút
 *
 * Vòng không bao giờ kết thúc kịp chu kỳ kế. ĐO THẬT trên production 12/08/2026:
 * lần đo quota gần nhất là 28,3 giờ trước, 702/703 account có quota quá 24h.
 *
 * Hậu quả không nằm ở màn hình mà ở chất lượng phục vụ: engine chọn account bằng
 * `bucketPct()` — đọc đúng số quota cũ 28 giờ đó. 278/351 account cạn bể Gemini trong khi
 * 149 cái còn nguyên hạn mức Claude, nhưng traffic vẫn dồn vào Gemini.
 */

/** Account tối thiểu mà vòng quét cần biết. Cố ý hẹp để test không phải dựng pool thật. */
export interface QuotaLoopAccount {
  key: string;
  provider: string;
  health?: string;
}

export interface QuotaLoopDeps {
  /** Danh sách account cần xét (đã lọc enabled/autoDisable ở tầng gọi). */
  danhSach: () => QuotaLoopAccount[];
  /** Provider này có API hạn mức không. Kiro thì không — xem `pool.ts` `refreshQuota`. */
  coApiQuota: (a: QuotaLoopAccount) => boolean;
  /** Đo hạn mức thật (gọi mạng). Ném lỗi thì được đếm, không làm dừng vòng. */
  doQuota: (a: QuotaLoopAccount) => Promise<unknown>;
  /** Tổng số request đang chạy trong pool — dùng để nhường đường. */
  dangBan: () => number;
  /** Nghỉ giữa các lượt (tách ra để test không phụ thuộc thời gian thật). */
  nghi: (ms: number) => Promise<void>;
  ghiLog: (msg: string) => void;
}

export interface QuotaLoopOpts {
  /** Số luồng chạy song song. */
  song?: number;
  /** Nghỉ giữa hai account trong cùng một luồng — giãn nhịp để không tạo burst. */
  nghiMs?: number;
  /** Trên ngưỡng này thì coi là pool đang bận, tạm nhường đường. */
  tran?: number;
  /** Số lượt nhường tối đa trước khi cứ chạy — KHÔNG chờ vô hạn. */
  toiDaCho?: number;
  /** Mỗi lượt nhường chờ bao lâu. */
  choMs?: number;
}

export interface QuotaLoopKetQua {
  daDo: number;
  loi: number;
  boQua: number;
  ms: number;
}

/**
 * Nhường đường cho request thật.
 *
 * Ý định của bản cũ vẫn ĐÚNG và được giữ nguyên: job nền không được tranh băng thông với
 * client (đo thật: 7/20 request stream thất bại khi vòng refresh 700 account chạy cùng
 * tải). Chỉ đổi cách đo "bận" từ tuyệt đối (`=== 0`) sang NGƯỠNG.
 *
 * Và luôn có trần số lượt chờ — chờ vô hạn chính là bug cũ.
 */
export async function nhuongDuong(
  d: Pick<QuotaLoopDeps, 'dangBan' | 'nghi'>,
  o: { tran?: number; toiDaCho?: number; nghiMs?: number } = {},
): Promise<void> {
  const tran = o.tran ?? 4;
  const toiDa = o.toiDaCho ?? 10;
  for (let i = 0; i < toiDa; i++) {
    if (d.dangBan() <= tran) return;
    await d.nghi(o.nghiMs ?? 1_000);
  }
}

/** Chia đều `list` cho `n` luồng chạy song song, mỗi luồng rút việc kế tiếp khi xong. */
async function chaySongSong<T>(list: T[], n: number, viec: (x: T, i: number) => Promise<void>): Promise<void> {
  let i = 0;
  const luong = Array.from({ length: Math.max(1, Math.min(n, list.length)) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= list.length) return;
      await viec(list[idx]!, idx);
    }
  });
  await Promise.all(luong);
}

/**
 * Quét hạn mức cả pool. Trả về số liệu để tầng gọi log MỘT dòng tổng kết.
 *
 * Hai thay đổi so với bản cũ, theo thứ tự tác động:
 *   1. Loại provider không có API hạn mức (Kiro = 351/667 account trên production).
 *      Chúng vẫn tốn một lượt chờ đầy đủ rồi `refreshQuota` trả `undefined` ngay lập tức.
 *   2. Chạy song song thay vì tuần tự.
 */
export async function quetQuota(d: QuotaLoopDeps, o: QuotaLoopOpts = {}): Promise<QuotaLoopKetQua> {
  const batDau = Date.now();
  const tatCa = d.danhSach();

  const can: QuotaLoopAccount[] = [];
  let boQua = 0;
  for (const a of tatCa) {
    // 'dead' là hỏng vĩnh viễn (401/invalid_grant) — quota không cứu được.
    if (a.health === 'dead' || !d.coApiQuota(a)) { boQua++; continue; }
    can.push(a);
  }

  let daDo = 0, loi = 0;
  await chaySongSong(can, o.song ?? 6, async (a, i) => {
    /**
     * Nhường đường theo LÔ, không phải mỗi account.
     *
     * Nhường trước từng account thì với pool bận liên tục, mỗi account cõng thêm trọn số
     * lượt chờ — 352 account / 6 luồng × 10s vẫn là ~10 phút chỉ để chờ. Kiểm mỗi 25 account
     * là đủ để phát hiện tải tăng mà không biến vòng thành hàng đợi.
     */
    if (i % 25 === 0) await nhuongDuong(d, { tran: o.tran, toiDaCho: o.toiDaCho, nghiMs: o.choMs });
    try {
      await d.doQuota(a);
      daDo++;
    } catch {
      // Đếm chứ không nuốt: bốn chỗ `catch(() => {})` của bản cũ là lý do sự cố này ẩn
      // được 28 giờ — 703/703 account lỗi trông y hệt 703/703 thành công.
      loi++;
    }
    await d.nghi(o.nghiMs ?? 200);
  });

  const ms = Date.now() - batDau;
  if (daDo || loi) {
    d.ghiLog(`quét hạn mức: đã đo ${daDo} · lỗi ${loi} · bỏ qua ${boQua} · ${Math.round(ms / 1000)}s`);
  }
  return { daDo, loi, boQua, ms };
}
