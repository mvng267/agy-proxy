import { useEffect, useState, useCallback } from "react"
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
  ChevronDown,
  ChevronRight as ChevronRt,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

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
  if (pct >= 50) return "text-emerald-400"
  if (pct >= 20) return "text-amber-400"
  return "text-red-400"
}

function claudePct(a: PoolAccount): number | null {
  const g = a.quota?.groups?.find(x => !/gemini/i.test(x.name))
  return g ? g.pct : null
}

const PAGE_SIZES = [25, 50, 100]

// ── Donut Chart ────────────────────────────────────────────────────────

function QuotaDonut({ label, pct, color, size = 100, strokeWidth = 10 }: {
  label: string; pct: number; color: string; size?: number; strokeWidth?: number
}) {
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const center = size / 2
  const filled = circumference * (pct / 100)
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="transform -rotate-90">
          <circle cx={center} cy={center} r={radius} fill="none" stroke="#334155" strokeWidth={strokeWidth} />
          {pct > 0 && (
            <circle cx={center} cy={center} r={radius} fill="none" stroke={color} strokeWidth={strokeWidth}
              strokeDasharray={`${filled} ${circumference - filled}`} strokeDashoffset={0} strokeLinecap="round"
              className="transition-all duration-700" />
          )}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-bold text-foreground tabular-nums">{Math.round(pct)}%</span>
        </div>
      </div>
      <span className="text-xs text-muted-foreground font-medium">{label}</span>
    </div>
  )
}

// ── Sparkline ─────────────────────────────────────────────────────────

function Sparkline({ series, width = 200, height = 40 }: {
  series: Array<{ data: number[]; color: string }>; width?: number; height?: number
}) {
  const drawable = series.filter((s) => s.data.length >= 2)
  if (!drawable.length) return null
  // Chung một thang y cho mọi series — hai đường 92% và 72% phải nhìn ra chênh lệch.
  const all = drawable.flatMap((s) => s.data)
  const min = Math.min(...all), max = Math.max(...all), range = max - min || 1, padding = 2
  const toPath = (data: number[]) =>
    data
      .map((val, i) => {
        const x = padding + (i / (data.length - 1)) * (width - padding * 2)
        const y = height - padding - ((val - min) / range) * (height - padding * 2)
        return `${i === 0 ? "M" : "L"}${x},${y}`
      })
      .join(" ")
  return (
    <svg width={width} height={height} className="overflow-visible">
      {drawable.map((s, i) => (
        <path key={i} d={toPath(s.data)} fill="none" stroke={s.color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" className="transition-all duration-500" />
      ))}
    </svg>
  )
}

// ── Quota Bar ─────────────────────────────────────────────────────────

function QuotaBar({ pct }: { pct?: number }) {
  if (pct == null) return <span className="text-xs text-muted-foreground">—</span>
  const color = pct >= 50 ? "bg-emerald-500" : pct >= 20 ? "bg-amber-500" : "bg-red-500"
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
  const [pageSize, setPageSize] = useState<number>(() =>
    Number(localStorage.getItem("vs_quotaSize") || 25)
  )
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

  const toggleSelect = (email: string) => {
    setSelected(prev => {
      const next = new Set(prev); if (next.has(email)) next.delete(email); else next.add(email); return next
    })
  }
  const toggleAll = () => {
    if (selected.size === pageRows.length) setSelected(new Set())
    else setSelected(new Set(pageRows.map(a => a.email)))
  }

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

  // History chart points — hai bể riêng: Gemini và Claude/GPT (third-party)
  const histPoints: number[] = historyData?.series?.map(x => x.gemini ?? 0) ??
    historyData?.points?.map(p => p.gemini_pct ?? 0) ?? []
  const histPointsThird: number[] = historyData?.series?.map(x => x.third ?? 0) ??
    historyData?.points?.map(p => p.third_pct ?? 0) ?? []

  // ── Loading / Error ──────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-4">
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
        <AlertTriangle className="h-8 w-8 text-red-500" />
        <p className="text-sm text-muted-foreground">Error: {error}</p>
        <button onClick={fetchAccounts} className="text-xs text-orange-400 hover:text-orange-300 flex items-center gap-1.5">
          <RefreshCw className="h-3 w-3" /> Retry
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
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
            className="border border-border bg-transparent text-muted-foreground hover:text-orange-400 h-7 text-xs gap-1"
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
        <Card className="bg-card border-border">
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Đã nạp</p>
            <p className="text-2xl font-bold text-foreground tabular-nums mt-1">{withQ.length} <span className="text-sm text-muted-foreground">/ {accounts.length}</span></p>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="pt-4 flex items-center gap-4">
            {avgGemini != null && <QuotaDonut label="Gemini TB" pct={avgGemini} color="#22c55e" size={80} strokeWidth={8} />}
            <div className="flex-1">
              <QuotaBar pct={avgGemini ?? undefined} />
              <p className="text-[10px] text-muted-foreground mt-1">Trung bình pool</p>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="pt-4 flex items-center gap-4">
            {avgClaude != null && <QuotaDonut label="Claude TB" pct={avgClaude} color="#8b5cf6" size={80} strokeWidth={8} />}
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
          {histPoints.length >= 2 ? (
            <div className="bg-muted/50 rounded-lg p-3">
              <Sparkline
                series={[
                  { data: histPoints, color: "#22c55e" },
                  { data: histPointsThird, color: "#8b5cf6" },
                ]}
                width={500}
                height={60}
              />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground text-center py-4">
              Chưa có dữ liệu. Bấm Refresh để nạp hạn mức — mỗi lần nạp ghi 1 điểm.
            </p>
          )}
          <div className="flex items-center gap-4 mt-2">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><span className="h-2 w-2 rounded-full bg-emerald-500" />Gemini</span>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><span className="h-2 w-2 rounded-full bg-purple-500" />Claude/GPT</span>
          </div>
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
              className={`h-7 px-2.5 rounded text-xs font-medium transition-colors ${sortBy === v ? "bg-orange-500 text-white" : "bg-muted border border-border text-muted-foreground hover:text-foreground"}`}
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
          <Button size="sm" onClick={handleBulkRefresh} className="bg-orange-500 hover:bg-orange-600 text-white h-7 text-xs gap-1">
            <RefreshCw className="h-3 w-3" /> Refresh quota
          </Button>
        </div>
      )}

      {/* ── TABLE VIEW ─────────────────────────────────────────────────────── */}
      {viewMode === "table" && (
        <Card className="bg-card border-border">
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-border hover:bg-transparent">
                    <TableHead className="w-8 pl-4">
                      <input
                        type="checkbox"
                        checked={pageRows.length > 0 && selected.size === pageRows.length}
                        onChange={toggleAll}
                        className="rounded border-border bg-muted"
                      />
                    </TableHead>
                    <TableHead className="w-8" />
                    <TableHead className="text-muted-foreground text-xs">Email</TableHead>
                    <TableHead className="text-muted-foreground text-xs">Tier</TableHead>
                    <TableHead className="text-muted-foreground text-xs">Gemini</TableHead>
                    <TableHead className="text-muted-foreground text-xs">Claude/GPT</TableHead>
                    <TableHead className="text-muted-foreground text-xs">Reset</TableHead>
                    <TableHead className="text-muted-foreground text-xs text-right pr-4">Nạp</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.length === 0 ? (
                    <TableRow className="border-border">
                      <TableCell colSpan={8} className="text-center text-muted-foreground text-xs py-8">
                        Không có account. Bấm Refresh để nạp hạn mức.
                      </TableCell>
                    </TableRow>
                  ) : (
                    pageRows.flatMap(acc => {
                      const q = acc.quota
                      const cpct = claudePct(acc)
                      const reset = q?.groups?.[0] ? fmtReset(q.groups[0].resetTime) : "—"
                      const tier = String(q?.tier ?? "—").replace(/^Antigravity\s+/, "")
                      const isExpanded = expandedRows.has(acc.email)
                      return [
                        <TableRow
                          key={acc.email}
                          className={`border-border hover:bg-muted/40 ${selected.has(acc.email) ? "bg-orange-500/5" : ""}`}
                        >
                          <TableCell className="pl-4">
                            <input
                              type="checkbox"
                              checked={selected.has(acc.email)}
                              onChange={() => toggleSelect(acc.email)}
                              className="rounded border-border bg-muted"
                            />
                          </TableCell>
                          <TableCell>
                            <button
                              onClick={() => toggleExpand(acc.email)}
                              className="text-muted-foreground hover:text-foreground"
                            >
                              {isExpanded
                                ? <ChevronDown className="h-3.5 w-3.5" />
                                : <ChevronRt className="h-3.5 w-3.5" />}
                            </button>
                          </TableCell>
                          <TableCell>
                            <button
                              className="text-sm text-foreground font-mono hover:text-orange-400 text-left"
                              onClick={() => { setHistEmail(acc.email) }}
                              title="Xem lịch sử hạn mức"
                            >
                              {acc.email}
                            </button>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">{tier}</TableCell>
                          <TableCell><QuotaBar pct={acc.geminiPct} /></TableCell>
                          <TableCell><QuotaBar pct={cpct ?? undefined} /></TableCell>
                          <TableCell className="text-xs text-muted-foreground">{reset}</TableCell>
                          <TableCell className="text-right pr-4">
                            <button
                              onClick={() => handleRefreshOne(acc.email)}
                              disabled={refreshing[acc.email]}
                              className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-orange-400 ml-auto"
                              title="Nạp hạn mức"
                            >
                              <RefreshCw className={`h-3 w-3 ${refreshing[acc.email] ? "animate-spin" : ""}`} />
                            </button>
                          </TableCell>
                        </TableRow>,
                        // Expanded detail row
                        isExpanded && (
                          <TableRow key={acc.email + "_detail"} className="border-border bg-muted/20">
                            <TableCell colSpan={8} className="px-8 py-3">
                              {!q ? (
                                <p className="text-xs text-muted-foreground">Chưa nạp hạn mức — bấm ⟳</p>
                              ) : (
                                <div className="space-y-3">
                                  {q.groups?.map(g => (
                                    <div key={g.name} className="flex items-center gap-4">
                                      <span className="text-xs text-foreground w-32 truncate">{g.name}</span>
                                      <QuotaBar pct={g.pct} />
                                      <span className="text-xs text-muted-foreground">reset {fmtReset(g.resetTime)}</span>
                                    </div>
                                  ))}
                                  {q.models && q.models.length > 0 && (
                                    <div className="flex flex-wrap gap-1.5 mt-2">
                                      {q.models.filter(m => !/^(chat|tab)[-_]/i.test(m.id)).sort((a, b) => a.pct - b.pct).map(m => (
                                        <span key={m.id} className="text-[10px] bg-muted border border-border rounded px-1.5 py-0.5">
                                          <span className={qColor(m.pct)}>{m.pct}%</span> {m.id}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </TableCell>
                          </TableRow>
                        )
                      ].filter(Boolean)
                    })
                  )}
                </TableBody>
              </Table>
            </div>

            {/* Pager */}
            {sorted.length > 0 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-border">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Trang {safePage}/{totalPages} · {sorted.length} rows</span>
                  <select
                    value={pageSize}
                    onChange={e => { setPageSize(Number(e.target.value)); setPage(1); localStorage.setItem("vs_quotaSize", e.target.value) }}
                    className="h-7 px-2 rounded bg-muted border border-border text-foreground text-xs focus:outline-none"
                  >
                    {PAGE_SIZES.map(s => <option key={s} value={s}>{s}/trang</option>)}
                  </select>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={safePage <= 1}
                    className="h-7 w-7 flex items-center justify-center rounded hover:bg-muted text-muted-foreground disabled:opacity-30"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </button>
                  {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                    const p = Math.max(1, Math.min(totalPages - 4, safePage - 2)) + i
                    return (
                      <button key={p} onClick={() => setPage(p)}
                        className={`h-7 w-7 flex items-center justify-center rounded text-xs ${p === safePage ? "bg-orange-500 text-white" : "text-muted-foreground hover:bg-muted"}`}
                      >{p}</button>
                    )
                  })}
                  <button
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    disabled={safePage >= totalPages}
                    className="h-7 w-7 flex items-center justify-center rounded hover:bg-muted text-muted-foreground disabled:opacity-30"
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}
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
                          className="text-sm text-foreground font-mono truncate hover:text-orange-400 text-left w-full"
                          onClick={() => setHistEmail(acc.email)}
                        >
                          {acc.email}
                        </button>
                        {q && <Badge className="bg-muted text-muted-foreground border-none text-[10px] mt-1">{tier}</Badge>}
                      </div>
                      <button
                        onClick={() => handleRefreshOne(acc.email)}
                        disabled={refreshing[acc.email]}
                        className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-orange-400 flex-shrink-0"
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

      {/* Trend icons for history (compact, decorative) */}
      {histPoints.length >= 2 && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {histPoints[histPoints.length - 1] > histPoints[histPoints.length - 2]
            ? <TrendingUp className="h-3 w-3 text-red-400" />
            : <TrendingDown className="h-3 w-3 text-emerald-400" />}
          <span>
            {histPoints[histPoints.length - 1] > histPoints[histPoints.length - 2]
              ? "Quota đang giảm" : "Quota đang phục hồi"}
          </span>
        </div>
      )}
    </div>
  )
}
