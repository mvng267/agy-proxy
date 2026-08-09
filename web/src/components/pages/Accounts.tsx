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
} from "lucide-react"
import { DataTable } from "@/components/common/DataTable"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
  if (!status) return <Badge className="bg-muted text-muted-foreground">—</Badge>
  const s = status.toLowerCase()
  if (s === "ok" || s === "active" || s === "done")
    return <Badge className="bg-success/15 text-success">{status}</Badge>
  if (s === "running" || s === "pending")
    return <Badge className="bg-info/15 text-info">{status}</Badge>
  if (s === "error" || s === "failed" || s === "dead")
    return <Badge className="bg-destructive/15 text-destructive">{status}</Badge>
  if (s === "cooldown")
    return <Badge className="bg-primary/15 text-primary">{status}</Badge>
  return <Badge className="bg-muted text-muted-foreground">{status}</Badge>
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
  // DataTable tự quản số dòng/trang; đây chỉ là giá trị KHỞI TẠO đọc từ lựa chọn cũ.
  const [pageSize] = useState<number>(() => Number(localStorage.getItem("vs_accSize") || 25))

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
        <Skeleton className="h-10 w-full bg-muted" />
        <Skeleton className="h-64 w-full bg-muted" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <AlertTriangle className="h-8 w-8 text-destructive" />
        <p className="text-sm text-muted-foreground">Error: {error}</p>
        <button onClick={fetchAccounts} className="text-xs text-primary hover:text-primary flex items-center gap-1.5">
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
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Tìm email…"
            value={search}
            onChange={e => { setSearch(e.target.value); }}
            className="pl-9 bg-card border-border text-foreground placeholder:text-muted-foreground h-9 text-sm"
          />
        </div>

        {/* Flow checkboxes */}
        <div className="flex items-center gap-3 bg-card border border-border rounded-lg px-3 py-1.5">
          <span className="text-xs text-muted-foreground">Luồng:</span>
          {FLOWS.map(f => (
            <label key={f.key} className="flex items-center gap-1.5 cursor-pointer">
              <Checkbox checked={selectedFlows.has(f.key)} onCheckedChange={() => toggleFlow(f.key)} />
              <span className="text-xs text-foreground">{f.label}</span>
            </label>
          ))}
        </div>

        {/* No-proxy */}
        <label className="flex items-center gap-1.5 cursor-pointer">
          <Checkbox checked={noProxy} onCheckedChange={(v) => setNoProxy(!!v)} />
          <span className="text-xs text-muted-foreground">Không dùng proxy</span>
        </label>

        {/* Status filter */}
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v ?? "all")}>
          <SelectTrigger className="h-9 w-36 text-sm">
            <span className="truncate">
              {{ all: "Tất cả", error: "Lỗi / Failed", running: "Running", done: "Done" }[statusFilter] ?? "Tất cả"}
            </span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-sm">Tất cả</SelectItem>
            <SelectItem value="error" className="text-sm">Lỗi / Failed</SelectItem>
            <SelectItem value="running" className="text-sm">Running</SelectItem>
            <SelectItem value="done" className="text-sm">Done</SelectItem>
          </SelectContent>
        </Select>

        <Button size="sm" onClick={fetchAccounts} className="border border-border bg-transparent text-muted-foreground hover:text-primary h-9 text-xs gap-1">
          <RefreshCw className="h-3 w-3" /> Refresh
        </Button>
      </div>

      {/* Thanh này LUÔN hiện là đúng: Auto Run / Retry Failed / Stop là hành động toàn cục
          (chạy pipeline đăng nhập), không phụ thuộc dòng nào được chọn. Chỉ 2 nút cuối mới
          cần chọn dòng. Nhãn nói rõ phạm vi thay vì chữ "Bulk:" không mang thông tin. */}
      <div className="flex flex-wrap items-center gap-2 bg-card border border-border rounded-lg px-3 py-2">
        <span className="text-xs text-muted-foreground mr-1">
          {selected.size > 0 ? `${selected.size} đã chọn` : "Chạy luồng:"}
        </span>
        <Button
          size="sm"
          onClick={handleAutoRun}
          className="bg-primary hover:bg-primary text-primary-foreground h-7 text-xs gap-1"
        >
          <Bot className="h-3 w-3" /> Auto Run
        </Button>
        <Button
          size="sm"
          onClick={handleRetryFailed}
          className="bg-muted hover:bg-muted-foreground/40 text-foreground h-7 text-xs gap-1"
        >
          <RotateCcw className="h-3 w-3" /> Retry Failed
        </Button>
        <Button
          size="sm"
          onClick={handleStop}
          className="bg-muted hover:bg-muted-foreground/40 text-foreground h-7 text-xs gap-1"
        >
          <Square className="h-3 w-3" /> Stop
        </Button>
        {selected.size > 0 && (
          <>
            <Button size="sm" onClick={handleBulkRun} className="bg-success hover:bg-success text-success-foreground h-7 text-xs gap-1">
              <Play className="h-3 w-3" /> Run Selected
            </Button>
            <Button size="sm" onClick={handleBulkDelete} className="bg-destructive hover:bg-destructive text-destructive-foreground h-7 text-xs gap-1">
              <Trash2 className="h-3 w-3" /> Xoá Selected
            </Button>
          </>
        )}
      </div>

      {/* Table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-foreground flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            Tài khoản ({filtered.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable
            rows={filtered}
            rowKey={(a) => a.email}
            pageSize={pageSize}
            selection={{ selected, onChange: setSelected }}
            empty="Không có tài khoản khớp"
            columns={[
              {
                key: "email",
                header: "Email",
                sort: (a) => a.email,
                render: (a) => (
                  <span className="block max-w-[220px] truncate font-mono text-sm text-foreground" title={a.email}>{a.email}</span>
                ),
              },
              {
                key: "proxy",
                header: "Proxy",
                sort: (a) => a.proxy ?? "",
                render: (a) => (
                  <Select value={a.proxy ?? ""} onValueChange={(v) => setProxy(a.email, v ?? "")}>
                    <SelectTrigger className="h-7 w-[130px] text-xs">
                      <span className="truncate">{a.proxy || "(none)"}</span>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="" className="text-xs">(none)</SelectItem>
                      {proxies.map((p) => (
                        <SelectItem key={p.label} value={p.label} className="text-xs">{p.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ),
              },
              // Cột ĐỘNG theo FLOWS — số cột đổi theo cấu hình luồng.
              ...FLOWS.map((f) => ({
                key: f.key,
                header: f.label,
                sort: (a: Account) => String(a[f.col] ?? ""),
                render: (a: Account) => statusBadge(a[f.col]),
              })),
              {
                key: "lastLogin",
                header: "Last login",
                sort: (a) => a.lastLogin ?? 0,
                render: (a) => <span className="text-xs text-muted-foreground">{fmtAgo(a.lastLogin)}</span>,
              },
              {
                key: "actions",
                header: "",
                align: "right",
                render: (a) => (
                  <div className="flex items-center justify-end gap-1">
                    <button
                      title="Login (chạy luồng đã chọn)"
                      onClick={() => runPipeline(a.email)}
                      className="flex h-6 items-center gap-1 rounded px-2 text-xs text-muted-foreground hover:bg-muted hover:text-success"
                    >
                      <Play className="h-3 w-3" /> Login
                    </button>
                    <button
                      title="Xoá account"
                      onClick={() => deleteAccount(a.email)}
                      className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-destructive/30 hover:text-destructive"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ),
              },
            ]}
          />
        </CardContent>
      </Card>
    </div>
  )
}
