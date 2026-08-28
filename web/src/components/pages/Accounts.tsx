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
  AppWindow,
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
  /** Lý do lỗi gần nhất theo từng flow — server ghép từ bảng `runs`. */
  lastErrors?: Record<string, string>
}

interface Proxy {
  label: string
}

/** Lý do lỗi + số account dính, xếp hạng để biết sửa cái nào cứu được nhiều nhất. */
interface Reason {
  reason: string
  accounts: number
  flows: string
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

/**
 * `reason` là lý do lỗi lần chạy gần nhất, lấy từ bảng `runs`.
 *
 * Trước đây cột này chỉ hiện chữ "failed" trơ trọi: đo trên production có 133 account
 * failed mà không chỗ nào nói vì sao — nhìn thấy "hỏng 133 cái" rồi bó tay. Lý do thật
 * (`antigravity_no_code`: OAuth chờ 90s không bắt được authorization code) vẫn nằm trong
 * DB, chỉ chưa ai nối hai nguồn lại.
 */
function statusBadge(status?: string, reason?: string) {
  if (!status) return <Badge className="bg-muted text-muted-foreground">—</Badge>
  const s = status.toLowerCase()
  if (s === "ok" || s === "active" || s === "done")
    return <Badge className="bg-success/15 text-success">{status}</Badge>
  if (s === "running" || s === "pending")
    return <Badge className="bg-info/15 text-info">{status}</Badge>
  if (s === "error" || s === "failed" || s === "dead" || s === "needs_human") {
    const tone = s === "needs_human" ? "bg-warning/15 text-[color:var(--warning)]" : "bg-destructive/15 text-destructive"
    return (
      <span className="inline-flex flex-col items-start gap-0.5">
        <Badge className={tone} title={reason ? `Lý do: ${reason}` : undefined}>{status}</Badge>
        {reason && (
          <span className="max-w-[13rem] truncate font-mono text-[10px] text-muted-foreground" title={reason}>
            {reason}
          </span>
        )}
      </span>
    )
  }
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
  /** Email đang chờ Chrome bật lên — để hiện spinner và chặn bấm chồng. */
  const [dangMo, setDangMo] = useState<Set<string>>(new Set())

  // Pagination
  // DataTable tự quản số dòng/trang; đây chỉ là giá trị KHỞI TẠO đọc từ lựa chọn cũ.
  const [pageSize] = useState<number>(() => Number(localStorage.getItem("vs_accSize") || 25))

  // Filter
  const [statusFilter, setStatusFilter] = useState("all")
  const [reasons, setReasons] = useState<Reason[]>([])

  const fetchAccounts = useCallback(async () => {
    try {
      const res = await fetch("/api/accounts")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as { accounts: Account[]; reasons?: Reason[] }
      setAccounts(json.accounts ?? [])
      setReasons(json.reasons ?? [])
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

  /**
   * Mở profile Chrome của account lên màn hình để thao tác tay.
   *
   * Mở trình duyệt mất vài giây — không có phản hồi thì người dùng tưởng nút hỏng và
   * bấm tiếp, nên đánh dấu "đang mở" ngay và giữ tới khi backend trả lời.
   */
  const moChrome = async (email: string) => {
    setDangMo(prev => new Set(prev).add(email))
    try {
      const r = await fetch(`/api/accounts/${encodeURIComponent(email)}/mo-profile`, { method: "POST" })
      const kq = await r.json() as { ok: boolean; loi?: string; daMoTruoc?: boolean }
      if (!kq.ok) alert(`Không mở được Chrome cho ${email}:\n\n${kq.loi ?? "lỗi không rõ"}`)
      else if (kq.daMoTruoc) alert(`Cửa sổ Chrome của ${email} đang mở sẵn rồi.`)
    } catch (e) {
      alert(`Không gọi được API: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setDangMo(prev => { const n = new Set(prev); n.delete(email); return n })
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
      {/* Vì sao account hỏng — xếp theo số account dính, nhiều nhất lên đầu.
          Không có bảng này thì chỉ thấy "failed" và không biết bắt đầu từ đâu. */}
      {reasons.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-3">
          <p className="mb-2 text-xs font-medium text-foreground">
            Vì sao account hỏng — {reasons.reduce((s, r) => s + r.accounts, 0)} account, {reasons.length} nguyên nhân
          </p>
          <div className="space-y-1">
            {reasons.slice(0, 6).map((r) => {
              const top = Math.max(1, ...reasons.map((x) => x.accounts))
              return (
                <button
                  key={r.reason}
                  onClick={() => setSearch("")}
                  title={`${r.accounts} account · luồng: ${r.flows}`}
                  className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left"
                >
                  <span className="w-56 shrink-0 truncate font-mono text-[11px] text-foreground">{r.reason}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-background">
                    <div className="h-full rounded-full bg-destructive" style={{ width: `${(r.accounts / top) * 100}%` }} />
                  </div>
                  <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{r.accounts}</span>
                  <span className="w-24 shrink-0 truncate text-[10px] text-muted-foreground">{r.flows}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

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
                render: (a: Account) => statusBadge(a[f.col], a.lastErrors?.[f.key]),
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
                      title="Mở profile Chrome của account này để thao tác tay"
                      disabled={dangMo.has(a.email)}
                      onClick={() => moChrome(a.email)}
                      className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-primary disabled:opacity-40"
                    >
                      <AppWindow className={`h-3 w-3 ${dangMo.has(a.email) ? "animate-pulse" : ""}`} />
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
