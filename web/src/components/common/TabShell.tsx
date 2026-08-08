import { useEffect, useState, type ReactNode } from "react"

/**
 * Khung tab cho các trang GỘP (Tài khoản, Cấu hình).
 *
 * Kế hoạch gộp 15 trang → 11: Tokens là *cột trạng thái* của account chứ không phải
 * một trang riêng; Connections và CLI Tools thuộc về Cấu hình. Gộp bằng tab thay vì
 * viết lại 4 trang đang chạy tốt — mỗi tab vẫn là component cũ, không sửa gì bên trong.
 *
 * Tab hiện tại ghi vào `?tab=` để F5 và link chia sẻ giữ nguyên vị trí — cùng nguyên
 * tắc đã dùng cho bộ lọc trang Báo cáo.
 */
export interface TabDef {
  key: string
  label: string
  icon?: ReactNode
  render: () => ReactNode
}

export function TabShell({ tabs, storageKey, initial }: { tabs: TabDef[]; storageKey: string; initial?: string }) {
  const read = () => {
    const q = new URLSearchParams(window.location.search).get("tab")
    if (tabs.some((t) => t.key === q)) return q!
    // Link cũ kiểu /tokens, /connections đi qua đây: route đặt tab khởi đầu,
    // không có thì về tab đầu tiên.
    if (initial && tabs.some((t) => t.key === initial)) return initial
    return tabs[0]!.key
  }
  const [active, setActive] = useState(read)

  // Back/forward của trình duyệt phải đổi tab theo, không chỉ đổi URL.
  useEffect(() => {
    const onPop = () => setActive(read())
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs])

  // Điều hướng sidebar/tab cũ khi hub ĐANG mở (component không remount):
  // /accounts → /tokens phải nhảy sang tab Tokens dù state đã có.
  useEffect(() => {
    if (initial && tabs.some((t) => t.key === initial)) setActive(initial)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial])

  const go = (k: string) => {
    const q = new URLSearchParams(window.location.search)
    if (k === tabs[0]!.key) q.delete("tab")
    else q.set("tab", k)
    const s = q.toString()
    window.history.replaceState(null, "", window.location.pathname + (s ? `?${s}` : ""))
    setActive(k)
  }

  const current = tabs.find((t) => t.key === active) ?? tabs[0]!

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label={storageKey}
        className="flex gap-1 overflow-x-auto border-b border-border pb-px"
      >
        {tabs.map((t) => {
          const on = t.key === current.key
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={on}
              onClick={() => go(t.key)}
              className={`-mb-px flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm transition-colors ${
                on
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          )
        })}
      </div>

      {/* Chỉ render tab đang mở — 700 account ở tab Tokens không nên chạy query nền
          khi người dùng đang xem tab khác. */}
      <div role="tabpanel">{current.render()}</div>
    </div>
  )
}
