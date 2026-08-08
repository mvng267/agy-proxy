import { useState, type ReactNode } from "react"
import { AlertTriangle, Loader2, type LucideIcon } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Sparkline } from "./Sparkline"
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
  delta, deltaTone = "auto", spark, sparkTone, corners = true, grid = true,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  icon?: LucideIcon
  tone?: "default" | "success" | "warning" | "danger"
  loading?: boolean
  /** Huy hiệu % thay đổi, kiểu Atlas. `dir` quyết định mũi tên. */
  delta?: { value: number; dir: "up" | "down" }
  /**
   * Tông của huy hiệu. `auto` = tăng xanh / giảm đỏ, nhưng PHẢI cho ghi đè vì
   * tăng không phải lúc nào cũng tốt — số lỗi tăng là xấu, account sống tăng là tốt.
   */
  deltaTone?: "auto" | "success" | "danger" | "warning" | "muted"
  /** Đường xu hướng nhỏ bên phải giá trị. */
  spark?: number[]
  sparkTone?: "current" | "success" | "warning" | "danger" | "info" | "muted"
  /** 4 dấu góc đặc trưng Atlas. */
  corners?: boolean
  /** Nền lưới mờ dần từ tâm, đặc trưng Atlas. */
  grid?: boolean
}) {
  const toneCls = {
    default: "text-foreground",
    success: "text-[color:var(--success)]",
    warning: "text-[color:var(--warning)]",
    danger: "text-destructive",
  }[tone]

  const dTone = deltaTone === "auto" ? (delta?.dir === "up" ? "success" : "danger") : deltaTone
  const deltaCls = {
    success: "bg-[color:var(--success)]/12 text-[color:var(--success)]",
    danger: "bg-destructive/12 text-destructive",
    warning: "bg-[color:var(--warning)]/12 text-[color:var(--warning)]",
    muted: "bg-muted text-muted-foreground",
  }[dTone]

  return (
    <Card className="relative overflow-hidden">
      {/* Nền lưới mờ dần từ tâm — chi tiết làm nên vẻ "telemetry" của Atlas. */}
      {grid ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.16] [mask-image:radial-gradient(72%_64%_at_50%_44%,black,transparent)]"
          style={{
            backgroundImage:
              "linear-gradient(to right, var(--border) 1px, transparent 1px), linear-gradient(to bottom, var(--border) 1px, transparent 1px)",
            backgroundSize: "16px 16px",
          }}
        />
      ) : null}

      {/* 4 dấu góc. Atlas dùng `border-foreground/65`; ở đây nhạt hơn cho đỡ ồn. */}
      {corners
        ? (
            [
              "top-0 left-0 border-t border-l",
              "top-0 right-0 border-t border-r",
              "bottom-0 left-0 border-b border-l",
              "bottom-0 right-0 border-b border-r",
            ] as const
          ).map((pos) => (
            <span key={pos} data-slot="kpi-corner" aria-hidden className={`pointer-events-none absolute size-2 border-foreground/40 ${pos}`} />
          ))
        : null}

      <CardContent className="relative z-10 p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 truncate text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </p>
          {Icon ? <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
        </div>

        <div className="mt-2 flex items-end justify-between gap-3">
          {loading ? (
            <Skeleton className="h-8 w-24" />
          ) : (
            <p className={`text-[1.75rem] font-semibold leading-none tabular-nums ${toneCls}`}>{value}</p>
          )}
          {spark?.length ? <Sparkline data={spark} tone={sparkTone ?? "current"} className={toneCls} /> : null}
        </div>

        {delta || sub ? (
          <div className="mt-3 flex items-center gap-2 border-t border-border pt-2.5">
            {delta ? (
              <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular-nums ${deltaCls}`}>
                {delta.dir === "up" ? "+" : "−"}
                {Math.abs(delta.value)}%
              </span>
            ) : null}
            {sub ? <span className="min-w-0 truncate text-xs text-muted-foreground">{sub}</span> : null}
          </div>
        ) : null}
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
      <div className="min-w-0">
        {/* 16px/600 + mô tả 14px — số đo từ Atlas, không phải text-lg. */}
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
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
