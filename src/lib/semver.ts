/**
 * Tính version kế tiếp từ danh sách commit — phần THUẦN của `scripts/release.mjs`.
 *
 * Vì sao cần: version là thứ người ta quên bump. Đo ngày 12/08/2026, 8 commit liên tiếp —
 * kể cả bản vá vòng quota tắc 28 giờ trên production — đều giữ nguyên `2.18.1`. Nút Cập
 * nhật trên dashboard so version nên báo "đã là bản mới nhất" suốt.
 *
 * `checkUpdate()` nay so theo commit SHA nên không còn phụ thuộc vào việc nhớ bump. Nhưng
 * version vẫn đáng đúng: nó là thứ người đọc thấy, và npm cần nó để phát hành.
 */

export type MucTang = 'major' | 'minor' | 'patch' | null;

/**
 * Commit này đòi tăng mức nào?
 *
 * Theo Conventional Commits: `feat:` → minor, `fix:` → patch, `BREAKING CHANGE`/`!:` →
 * major. Những loại còn lại (`refactor`, `test`, `chore`, `docs`) KHÔNG tăng — chúng
 * không đổi hành vi mà người dùng thấy.
 */
export function mucTangCua(tieuDe: string): MucTang {
  const s = tieuDe.trim();
  // `feat!:` hoặc `fix(scope)!:` — dấu ! ngay trước dấu hai chấm là phá vỡ tương thích.
  if (/^[a-z]+(\([^)]*\))?!:/i.test(s) || /BREAKING[ -]CHANGE/.test(s)) return 'major';
  if (/^feat(\([^)]*\))?:/i.test(s)) return 'minor';
  if (/^fix(\([^)]*\))?:/i.test(s)) return 'patch';
  return null;
}

/** Mức cao nhất trong cả loạt commit. Không commit nào đòi tăng thì trả null. */
export function mucTangGop(tieuDes: string[]): MucTang {
  let ket: MucTang = null;
  for (const t of tieuDes) {
    const m = mucTangCua(t);
    if (m === 'major') return 'major'; // cao nhất rồi, khỏi xét tiếp
    if (m === 'minor') ket = 'minor';
    else if (m === 'patch' && ket !== 'minor') ket = 'patch';
  }
  return ket;
}

/**
 * Version kế tiếp. Trả nguyên bản cũ nếu không có gì đáng tăng.
 *
 * Quy tắc semver: tăng minor thì patch về 0, tăng major thì cả minor lẫn patch về 0 —
 * quên phần này là ra `2.19.1` thay vì `2.19.0`.
 */
export function versionKeTiep(hienTai: string, muc: MucTang): string {
  if (!muc) return hienTai;
  const [a = 0, b = 0, c = 0] = hienTai.split('.').map(Number);
  if (muc === 'major') return `${a + 1}.0.0`;
  if (muc === 'minor') return `${a}.${b + 1}.0`;
  return `${a}.${b}.${c + 1}`;
}
