import { useEffect, useState, useCallback } from "react"
import { KpiCard, PageHeader } from "@/components/common"
import { DonutStat, Sparkline, TimeSeries } from "@/components/common/charts"
import {
  Gauge,
  RefreshCw,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Search,
  LayoutGrid,
  Table2,
  ChevronLeft,
  ChevronRight,
} from "lucide-react"
import { DataTable } from "@/components/common/DataTable"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"

// ── Types ──────────────────────────────────────────────────────────────

interface QuotaGroup {
  name: string
  pct: number
  resetTime?: string
}

interface QuotaModel {
  id: string
  pct: number
}

interface AccountQuota {
  groups?: QuotaGroup[]
  models?: QuotaModel[]
  tier?: string
}

interface PoolAccount {
  email: string
  provider?: string
  enabled?: boolean
  geminiPct?: number
  quota?: AccountQuota
}

// ── Helpers ───────────────────────────────────────────────────────────

function fmtReset(iso?: string) {
  if (!iso) return "—"
  const d = new Date(iso).getTime() - Date.now()
  if (d <= 0) return "đã reset"
  const days = Math.floor(d / 86400000)
  const hrs = Math.floor((d % 86400000) / 3600000)
  return days > 0 ? `${days}d ${hrs}h` : `${hrs}h`
}

function qColor(pct?: number) {
  if (pct == null) return "text-muted-foreground"
  if (pct >= 50) return "text-success"
  if (pct >= 20) return "text-warning"
  return "text-destructive"
}

function claudePct(a: PoolAccount): number | null {
  const g = a.quota?.groups?.find(x => !/gemini/i.test(x.name))
  return g ? g.pct : null
}

// ── Donut Chart ────────────────────────────────────────────────────────

/**
 * Nhãn trục x cho biểu đồ xu hướng.
 *
 * Backend trả hai dạng tuỳ mức gộp: `2026-08-08` (ngày) hoặc `2026-08-08 14:00` (giờ) —
 * và với lịch sử 1 account thì `ts` là epoch. Trục hẹp nên rút còn `08/08` / `14:00`,
 * in nguyên chuỗi sẽ chồng chữ lên nhau.
 */
function fmtBucket(b: string | number): string {
  const s = String(b)
  const hour = s.match(/^\d{4}-\d{2}-\d{2}[ T](\d{2}):/)
  if (hour) return `${hour[1]}:00`
  const day = s.match(/^\d{4}-(\d{2})-(\d{2})$/)
  if (day) return `${day[2]}/${day[1]}`
  const n = Number(b)
  if (Number.isFinite(n) && n > 0) {
    const d = new Date(n)
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`
  }
  return s
}

// ── Quota Bar ─────────────────────────────────────────────────────────

function QuotaBar({ pct }: { pct?: number }) {
  if (pct == null) return <span className="text-xs text-muted-foreground">—</span>
  const color = pct >= 50 ? "bg-success" : pct >= 20 ? "bg-warning" : "bg-destructive"
  return (
    <div className="flex items-center gap-2 min-w-[80px]">
      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <span className={`text-xs tabular-nums ${qColor(pct)}`}>{pct}%</span>
    </div>
  )
}

// ── Quota Page ─────────────────────────────────────────────────────────

export function Quota() {
  const [accounts, setAccounts] = useState<PoolAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // History
  const [historyData, setHistoryData] = useState<{
    series?: Array<{ bucket: string; gemini?: number; third?: number }>
    points?: Array<{ ts: string; gemini_pct?: number; third_pct?: number }>
  } | null>(null)
  const [histRange, setHistRange] = useState("7d")
  const [histEmail, setHistEmail] = useState<string | null>(null)

  // UI state
  const [viewMode, setViewMode] = useState<"table" | "card">(() =>
    (localStorage.getItem("vs_quotaMode") === "card" ? "card" : "table")
  )
  const [search, setSearch] = useState("")
  const [sortBy, setSortBy] = useState<"email" | "quota-high" | "quota-low">(() =>
    (localStorage.getItem("vs_quotaSort") ?? "quota-high") as "email" | "quota-high" | "quota-low"
  )
  const [page, setPage] = useState(1)
  // DataTable tự quản số dòng/trang ở chế độ bảng; chế độ thẻ vẫn dùng con số này.
  const [pageSize] = useState<number>(() => Number(localStorage.getItem("vs_quotaSize") || 25))
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // Per-account refresh spinning
  const [refreshing, setRefreshing] = useState<Record<string, boolean>>({})
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())

  // Bulk refresh state
  const [bulkRefreshing, setBulkRefreshing] = useState(false)

  // Toast
  const [toast, setToast] = useState<string | null>(null)
  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 2600) }

  const fetchAccounts = useCallback(async () => {
    try {
      // ?withModels=1: trang này CẦN chi tiết từng model. Payload mặc định đã cắt
      // quota.models[] vì nó chiếm 62% kích thước mà chỉ trang này dùng.
      const res = await fetch("/api/gateway/accounts?withModels=1")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as { accounts: PoolAccount[] }
      setAccounts(json.accounts ?? [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch")
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchHistory = useCallback(async (email: string | null, range: string) => {
    try {
      const q = email
        ? `?email=${encodeURIComponent(email)}&range=${range}`
        : `?range=${range}`
      const res = await fetch("/api/gateway/quota/history" + q)
      if (!res.ok) return
      const data = await res.json()
      setHistoryData(data)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    fetchAccounts()
    const interval = setInterval(fetchAccounts, 30_000)
    return () => clearInterval(interval)
  }, [fetchAccounts])

  useEffect(() => {
    fetchHistory(histEmail, histRange)
  }, [fetchHistory, histEmail, histRange])

  // ── Per-account quota refresh
  const handleRefreshOne = async (email: string) => {
    setRefreshing(prev => ({ ...prev, [email]: true }))
    try {
      const res = await fetch(`/api/gateway/quota/${encodeURIComponent(email)}`, { method: "POST" })
      const data = await res.json() as { ok?: boolean; quota?: AccountQuota; error?: string }
      if (data.ok && data.quota) {
        const geminiPct = data.quota.groups?.find(g => /gemini/i.test(g.name))?.pct
        setAccounts(prev => prev.map(a =>
          a.email === email ? { ...a, quota: data.quota, geminiPct } : a
        ))
        showToast("Đã nạp " + email.split("@")[0])
      } else {
        showToast("Lỗi: " + (data.error ?? "unknown"))
      }
    } finally {
      setRefreshing(prev => ({ ...prev, [email]: false }))
    }
  }

  // ── Bulk refresh
  const handleBulkRefresh = async () => {
    setBulkRefreshing(true)
    try {
      const emails = selected.size > 0 ? [...selected] : []
      const res = await fetch("/api/gateway/quota/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(emails.length > 0 ? { emails } : {}),
      })
      const data = await res.json() as { queued?: number }
      showToast(`Đang nạp hạn mức ${data.queued ?? "?"} account (nền)…`)
    } finally {
      setBulkRefreshing(false)
    }
  }

  // ── Filter / sort / paginate
  const filtered = accounts.filter(a =>
    !search || a.email.toLowerCase().includes(search.toLowerCase())
  )

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "email") return a.email.localeCompare(b.email)
    if (sortBy === "quota-low") return (a.geminiPct ?? 101) - (b.geminiPct ?? 101)
    return (b.geminiPct ?? -1) - (a.geminiPct ?? -1)
  })

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const pageRows = sorted.slice((safePage - 1) * pageSize, safePage * pageSize)

  const toggleExpand = (email: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev); if (next.has(email)) next.delete(email); else next.add(email); return next
    })
  }

  const setViewAndSave = (mode: "table" | "card") => {
    setViewMode(mode); localStorage.setItem("vs_quotaMode", mode)
  }
  const setSortAndSave = (s: typeof sortBy) => {
    setSortBy(s); localStorage.setItem("vs_quotaSort", s); setPage(1)
  }

  // Avg stats
  const withQ = accounts.filter(a => a.quota)
  const avgGemini = withQ.length ? Math.round(withQ.reduce((s, a) => s + (a.geminiPct ?? 0), 0) / withQ.length) : null
  const avgClaude = withQ.length ? Math.round(withQ.reduce((s, a) => s + (claudePct(a) ?? 0), 0) / withQ.length) : null

  // Chỉ còn dùng cho dòng tóm tắt xu hướng ở cuối trang; biểu đồ đọc `histSeries`.
  const histPoints: number[] = historyData?.series?.map(x => x.gemini ?? 0) ??
    historyData?.points?.map(p => p.gemini_pct ?? 0) ?? []

  /**
   * Dữ liệu cho biểu đồ xu hướng — GIỮ nhãn thời gian.
   *
   * Bản cũ map thẳng thành mảng số rồi ném vào sparkline 500×60 cố định, tức là vứt bỏ
   * `bucket` — nên không có trục, không nhãn thời gian, không tooltip, và không co giãn
   * theo bề rộng. Có bộ chọn 7/30/90 ngày mà nhìn vào không biết điểm nào là ngày nào.
   */
  const histSeries = (historyData?.series
    ? historyData.series.map((x) => ({ t: fmtBucket(x.bucket), gemini: x.gemini ?? null, third: x.third ?? null }))
    : historyData?.points?.map((p) => ({ t: fmtBucket(p.ts), gemini: p.gemini_pct ?? null, third: p.third_pct ?? null }))
  ) ?? []

  // ── Loading / Error ──────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-4">
        <PageHeader title="Hạn mức" desc="Quota còn lại theo từng account và lịch sử tiêu thụ" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-48 w-full bg-muted" />)}
        </div>
        <Skeleton className="h-64 w-full bg-muted" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <AlertTriangle className="h-8 w-8 text-destructive" />
        <p className="text-sm text-muted-foreground">Error: {error}</p>
        <button onClick={fetchAccounts} className="text-xs text-warning hover:text-warning flex items-center gap-1.5">
          <RefreshCw className="h-3 w-3" /> Retry
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Hạn mức" desc="Quota còn lại theo từng account và lịch sử tiêu thụ" />
      {toast && (
        <div className="fixed bottom-4 right-4 z-50 bg-muted border border-border text-foreground text-sm px-4 py-2 rounded-lg shadow-lg">
          {toast}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Gauge className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium text-foreground">Hạn mức — {withQ.length}/{accounts.length} đã nạp</h2>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={handleBulkRefresh}
            disabled={bulkRefreshing}
            className="border border-border bg-transparent text-muted-foreground hover:text-warning h-7 text-xs gap-1"
          >
            {bulkRefreshing ? <RefreshCw className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            {selected.size > 0 ? `Refresh ${selected.size} đã chọn` : "Refresh All"}
          </Button>
          <Button size="sm" onClick={fetchAccounts} className="border border-border bg-transparent text-muted-foreground hover:text-foreground h-7 text-xs gap-1">
            <RefreshCw className="h-3 w-3" /> Tải lại
          </Button>
        </div>
      </div>

      {/* Stats KPI */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* KpiCard chung — hai thẻ bên phải giữ Card tay vì chứa donut, không phải KPI thuần. */}
        <KpiCard
          label="Đã nạp"
          value={`${withQ.length} / ${accounts.length}`}
          sub={accounts.length ? `${Math.round((withQ.length / accounts.length) * 100)}% pool` : undefined}
          icon={Gauge}
          loading={loading}
        />
        <Card className="bg-card border-border">
          <CardContent className="pt-4 flex items-center gap-4">
            {avgGemini != null && <DonutStat label="Gemini TB" pct={avgGemini} tone="success" size={80} strokeWidth={8} />}
            <div className="flex-1">
              <QuotaBar pct={avgGemini ?? undefined} />
              <p className="text-[10px] text-muted-foreground mt-1">Trung bình pool</p>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="pt-4 flex items-center gap-4">
            {avgClaude != null && <DonutStat label="Claude TB" pct={avgClaude} tone="info" size={80} strokeWidth={8} />}
            <div className="flex-1">
              <QuotaBar pct={avgClaude ?? undefined} />
              <p className="text-[10px] text-muted-foreground mt-1">Trung bình pool</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* History chart */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium text-foreground flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              {histEmail ? `Xu hướng · ${histEmail}` : "Xu hướng toàn pool"}
            </CardTitle>
            <div className="flex items-center gap-2">
              {histEmail && (
                <Button size="sm" onClick={() => setHistEmail(null)} className="border border-border bg-transparent text-muted-foreground h-7 text-xs">
                  Xem tất cả
                </Button>
              )}
              <select
                value={histRange}
                onChange={e => setHistRange(e.target.value)}
                className="h-7 px-2 rounded bg-muted border border-border text-foreground text-xs focus:outline-none"
              >
                <option value="7d">7 ngày</option>
                <option value="30d">30 ngày</option>
                <option value="90d">90 ngày</option>
              </select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {histSeries.length >= 2 ? (
            <TimeSeries
              data={histSeries}
              xKey="t"
              height={200}
              series={[
                { key: "gemini", label: "Gemini", color: "var(--chart-success)" },
                { key: "third", label: "Claude/GPT", color: "var(--chart-info)" },
              ]}
            />
          ) : (
            <p className="py-8 text-center text-xs text-muted-foreground">
              {histSeries.length === 1
                ? "Mới có 1 mốc thời gian — cần ít nhất 2 mốc mới vẽ được đường. Job nền nạp hạn mức mỗi 4 giờ."
                : "Chưa có dữ liệu. Bấm Refresh để nạp hạn mức — mỗi lần nạp ghi 1 điểm."}
            </p>
          )}
          {/*
            Xu hướng gần nhất + sparkline.

            Bản cũ có LOGIC NGƯỢC: `histPoints` là phần trăm quota CÒN LẠI (xem `qColor` —
            pct cao là xanh/khoẻ), nhưng nó báo "Quota đang giảm" khi con số TĂNG. Người đọc
            thấy mũi tên đỏ đúng lúc hạn mức vừa hồi lại.

            Và mũi tên một mình không cho biết mức độ: giảm 1% với giảm 40% cùng một icon.
            Thêm sparkline để thấy hình dạng thật của xu hướng.
          */}
          {histPoints.length >= 2 && (() => {
            const last = histPoints[histPoints.length - 1]!
            const prev = histPoints[histPoints.length - 2]!
            const up = last > prev
            const delta = Math.abs(Math.round(last - prev))
            return (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {up
                  ? <TrendingUp className="h-3 w-3 text-success" />
                  : <TrendingDown className="h-3 w-3 text-warning" />}
                <span>
                  {up ? "Hạn mức đang phục hồi" : "Hạn mức đang giảm"}
                  {delta > 0 ? ` (${up ? "+" : "−"}${delta}%)` : " (không đổi)"}
                </span>
                <Sparkline data={histPoints} tone={up ? "success" : "warning"} width={80} height={20} />
              </div>
            )
          })()}
        </CardContent>
      </Card>

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Tìm email…"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }}
            className="pl-8 bg-card border-border text-foreground placeholder:text-muted-foreground h-8 text-xs"
          />
        </div>

        {/* Sort */}
        <div className="flex items-center gap-1">
          {([["quota-high", "Quota ↓"], ["quota-low", "Quota ↑"], ["email", "Email"]] as const).map(([v, l]) => (
            <button
              key={v}
              onClick={() => setSortAndSave(v)}
              className={`h-7 px-2.5 rounded text-xs font-medium transition-colors ${sortBy === v ? "bg-primary text-primary-foreground" : "bg-muted border border-border text-foreground/70 hover:text-foreground"}`}
            >
              {l}
            </button>
          ))}
        </div>

        {/* View toggle */}
        <div className="flex items-center bg-muted border border-border rounded-lg p-0.5">
          <button
            onClick={() => setViewAndSave("table")}
            className={`h-6 w-6 flex items-center justify-center rounded ${viewMode === "table" ? "bg-muted" : ""}`}
          >
            <Table2 className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
          <button
            onClick={() => setViewAndSave("card")}
            className={`h-6 w-6 flex items-center justify-center rounded ${viewMode === "card" ? "bg-muted" : ""}`}
          >
            <LayoutGrid className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </div>
      </div>

      {/* Bulk selection bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-2 bg-muted/50 rounded-lg px-4 py-2">
          <span className="text-xs text-muted-foreground">{selected.size} đã chọn</span>
          <Button size="sm" onClick={handleBulkRefresh} className="bg-warning hover:bg-warning text-warning-foreground h-7 text-xs gap-1">
            <RefreshCw className="h-3 w-3" /> Refresh quota
          </Button>
        </div>
      )}

      {/* ── TABLE VIEW ─────────────────────────────────────────────────────── */}
      {viewMode === "table" && (
        <Card className="bg-card border-border">
          <CardContent className="p-0">
            <DataTable
              rows={sorted}
              rowKey={(a) => a.email}
              pageSize={pageSize}
              selection={{ selected, onChange: setSelected }}
              expand={{
                expanded: expandedRows,
                onToggle: toggleExpand,
                render: (a) => {
                  const q = a.quota
                  if (!q) return <p className="text-xs text-muted-foreground">Chưa nạp hạn mức — bấm ⟳</p>
                  return (
                    <div className="space-y-3">
                      {q.groups?.map((g) => (
                        <div key={g.name} className="flex items-center gap-4">
                          <span className="w-32 truncate text-xs text-foreground">{g.name}</span>
                          <QuotaBar pct={g.pct} />
                          <span className="text-xs text-muted-foreground">reset {fmtReset(g.resetTime)}</span>
                        </div>
                      ))}
                      {q.models && q.models.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {q.models.filter((m) => !/^(chat|tab)[-_]/i.test(m.id)).sort((x, y) => x.pct - y.pct).map((m) => (
                            <span key={m.id} className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px]">
                              <span className={qColor(m.pct)}>{m.pct}%</span> {m.id}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                },
              }}
              empty="Không có account. Bấm Refresh để nạp hạn mức."
              columns={[
                {
                  key: "email",
                  header: "Email",
                  sort: (a) => a.email,
                  render: (a) => (
                    <button
                      className="max-w-[220px] truncate text-left font-mono text-sm text-foreground hover:text-warning"
                      onClick={() => setHistEmail(a.email)}
                      title="Xem lịch sử hạn mức"
                    >
                      {a.email}
                    </button>
                  ),
                },
                {
                  key: "tier",
                  header: "Tier",
                  sort: (a) => String(a.quota?.tier ?? ""),
                  render: (a) => (
                    <span className="text-xs text-muted-foreground">
                      {String(a.quota?.tier ?? "—").replace(/^Antigravity\s+/, "")}
                    </span>
                  ),
                },
                { key: "gemini", header: "Gemini", sort: (a) => a.geminiPct ?? -1, render: (a) => <QuotaBar pct={a.geminiPct} /> },
                { key: "claude", header: "Claude/GPT", sort: (a) => claudePct(a) ?? -1, render: (a) => <QuotaBar pct={claudePct(a) ?? undefined} /> },
                {
                  key: "reset",
                  header: "Reset",
                  render: (a) => (
                    <span className="text-xs text-muted-foreground">
                      {a.quota?.groups?.[0] ? fmtReset(a.quota.groups[0].resetTime) : "—"}
                    </span>
                  ),
                },
                {
                  key: "actions",
                  header: "Nạp",
                  align: "right",
                  render: (a) => (
                    <button
                      onClick={() => handleRefreshOne(a.email)}
                      disabled={refreshing[a.email]}
                      className="ml-auto flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-warning"
                      title="Nạp hạn mức"
                    >
                      <RefreshCw className={`h-3 w-3 ${refreshing[a.email] ? "animate-spin" : ""}`} />
                    </button>
                  ),
                },
              ]}
            />
          </CardContent>
        </Card>
      )}

      {/* ── CARD VIEW ──────────────────────────────────────────────────────── */}
      {viewMode === "card" && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {pageRows.map(acc => {
              const q = acc.quota
              const cpct = claudePct(acc)
              const tier = String(q?.tier ?? "—").replace(/^Antigravity\s+/, "")
              return (
                <Card key={acc.email} className="bg-card border-border">
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <button
                          className="text-sm text-foreground font-mono truncate hover:text-warning text-left w-full"
                          onClick={() => setHistEmail(acc.email)}
                        >
                          {acc.email}
                        </button>
                        {q && <Badge className="bg-muted text-muted-foreground border-none text-[10px] mt-1">{tier}</Badge>}
                      </div>
                      <button
                        onClick={() => handleRefreshOne(acc.email)}
                        disabled={refreshing[acc.email]}
                        className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-warning flex-shrink-0"
                      >
                        <RefreshCw className={`h-3 w-3 ${refreshing[acc.email] ? "animate-spin" : ""}`} />
                      </button>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {!q ? (
                      <p className="text-xs text-muted-foreground">Chưa nạp hạn mức</p>
                    ) : (
                      <>
                        {q.groups?.map(g => (
                          <div key={g.name} className="space-y-1">
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-muted-foreground truncate">{g.name}</span>
                              <span className="text-xs text-muted-foreground">reset {fmtReset(g.resetTime)}</span>
                            </div>
                            <QuotaBar pct={g.pct} />
                          </div>
                        ))}
                        {acc.geminiPct != null && !q.groups && (
                          <div className="space-y-1">
                            <span className="text-xs text-muted-foreground">Gemini</span>
                            <QuotaBar pct={acc.geminiPct} />
                          </div>
                        )}
                        {cpct != null && (
                          <div className="space-y-1">
                            <span className="text-xs text-muted-foreground">Claude/GPT</span>
                            <QuotaBar pct={cpct} />
                          </div>
                        )}
                      </>
                    )}
                  </CardContent>
                </Card>
              )
            })}
          </div>

          {/* Card pager */}
          {sorted.length > pageSize && (
            <div className="flex items-center justify-center gap-2">
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={safePage <= 1}
                className="h-8 w-8 flex items-center justify-center rounded hover:bg-muted text-muted-foreground disabled:opacity-30">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-xs text-muted-foreground">Trang {safePage}/{totalPages}</span>
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={safePage >= totalPages}
                className="h-8 w-8 flex items-center justify-center rounded hover:bg-muted text-muted-foreground disabled:opacity-30">
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          )}
        </>
      )}

    </div>
  )
}
