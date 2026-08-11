/**
 * Logic lọc của Live Log — tách khỏi component để test được mà không cần dựng DOM.
 *
 * Vì sao tách: bản trước có HAI danh sách bộ lọc viết tay ở hai chỗ (`shown` lọc theo 6
 * tiêu chí, `filtering` chỉ kể 4). Chúng lệch nhau, và hậu quả rơi đúng vào lúc cần nhất:
 * lọc theo mã 429 mà không dòng nào khớp → màn hình trống, số đếm báo "500 dòng" thay vì
 * "lọc: 0/500", và KHÔNG có nút "Bỏ lọc" để thoát ra. `clearFilters` cũng sót 2 tiêu chí
 * nên bấm "Bỏ lọc" xong mã lỗi vẫn còn nguyên.
 *
 * Giờ cả ba đọc CHUNG một `BoLoc`, nên thêm tiêu chí mới mà quên chỗ nào là TypeScript
 * báo lỗi ngay, không đợi tới lúc chạy.
 */

export type Kind = 'req' | 'res' | 'err' | 'check' | 'info'

/** Chỉ những trường bộ lọc CẦN cho việc lọc — không phải cả Entry của component. */
export interface DongLog {
  kind: Kind
  msg: string
  model?: string
  account?: string
  apiKey?: string
  combo?: string
  status?: number
}

export interface BoLoc {
  kinds: Set<Kind>
  model: string
  apiKey: string
  status: string
  account: string
  q: string
}

export const BO_LOC_RONG: BoLoc = {
  kinds: new Set(),
  model: '',
  apiKey: '',
  status: '',
  account: '',
  q: '',
}

/** Có đang lọc gì không — quyết định hiện nút "Bỏ lọc" và cách hiển thị số đếm. */
export function dangLoc(f: BoLoc): boolean {
  return (
    f.kinds.size > 0 ||
    !!f.model ||
    !!f.apiKey ||
    !!f.status ||
    !!f.account ||
    !!f.q.trim()
  )
}

/** Lọc danh sách dòng log theo bộ lọc. */
export function loLoc<T extends DongLog>(dong: readonly T[], f: BoLoc): T[] {
  const needle = f.q.trim().toLowerCase()
  return dong.filter((e) => {
    if (f.kinds.size && !f.kinds.has(e.kind)) return false
    if (f.model && e.model !== f.model) return false
    if (f.apiKey && e.apiKey !== f.apiKey) return false
    // So sánh dạng chuỗi vì giá trị từ <Select> luôn là chuỗi. `?? ''` để dòng không có
    // status không bao giờ khớp với một mã cụ thể.
    if (f.status && String(e.status ?? '') !== f.status) return false
    if (f.account && e.account !== f.account) return false
    if (needle) {
      const hay = `${e.msg} ${e.model ?? ''} ${e.account ?? ''} ${e.apiKey ?? ''} ${e.combo ?? ''}`
      if (!hay.toLowerCase().includes(needle)) return false
    }
    return true
  })
}
