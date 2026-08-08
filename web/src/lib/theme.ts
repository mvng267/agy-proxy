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

/** Áp class lên <html>. 'system' thì bỏ cả hai để CSS media query tự quyết. */
export function applyTheme(t: Theme): void {
  const el = document.documentElement
  el.classList.remove('light', 'dark')
  if (t !== 'system') el.classList.add(t)
  // Thanh địa chỉ trình duyệt / notch iOS tô theo màu này.
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) {
    const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
    meta.setAttribute('content', dark ? '#0a0a0f' : '#ffffff')
  }
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
