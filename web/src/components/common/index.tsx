import { useState, type ReactNode } from "react"
import { AlertTriangle, Loader2, type LucideIcon } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

export { DataTable, type Column } from "./DataTable"

/**
 * Component nền tảng dùng chung.
 * Trước đây KpiCard có 2 bản + 6 biến thể inline; xác nhận xoá có 4 kiểu khác nhau
 * (confirm() native, Dialog, inline 2 nút, 2-click); empty state mỗi trang một kiểu.
 */

// ── KPI ────────────────────────────────────────────────────────────────

export function KpiCard({
  label, value, sub, icon: Icon, tone = "default", loading,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  icon?: LucideIcon
  tone?: "default" | "success" | "warning" | "danger"
  loading?: boolean
}) {
  const toneCls = {
    default: "text-foreground",
    success: "text-[color:var(--success)]",
    warning: "text-[color:var(--warning)]",
    danger: "text-destructive",
  }[tone]

  return (
    <Card className="bg-card border-border">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground truncate">{label}</p>
            {loading ? (
              <Skeleton className="mt-1.5 h-7 w-20" />
            ) : (
              <p className={`mt-1 text-2xl font-semibold tabular-nums ${toneCls}`}>{value}</p>
            )}
            {sub ? <p className="mt-0.5 text-xs text-muted-foreground truncate">{sub}</p> : null}
          </div>
          {Icon ? <Icon className="h-4 w-4 shrink-0 text-muted-foreground" /> : null}
        </div>
      </CardContent>
    </Card>
  )
}

// ── Trạng thái ─────────────────────────────────────────────────────────

const STATUS_TONE: Record<string, string> = {
  ok: "bg-[color:var(--success)]/15 text-[color:var(--success)]",
  live: "bg-[color:var(--success)]/15 text-[color:var(--success)]",
  busy: "bg-primary/15 text-primary",
  cooldown: "bg-[color:var(--warning)]/15 text-[color:var(--warning)]",
  quota: "bg-[color:var(--warning)]/15 text-[color:var(--warning)]",
  error: "bg-destructive/15 text-destructive",
  dead: "bg-destructive/15 text-destructive",
  off: "bg-muted text-muted-foreground",
  unknown: "bg-muted text-muted-foreground",
}

/** Nhãn trạng thái thống nhất. Thay việc dùng emoji 🟢🔴⚪ ✓✕⏳ rải rác khắp app. */
export function StatusBadge({ status, label }: { status: keyof typeof STATUS_TONE | string; label?: string }) {
  const cls = STATUS_TONE[status] ?? STATUS_TONE.unknown
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium ${cls}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label ?? status}
    </span>
  )
}

// ── Khung trang / thẻ ──────────────────────────────────────────────────

export function PageHeader({ title, desc, actions }: { title: string; desc?: string; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        {desc ? <p className="mt-0.5 text-sm text-muted-foreground">{desc}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  )
}

export function ChartCard({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <Card className="bg-card border-border">
      <CardContent className="p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          {actions}
        </div>
        {children}
      </CardContent>
    </Card>
  )
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : String(error)
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12">
      <AlertTriangle className="h-8 w-8 text-destructive" />
      <p className="max-w-md text-center text-sm text-muted-foreground">{msg}</p>
      {onRetry ? (
        <button onClick={onRetry} className="h-8 rounded-md border border-border px-3 text-sm hover:bg-card">
          Thử lại
        </button>
      ) : null}
    </div>
  )
}

// ── Xác nhận hành động huỷ hoại ────────────────────────────────────────

/**
 * Hộp xác nhận thống nhất. `confirmText` bắt gõ đúng tên để tránh bấm nhầm —
 * dùng cho thu hồi API key, xoá account.
 */
export function ConfirmDialog({
  open, title, desc, confirmText, danger = true, onCancel, onConfirm, busy,
}: {
  open: boolean
  title: string
  desc?: ReactNode
  confirmText?: string
  danger?: boolean
  onCancel: () => void
  onConfirm: () => void
  busy?: boolean
}) {
  const [typed, setTyped] = useState("")
  if (!open) return null
  const ready = !confirmText || typed === confirmText

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onCancel}>
      <div
        className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        {desc ? <div className="mt-2 text-sm text-muted-foreground">{desc}</div> : null}

        {confirmText ? (
          <div className="mt-3">
            <p className="text-xs text-muted-foreground">
              Gõ <span className="font-mono text-foreground">{confirmText}</span> để xác nhận
            </p>
            <input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="mt-1.5 h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
            />
          </div>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onCancel} className="h-9 rounded-md border border-border px-3 text-sm hover:bg-background">
            Huỷ
          </button>
          <button
            onClick={onConfirm}
            disabled={!ready || busy}
            className={`inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm text-white disabled:opacity-40 ${
              danger ? "bg-destructive hover:opacity-90" : "bg-primary hover:opacity-90"
            }`}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Xác nhận
          </button>
        </div>
      </div>
    </div>
  )
}
