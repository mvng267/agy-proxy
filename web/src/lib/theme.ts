/**
 * Chế độ sáng/tối.
 *
 * Ba trạng thái chứ không phải hai: 'dark' | 'light' là người dùng CHỌN, 'system' là
 * chưa chọn và đi theo hệ điều hành. Gộp thành boolean sẽ mất trạng thái thứ ba — máy
 * đổi sang tối buổi tối thì dashboard không đổi theo.
 */
export type Theme = 'light' | 'dark' | 'system'

const KEY = 'agy_theme'

export function getTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

/**
 * Áp class lên <html>. LUÔN đặt đúng một trong hai class, kể cả chế độ 'system'.
 *
 * Trước đây 'system' bỏ cả hai class rồi phó thác cho `@media (prefers-color-scheme)` trong
 * CSS — nhưng khối media đó là bản sao 38 dòng của `.dark`, sửa một bên quên bên kia là lệch
 * theme. Nay JS tự quy 'system' về dark/light (đã có sẵn listener theo dõi hệ điều hành ở
 * initTheme), nên CSS chỉ cần MỘT khối `.dark` — nguồn sự thật duy nhất.
 */
export function applyTheme(t: Theme): void {
  const el = document.documentElement
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  el.classList.remove('light', 'dark')
  el.classList.add(dark ? 'dark' : 'light')
  // Thanh địa chỉ trình duyệt / notch iOS tô theo màu này.
  const meta = document.querySelector('meta[name="theme-color"]')
  // Hex cứng CÓ CHỦ ĐÍCH: trình duyệt đọc thuộc tính HTML này để tô thanh địa chỉ / notch,
  // nó không phân giải được `var(--background)`. Giá trị khớp --background của hai chế độ.
  if (meta) meta.setAttribute('content', dark ? '#0a0a0a' : '#ffffff')
}

export function setTheme(t: Theme): void {
  try {
    if (t === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, t)
  } catch {
    /* chế độ riêng tư chặn localStorage — vẫn áp cho phiên này */
  }
  applyTheme(t)
}

/**
 * Gọi sớm nhất có thể. Trả hàm huỷ đăng ký.
 *
 * Phải theo dõi thay đổi của HỆ ĐIỀU HÀNH: ở chế độ 'system', máy chuyển sang tối lúc
 * hoàng hôn thì dashboard đang mở cũng phải đổi theo, không đợi tải lại trang.
 */
export function initTheme(): () => void {
  applyTheme(getTheme())
  const mq = matchMedia('(prefers-color-scheme: dark)')
  const onChange = () => {
    if (getTheme() === 'system') applyTheme('system')
  }
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}
