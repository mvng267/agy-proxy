import { useCallback, useState, type ReactNode } from "react"
import { Check, Copy } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Copy vào clipboard — MỘT bản dùng chung.
 *
 * Trước đây 9 chỗ tự viết lại logic này với 4 kiểu phản hồi khác nhau: icon đổi 2 giây,
 * toast, không có gì, và `.catch(() => {})` nuốt lỗi im lặng.
 *
 * Vì sao phải có fallback chứ không chỉ gọi `navigator.clipboard`:
 * API đó CHỈ tồn tại trong "secure context" — HTTPS hoặc localhost. Production chạy
 * `http://100.112.240.4:7788` (IP thuần, không HTTPS) nên `navigator.clipboard` là
 * `undefined` — tức đường fallback là đường chạy THẬT hằng ngày, không phải trường hợp hiếm.
 * Bản cũ ở `Proxy.tsx` nuốt lỗi nên người dùng bấm copy, dán ra giá trị cũ, và không hề biết.
 */

export type CopyState = "idle" | "ok" | "error"

/** Ghi vào clipboard, trả về true nếu thành công. Không ném lỗi. */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* rơi xuống fallback bên dưới */
  }
  // Fallback cho ngữ cảnh không bảo mật (HTTP + IP). `execCommand` đã bị đánh dấu lỗi thời
  // nhưng vẫn là cách duy nhất chạy được ở đó, và mọi trình duyệt hiện tại còn hỗ trợ.
  try {
    const ta = document.createElement("textarea")
    ta.value = text
    // Ngoài khung nhìn nhưng KHÔNG `display:none` — phần tử ẩn hẳn thì không select được.
    ta.style.cssText = "position:fixed;top:-9999px;opacity:0"
    ta.setAttribute("readonly", "")
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand("copy")
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/**
 * Hook copy kèm trạng thái phản hồi.
 *
 * `getText` là HÀM chứ không phải chuỗi, để phục vụ trường hợp giá trị thật phải lấy về
 * ngay lúc bấm — ví dụ token đang bị che trên màn hình, phải gọi `?reveal=1` mới có bản
 * nguyên văn. Trước đây logic đó bị lặp ở `CLITools` và `Settings`.
 */
export function useCopy(resetMs = 2000) {
  const [state, setState] = useState<CopyState>("idle")

  const copy = useCallback(
    async (value: string | (() => string | Promise<string>)) => {
      let text = ""
      try {
        text = typeof value === "function" ? await value() : value
      } catch {
        setState("error")
        setTimeout(() => setState("idle"), resetMs)
        return false
      }
      const ok = await writeClipboard(text)
      setState(ok ? "ok" : "error")
      setTimeout(() => setState("idle"), resetMs)
      return ok
    },
    [resetMs],
  )

  return { state, copy }
}

/**
 * Nút copy dùng chung. Mặc định chỉ icon; truyền `label` để có cả chữ.
 * Báo lỗi rõ khi thất bại thay vì im lặng.
 */
export function CopyButton({
  value,
  label,
  title = "Sao chép",
  className,
  size = "sm",
}: {
  value: string | (() => string | Promise<string>)
  label?: ReactNode
  title?: string
  className?: string
  size?: "sm" | "xs"
}) {
  const { state, copy } = useCopy()
  const icon = size === "xs" ? "size-3" : "size-3.5"

  return (
    <button
      type="button"
      onClick={() => copy(value)}
      title={state === "error" ? "Không sao chép được — hãy bôi đen rồi Ctrl+C" : title}
      aria-label={typeof label === "string" ? label : title}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md text-muted-foreground transition-colors hover:text-foreground",
        label ? "px-2 py-1 text-xs hover:bg-muted" : "p-1",
        state === "error" && "text-destructive hover:text-destructive",
        className,
      )}
    >
      {state === "ok" ? <Check className={cn(icon, "text-success")} /> : <Copy className={icon} />}
      {label ? (
        <span>{state === "ok" ? "Đã chép" : state === "error" ? "Lỗi" : label}</span>
      ) : null}
    </button>
  )
}

/**
 * Khối mã có nút copy ở góc. Chuyển lên từ `CLITools.tsx` (bản tốt nhất trong 9 bản cũ)
 * để mọi trang dùng chung.
 */
export function CodeBlock({
  code,
  lang = "bash",
  className,
}: {
  code: string
  lang?: string
  className?: string
}) {
  return (
    <div className={cn("relative overflow-hidden rounded-xl border border-border bg-background", className)}>
      <div className="flex items-center justify-between border-b border-border bg-card/50 px-4 py-1.5">
        <span className="font-mono text-[10px] uppercase text-muted-foreground">{lang}</span>
        <CopyButton value={code} label="Copy" size="xs" />
      </div>
      <pre className="overflow-x-auto p-4 text-xs leading-relaxed whitespace-pre text-foreground">
        <code>{code}</code>
      </pre>
    </div>
  )
}

/**
 * Một dòng "nhãn — giá trị — nút copy". Dùng cho box kết nối: Base URL, API key, model…
 * `masked` để hiện bản che mà vẫn copy được giá trị thật.
 */
export function CopyRow({
  label,
  value,
  display,
  mono = true,
  action,
}: {
  label: string
  /** Giá trị thật để copy — có thể là hàm nếu phải lấy về lúc bấm. */
  value: string | (() => string | Promise<string>)
  /** Chuỗi hiển thị; bỏ trống thì hiện chính `value` (khi nó là chuỗi). */
  display?: string
  mono?: boolean
  action?: ReactNode
}) {
  const shown = display ?? (typeof value === "string" ? value : "—")
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-28 shrink-0 text-xs text-muted-foreground">{label}</span>
      <code
        className={cn(
          "min-w-0 flex-1 truncate rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground",
          mono && "font-mono",
        )}
        title={shown}
      >
        {shown}
      </code>
      {action}
      <CopyButton value={value} />
    </div>
  )
}
