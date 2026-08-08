import type { ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

/**
 * Thẻ nhỏ dùng cho dòng log — một bộ tông màu DÙNG CHUNG cho mọi nơi hiển thị log.
 *
 * Trước đây Live Log tự viết hai hàm `typeColor`/`typeBadgeClass` với màu hard-code,
 * nên thêm loại thẻ mới (api key, combo…) là phải sửa cả hai và dễ lệch tông. Gom về
 * đây để trang nào cũng đọc cùng một bảng màu.
 */

export type TagTone = "req" | "ok" | "err" | "warn" | "quota" | "model" | "account" | "key" | "combo" | "muted"

const TONE: Record<TagTone, string> = {
  req: "bg-info/15 text-info",
  ok: "bg-success/15 text-success",
  err: "bg-destructive/15 text-destructive",
  warn: "bg-warning/15 text-warning",
  quota: "bg-primary/15 text-primary",
  // Ba loại "danh tính" (model / account / api key) cố ý KHÁC tông nhau rõ rệt: một
  // dòng log có cả ba, cùng tông thì mắt phải đọc chữ mới phân biệt được.
  model: "bg-info/15 text-info",
  account: "bg-info/15 text-info",
  key: "bg-info/15 text-info",
  combo: "bg-info/15 text-info",
  muted: "bg-muted/60 text-foreground",
}

export function LogTag({
  tone = "muted",
  icon,
  label,
  value,
  title,
  className,
}: {
  tone?: TagTone
  icon?: ReactNode
  /** Nhãn loại thẻ (vd "model"). Bỏ trống khi giá trị đã tự nói lên nó là gì. */
  label?: string
  value: ReactNode
  title?: string
  className?: string
}) {
  return (
    <Badge
      title={title}
      className={cn(
        "h-5 shrink-0 gap-1 rounded px-1.5 text-[10px] font-medium leading-none",
        TONE[tone],
        className,
      )}
    >
      {icon}
      {label ? <span className="opacity-60">{label}</span> : null}
      <span className="max-w-[22ch] truncate">{value}</span>
    </Badge>
  )
}

/** Tông theo HTTP status — dùng chung cho Live Log và các bảng có cột status. */
export function statusTone(status?: number): TagTone {
  if (!status) return "muted"
  if (status === 429 || status === 402) return "quota"
  if (status >= 500) return "err"
  if (status >= 400) return "warn"
  return "ok"
}
