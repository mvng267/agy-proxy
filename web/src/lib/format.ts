/**
 * Hàm định dạng dùng chung.
 * Trước đây `fmtNum` được viết lại 4 lần và `fmtAgo` 3 lần ở các trang khác nhau,
 * nên chúng đã bắt đầu phân kỳ (chỗ trả "—", chỗ trả "0").
 */

/** 1234567 → "1.2M", 1234 → "1.2k". Rỗng/undefined → "—". */
export function fmtNum(n: number | undefined | null): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Khoảng cách tới hiện tại: "3s" / "5m" / "2h" / "4d". 0 hoặc undefined → "—". */
export function fmtAgo(ms?: number | null): string {
  if (!ms) return '—';
  const d = Date.now() - ms;
  if (d < 0) return 'vừa xong';
  if (d < 60_000) return `${Math.max(1, Math.round(d / 1000))}s`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h`;
  return `${Math.round(d / 86_400_000)}d`;
}

/** Đếm ngược tới mốc tương lai: "2m 30s". Đã qua → "—". */
export function fmtUntil(ms?: number | null): string {
  if (!ms) return '—';
  const d = ms - Date.now();
  if (d <= 0) return '—';
  const s = Math.round(d / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** 0..100 → "87%". null → "—" (chưa biết, KHÁC với 0%). */
export function fmtPct(p?: number | null): string {
  if (p == null) return '—';
  return `${Math.round(p)}%`;
}

/** Mili giây → "820ms" / "2.1s". */
export function fmtMs(ms?: number | null): string {
  if (ms == null) return '—';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
