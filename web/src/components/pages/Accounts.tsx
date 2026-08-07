import { useEffect, useState, useCallback } from "react"
import {
  Users,
  Search,
  RefreshCw,
  AlertTriangle,
  Play,
  Square,
  RotateCcw,
  Bot,
  Trash2,
  ChevronLeft,
  ChevronRight,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"

// ── Types ──────────────────────────────────────────────────────────────

interface Account {
  email: string
  status_agy?: string
  status_kiro?: string
  proxy?: string
  lastLogin?: number
  enabled?: boolean
}

interface Proxy {
  label: string
}

// ── Constants ─────────────────────────────────────────────────────────

const FLOWS = [
  { key: "agy", label: "Antigravity", col: "status_agy" as const },
  { key: "kiro", label: "Kiro", col: "status_kiro" as const },
]

const PAGE_SIZES = [25, 50, 100]

// ── Helpers ──────────────────────────────────────────────────────────

function fmtAgo(ms?: number) {
  if (!ms) return "—"
  const d = Date.now() - ms
  if (d < 60000) return Math.max(1, Math.round(d / 1000)) + "s trước"
  if (d < 3600000) return Math.round(d / 60000) + "p trước"
  if (d < 86400000) return Math.round(d / 3600000) + "h trước"
  return Math.round(d / 86400000) + "d trước"
}

function statusBadge(status?: string) {
  if (!status) return <Badge className="bg-slate-700 text-slate-500 border-none text-[10px]">—</Badge>
  const s = status.toLowerCase()
  if (s === "ok" || s === "active" || s === "done")
    return <Badge className="bg-emerald-500/15 text-emerald-400 border-none text-[10px]">{status}</Badge>
  if (s === "running" || s === "pending")
    return <Badge className="bg-blue-500/15 text-blue-400 border-none text-[10px]">{status}</Badge>
  if (s === "error" || s === "failed" || s === "dead")
    return <Badge className="bg-red-500/15 text-red-400 border-none text-[10px]">{status}</Badge>
  if (s === "cooldown")
    return <Badge className="bg-orange-500/15 text-orange-400 border-none text-[10px]">{status}</Badge>
  return <Badge className="bg-slate-700 text-slate-400 border-none text-[10px]">{status}</Badge>
}

// ── Accounts Page ──────────────────────────────────────────────────────

export function Accounts() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [proxies, setProxies] = useState<Proxy[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")

  // Flow checkboxes: which flows are selected for login
  const [selectedFlows, setSelectedFlows] = useState<Set<string>>(new Set(["agy", "kiro"]))

  // No-proxy checkbox
  const [noProxy, setNoProxy] = useState(false)

  // Account selection
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // Pagination
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(() =>
    Number(localStorage.getItem("vs_accSize") || 25)
  )

  // Filter
  const [statusFilter, setStatusFilter] = useState("all")

  const fetchAccounts = useCallback(async () => {
    try {
      const res = await fetch("/api/accounts")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as { accounts: Account[] }
      setAccounts(json.accounts ?? [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch")
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchProxies = useCallback(async () => {
    try {
      const res = await fetch("/api/proxies")
      if (!res.ok) return
      const json = await res.json() as { proxies: Proxy[] }
      setProxies(json.proxies ?? [])
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    fetchAccounts()
    fetchProxies()
    const interval = setInterval(fetchAccounts, 15_000)
    return () => clearInterval(interval)
  }, [fetchAccounts, fetchProxies])

  // ── Actions ──────────────────────────────────────────────────────────

  const runFlow = async (email: string, flow: string) => {
    await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, flow, noProxy }),
    })
  }

  const runPipeline = async (email: string) => {
    if (selectedFlows.size === 0) return
    for (const f of selectedFlows) {
      await runFlow(email, f)
    }
  }

  const deleteAccount = async (email: string) => {
    if (!confirm(`Xoá ${email}?`)) return
    await fetch(`/api/accounts/${encodeURIComponent(email)}`, { method: "DELETE" })
    setSelected(prev => { const n = new Set(prev); n.delete(email); return n })
    fetchAccounts()
  }

  const setProxy = async (email: string, proxy: string) => {
    await fetch(`/api/accounts/${encodeURIComponent(email)}/proxy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proxy }),
    })
    setAccounts(prev => prev.map(a => a.email === email ? { ...a, proxy } : a))
  }

  const handleBulkRun = async () => {
    if (selectedFlows.size === 0) return
    for (const email of selected) {
      for (const f of selectedFlows) {
        await fetch("/api/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, flow: f, noProxy }),
        })
      }
    }
  }

  const handleBulkDelete = async () => {
    if (!confirm(`Xoá ${selected.size} account?`)) return
    for (const email of selected) {
      await fetch(`/api/accounts/${encodeURIComponent(email)}`, { method: "DELETE" })
    }
    setSelected(new Set())
    fetchAccounts()
  }

  const handleRetryFailed = async () => {
    const flows = [...selectedFlows]
    const r = await fetch("/api/retry-failed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flows, noProxy }),
    })
    const data = await r.json()
    console.log("Retry queued:", data.queued)
  }

  const handleAutoRun = async () => {
    const flows = [...selectedFlows]
    if (flows.length === 0) return
    await fetch("/api/auto-run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flows, noProxy }),
    })
  }

  const handleStop = async () => {
    await fetch("/api/stop", { method: "POST" })
  }

  // ── Filter / sort / paginate ─────────────────────────────────────────

  const filtered = accounts.filter(a => {
    if (search && !a.email.toLowerCase().includes(search.toLowerCase())) return false
    if (statusFilter === "error") {
      return a.status_agy?.toLowerCase().includes("error") || a.status_agy?.toLowerCase().includes("failed") ||
             a.status_kiro?.toLowerCase().includes("error") || a.status_kiro?.toLowerCase().includes("failed")
    }
    if (statusFilter !== "all") {
      const s = statusFilter.toLowerCase()
      return a.status_agy?.toLowerCase() === s || a.status_kiro?.toLowerCase() === s
    }
    return true
  })

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const pageRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize)

  const toggleSelect = (email: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(email)) next.delete(email); else next.add(email)
      return next
    })
  }
  const toggleAll = () => {
    if (selected.size === pageRows.length) setSelected(new Set())
    else setSelected(new Set(pageRows.map(a => a.email)))
  }

  const toggleFlow = (flow: string) => {
    setSelectedFlows(prev => {
      const next = new Set(prev)
      if (next.has(flow)) next.delete(flow); else next.add(flow)
      return next
    })
  }

  // ── Loading / Error ──────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-full bg-slate-800" />
        <Skeleton className="h-64 w-full bg-slate-800" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <AlertTriangle className="h-8 w-8 text-red-500" />
        <p className="text-sm text-slate-400">Error: {error}</p>
        <button onClick={fetchAccounts} className="text-xs text-orange-400 hover:text-orange-300 flex items-center gap-1.5">
          <RefreshCw className="h-3 w-3" /> Retry
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 flex-wrap">
        {/* Search */}
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500" />
          <Input
            placeholder="Tìm email…"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }}
            className="pl-9 bg-slate-900 border-slate-800 text-slate-200 placeholder:text-slate-600 h-9 text-sm"
          />
        </div>

        {/* Flow checkboxes */}
        <div className="flex items-center gap-3 bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5">
          <span className="text-xs text-slate-500">Luồng:</span>
          {FLOWS.map(f => (
            <label key={f.key} className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={selectedFlows.has(f.key)}
                onChange={() => toggleFlow(f.key)}
                className="rounded border-slate-600 bg-slate-800 text-orange-500"
              />
              <span className="text-xs text-slate-300">{f.label}</span>
            </label>
          ))}
        </div>

        {/* No-proxy */}
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={noProxy}
            onChange={e => setNoProxy(e.target.checked)}
            className="rounded border-slate-600 bg-slate-800"
          />
          <span className="text-xs text-slate-400">Không dùng proxy</span>
        </label>

        {/* Status filter */}
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1) }}
          className="h-9 px-2 rounded-md bg-slate-900 border border-slate-800 text-slate-300 text-sm focus:outline-none"
        >
          <option value="all">Tất cả</option>
          <option value="error">Lỗi / Failed</option>
          <option value="running">Running</option>
          <option value="done">Done</option>
        </select>

        <Button size="sm" onClick={fetchAccounts} className="border border-slate-700 bg-transparent text-slate-400 hover:text-orange-400 h-9 text-xs gap-1">
          <RefreshCw className="h-3 w-3" /> Refresh
        </Button>
      </div>

      {/* Bulk actions bar — always visible */}
      <div className="flex flex-wrap items-center gap-2 bg-slate-900 border border-slate-800 rounded-lg px-3 py-2">
        <span className="text-xs text-slate-500 mr-1">
          {selected.size > 0 ? `${selected.size} đã chọn` : "Bulk:"}
        </span>
        <Button
          size="sm"
          onClick={handleAutoRun}
          className="bg-orange-500 hover:bg-orange-600 text-white h-7 text-xs gap-1"
        >
          <Bot className="h-3 w-3" /> Auto Run
        </Button>
        <Button
          size="sm"
          onClick={handleRetryFailed}
          className="bg-slate-700 hover:bg-slate-600 text-slate-200 h-7 text-xs gap-1"
        >
          <RotateCcw className="h-3 w-3" /> Retry Failed
        </Button>
        <Button
          size="sm"
          onClick={handleStop}
          className="bg-slate-700 hover:bg-slate-600 text-slate-200 h-7 text-xs gap-1"
        >
          <Square className="h-3 w-3" /> Stop
        </Button>
        {selected.size > 0 && (
          <>
            <Button size="sm" onClick={handleBulkRun} className="bg-emerald-600 hover:bg-emerald-700 text-white h-7 text-xs gap-1">
              <Play className="h-3 w-3" /> Run Selected
            </Button>
            <Button size="sm" onClick={handleBulkDelete} className="bg-red-600 hover:bg-red-700 text-white h-7 text-xs gap-1">
              <Trash2 className="h-3 w-3" /> Xoá Selected
            </Button>
          </>
        )}
      </div>

      {/* Table */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
            <Users className="h-4 w-4 text-slate-500" />
            Tài khoản ({filtered.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-slate-800 hover:bg-transparent">
                  <TableHead className="w-8">
                    <input
                      type="checkbox"
                      checked={pageRows.length > 0 && selected.size === pageRows.length}
                      onChange={toggleAll}
                      className="rounded border-slate-600 bg-slate-800"
                    />
                  </TableHead>
                  <TableHead className="text-slate-500 text-xs">Email</TableHead>
                  <TableHead className="text-slate-500 text-xs">Proxy</TableHead>
                  {FLOWS.map(f => (
                    <TableHead key={f.key} className="text-slate-500 text-xs">{f.label}</TableHead>
                  ))}
                  <TableHead className="text-slate-500 text-xs">Last login</TableHead>
                  <TableHead className="text-slate-500 text-xs text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.length === 0 ? (
                  <TableRow className="border-slate-800">
                    <TableCell colSpan={4 + FLOWS.length} className="text-center text-slate-600 text-xs py-8">
                      Không có tài khoản khớp
                    </TableCell>
                  </TableRow>
                ) : (
                  pageRows.map(acc => (
                    <TableRow
                      key={acc.email}
                      className={`border-slate-800 hover:bg-slate-800/50 ${selected.has(acc.email) ? "bg-orange-500/5" : ""}`}
                    >
                      <TableCell>
                        <input
                          type="checkbox"
                          checked={selected.has(acc.email)}
                          onChange={() => toggleSelect(acc.email)}
                          className="rounded border-slate-600 bg-slate-800"
                        />
                      </TableCell>
                      <TableCell className="text-sm text-slate-200 font-mono max-w-[220px] truncate">
                        {acc.email}
                      </TableCell>
                      {/* Proxy dropdown */}
                      <TableCell>
                        <select
                          value={acc.proxy ?? ""}
                          onChange={e => setProxy(acc.email, e.target.value)}
                          className="h-7 px-2 rounded bg-slate-800 border border-slate-700 text-slate-300 text-xs focus:outline-none max-w-[120px]"
                        >
                          <option value="">(none)</option>
                          {proxies.map(p => (
                            <option key={p.label} value={p.label}>{p.label}</option>
                          ))}
                        </select>
                      </TableCell>
                      {/* Status per flow */}
                      {FLOWS.map(f => (
                        <TableCell key={f.key}>
                          {statusBadge(acc[f.col])}
                        </TableCell>
                      ))}
                      <TableCell className="text-xs text-slate-500">
                        {fmtAgo(acc.lastLogin)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1 justify-end">
                          {/* Login: run selected flows */}
                          <button
                            title="Login (chạy luồng đã chọn)"
                            onClick={() => runPipeline(acc.email)}
                            className="h-6 px-2 flex items-center gap-1 rounded hover:bg-slate-700 text-slate-400 hover:text-emerald-400 text-xs"
                          >
                            <Play className="h-3 w-3" /> Login
                          </button>
                          {/* Delete */}
                          <button
                            title="Xoá account"
                            onClick={() => deleteAccount(acc.email)}
                            className="h-6 w-6 flex items-center justify-center rounded hover:bg-red-900/30 text-slate-500 hover:text-red-400"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {/* Pager */}
          {filtered.length > 0 && (
            <div className="flex items-center justify-between pt-4 border-t border-slate-800">
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">
                  Trang {safePage}/{totalPages} · {filtered.length} rows
                </span>
                <select
                  value={pageSize}
                  onChange={e => {
                    setPageSize(Number(e.target.value))
                    setPage(1)
                    localStorage.setItem("vs_accSize", e.target.value)
                  }}
                  className="h-7 px-2 rounded bg-slate-800 border border-slate-700 text-slate-300 text-xs focus:outline-none"
                >
                  {PAGE_SIZES.map(s => <option key={s} value={s}>{s}/trang</option>)}
                </select>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={safePage <= 1}
                  className="h-7 w-7 flex items-center justify-center rounded hover:bg-slate-800 text-slate-400 disabled:opacity-30"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  const p = Math.max(1, Math.min(totalPages - 4, safePage - 2)) + i
                  return (
                    <button
                      key={p}
                      onClick={() => setPage(p)}
                      className={`h-7 w-7 flex items-center justify-center rounded text-xs ${p === safePage ? "bg-orange-500 text-white" : "text-slate-400 hover:bg-slate-800"}`}
                    >
                      {p}
                    </button>
                  )
                })}
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={safePage >= totalPages}
                  className="h-7 w-7 flex items-center justify-center rounded hover:bg-slate-800 text-slate-400 disabled:opacity-30"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
