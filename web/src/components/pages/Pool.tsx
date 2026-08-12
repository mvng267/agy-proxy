import { useEffect, useState, useCallback, useRef } from "react"
import {
  Zap,
  Users,
  AlertTriangle,
  RefreshCw,
  Activity,
  Server,
  Snowflake,
  Search,
  Power,
  PowerOff,
  FlaskConical,
  Gauge,
} from "lucide-react"
import { ConfirmDialog, KpiCard, PageHeader } from "@/components/common"
import { SegmentBar } from "@/components/common/charts"
import { DataTable } from "@/components/common/DataTable"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { useToast } from "@/components/ui/toast"
import { RoutingHint } from "@/components/common/RoutingHint"

// ── Types ──────────────────────────────────────────────────────────────

interface PoolAccount {
  email: string
  provider: string
  health?: string
  enabled: boolean
  cooldown: boolean
  cooldownUntil?: number
  liveStatus?: string
  requests: number
  tokensIn: number
  tokensOut: number
  lastUsed?: number
  /** Lần KIỂM gần nhất (khác lastUsed = lúc phục vụ request). */
  lastCheckAt?: number
  geminiPct?: number
  claudePct?: number
  quota?: {
    groups?: Array<{ name: string; pct: number; resetTime?: string }>
    tier?: string
    models?: Array<{ id: string; pct: number }>
  }
}

interface AccountsResponse {
  accounts: PoolAccount[]
  counts?: { agy?: number; kr?: number }
}

// ── Helpers ─────────────────────────────────────────────────────────

function fmtNum(n: number) {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M"
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k"
  return String(n)
}

function fmtAgo(ms?: number) {
  if (!ms) return "—"
  const d = Date.now() - ms
  if (d < 60000) return Math.max(1, Math.round(d / 1000)) + "s"
  if (d < 3600000) return Math.round(d / 60000) + "m"
  if (d < 86400000) return Math.round(d / 3600000) + "h"
  return Math.round(d / 86400000) + "d"
}

function fmtCooldown(until?: number) {
  if (!until) return ""
  const d = until - Date.now()
  if (d <= 0) return ""
  const mins = Math.ceil(d / 60000)
  if (mins < 60) return `${mins}m`
  return `${(d / 3600000).toFixed(1)}h`
}

// ── Donut Chart ────────────────────────────────────────────────────────


// ── KPI Card ───────────────────────────────────────────────────────────


// ── Pool Page ──────────────────────────────────────────────────────────

export function Pool() {
  const [accounts, setAccounts] = useState<PoolAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const toast = useToast()

  // Provider tab
  // KHÔNG khoá cứng "agy" | "kr": provider thêm sau (OpenRouter, Nous) cũng phải có tab,
  // nếu không account của chúng nằm trong pool mà giao diện không có lối vào.
  const [provider, setProvider] = useState<string>(() => localStorage.getItem("vs_agyProv") || "agy")

  // Filter / sort / page
  const [search, setSearch] = useState("")
  const [filter, setFilter] = useState("all")
  // DataTable tự quản số dòng/trang; đây chỉ là giá trị KHỞI TẠO đọc từ lựa chọn cũ.
  const [pageSize] = useState<number>(() => Number(localStorage.getItem("vs_agySize") || 50))

  // Selection
  const [selected, setSelected] = useState<Set<string>>(new Set())
  /** Danh sách áp dụng: đã chọn → chỉ phần đó; chưa chọn → undefined = toàn bộ. */
  const sel = () => (selected.size > 0 ? [...selected] : undefined)
  /** Hành động huỷ hoại / tốn thời gian đang chờ xác nhận. */
  const [confirm, setConfirm] = useState<"off" | "live" | null>(null)

  // Per-row spinning states
  const [spinning, setSpinning] = useState<Record<string, Record<string, boolean>>>({})

  // Check progress
  const [checkProgress, setCheckProgress] = useState<{ total: number; done: number } | null>(null)
  const evtRef = useRef<EventSource | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/gateway/accounts")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as AccountsResponse
      setAccounts(json.accounts ?? [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 30_000)
    return () => clearInterval(interval)
  }, [fetchData])

  // Save provider preference
  useEffect(() => {
    localStorage.setItem("vs_agyProv", provider)
    setSelected(new Set())
  }, [provider])

  // ── Spin helper
  const withSpin = async (email: string, key: string, fn: () => Promise<void>) => {
    setSpinning(prev => ({ ...prev, [email]: { ...prev[email], [key]: true } }))
    try { await fn() } finally {
      setSpinning(prev => ({ ...prev, [email]: { ...prev[email], [key]: false } }))
    }
  }

  // ── Per-account actions
  const handleToggle = async (acc: PoolAccount, enabled: boolean) => {
    await withSpin(acc.email, "toggle", async () => {
      await fetch(`/api/gateway/accounts/${encodeURIComponent(acc.email)}/toggle?provider=${provider}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      })
      setAccounts(prev => prev.map(a => a.email === acc.email ? { ...a, enabled } : a))
    })
  }

  const handleTest = async (email: string) => {
    await withSpin(email, "test", async () => {
      const r = await fetch(`/api/gateway/accounts/${encodeURIComponent(email)}/test?provider=${provider}`, { method: "POST" })
      const data = await r.json()
      setAccounts(prev => prev.map(a => a.email === email ? { ...a, health: data.alive ? "alive" : "dead", lastCheckAt: Date.now() } : a))
    })
  }

  const handleCheckLive = async (email: string) => {
    await withSpin(email, "live", async () => {
      const r = await fetch(`/api/gateway/accounts/${encodeURIComponent(email)}/checklive?provider=${provider}`, { method: "POST" })
      const data = await r.json()
      setAccounts(prev => prev.map(a => a.email === email ? { ...a, liveStatus: data.status, lastCheckAt: Date.now() } : a))
    })
  }

  const handleRefreshQuota = async (email: string) => {
    await withSpin(email, "quota", async () => {
      const r = await fetch(`/api/gateway/quota/${encodeURIComponent(email)}?provider=${provider}`, { method: "POST" })
      const data = await r.json()
      if (data.ok) {
        setAccounts(prev => prev.map(a => {
          if (a.email !== email) return a
          const geminiPct = data.quota?.groups?.find((g: { name: string }) => /gemini/i.test(g.name))?.pct ?? undefined
          return { ...a, quota: data.quota, geminiPct }
        }))
      }
    })
  }

  // ── Bulk actions
  const handleBulkEnable = async (enabled: boolean, emails?: string[]) => {
    const body: Record<string, unknown> = { enabled }
    if (emails && emails.length > 0) body.emails = emails
    try {
      await fetch("/api/gateway/accounts/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      toast({ title: enabled ? "Đã bật tài khoản" : "Đã tắt tài khoản", variant: "success", description: emails?.length ? `${emails.length} account` : "tất cả" })
      fetchData()
    } catch {
      toast({ title: "Lỗi khi cập nhật", variant: "error" })
    }
  }

  const handleWake = async () => {
    try {
      await fetch("/api/gateway/accounts/wake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      })
      toast({ title: "Đã gửi lệnh wake", variant: "info" })
      fetchData()
    } catch {
      toast({ title: "Lỗi khi wake", variant: "error" })
    }
  }

  const handleBulkQuota = async () => {
    const emails = selected.size > 0 ? [...selected] : []
    await fetch("/api/gateway/quota/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(emails.length > 0 ? { emails } : {}),
    })
  }

  const startCheck = async (mode: "token" | "live" | "both") => {
    const emails = selected.size > 0 ? [...selected] : []
    const r = await fetch("/api/gateway/accounts/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emails, mode }),
    })
    const data = await r.json()
    setCheckProgress({ total: data.queued, done: 0 })
    // Subscribe to SSE for live updates
    if (evtRef.current) evtRef.current.close()
    const es = new EventSource("/events")
    evtRef.current = es
    es.addEventListener("check", (e) => {
      const ev = JSON.parse(e.data)
      if (ev.total) setCheckProgress({ total: ev.total, done: ev.done ?? 0 })
      if (ev.email) {
        setAccounts(prev => prev.map(a => {
          if (a.email !== ev.email) return a
          if (ev.kind === "token") return { ...a, health: ev.result, lastCheckAt: Date.now() }
          if (ev.kind === "live") return { ...a, liveStatus: ev.result, lastCheckAt: Date.now() }
          return a
        }))
      }
      if (ev.done >= ev.total) {
        setTimeout(() => setCheckProgress(null), 1500)
        es.close()
      }
    })
  }

  /**
   * Tab provider dựng theo account CÓ THẬT trong pool.
   *
   * Nhãn ưu tiên lấy từ `providerLabel` do backend gửi; không có thì dùng chính id — thà
   * hiện "no" còn hơn giấu mất cả nhóm account.
   */
  const NHAN: Record<string, string> = { agy: "Antigravity", kr: "Kiro", or: "OpenRouter", no: "Nous Research" }
  const tabProvider: Array<[string, string]> = [
    ...new Set(accounts.map(a => a.provider || "agy")),
  ].sort().map(id => [id, NHAN[id] ?? id])

  // ── Filter / sort / paginate
  const provAccounts = accounts.filter(a => (a.provider || "agy") === provider)

  // Nhãn cột hạn mức: tên bể đầu tiên của account đang xem, không đoán theo tên provider.
  const nhanQuota = provAccounts.find(a => a.quota?.groups?.length)?.quota?.groups?.[0]?.name
    ?? (provider === "kr" ? "Credit" : "Quota")

  const filtered = provAccounts.filter(a => {
    if (search && !a.email.toLowerCase().includes(search.toLowerCase())) return false
    if (filter === "on") return a.enabled
    if (filter === "off") return !a.enabled
    if (filter === "cooldown") return a.cooldown
    if (filter === "dead") return a.health === "dead"
    return true
  })

  // Không sắp xếp ở đây nữa — DataTable lo, và người dùng đổi được bằng click tiêu đề cột.
  const sorted = filtered


  const poolTotal = provAccounts.length
  const poolActive = provAccounts.filter(a => a.enabled && !a.cooldown).length
  const poolCooldown = provAccounts.filter(a => a.cooldown).length
  const poolInactive = poolTotal - poolActive - poolCooldown
  const pctActive = poolTotal > 0 ? Math.round((poolActive / poolTotal) * 100) : 0
  const pctCooldown = poolTotal > 0 ? Math.round((poolCooldown / poolTotal) * 100) : 0

  const statusBadge = (acc: PoolAccount) => {
    if (!acc.enabled) return <Badge className="bg-muted text-muted-foreground">Off</Badge>
    if (acc.cooldown) return <Badge className="bg-warning/15 text-warning">Cooldown</Badge>
    if (acc.health === "alive") return <Badge className="bg-success/15 text-success">Active</Badge>
    if (acc.health === "dead") return <Badge className="bg-destructive/15 text-destructive">Dead</Badge>
    return <Badge className="bg-muted text-muted-foreground">—</Badge>
  }

  const healthBadge = (h?: string) => {
    if (h === "alive") return <span className="text-success text-xs">● alive</span>
    if (h === "dead") return <span className="text-destructive text-xs">● dead</span>
    return <span className="text-muted-foreground text-xs">—</span>
  }

  const liveBadge = (s?: string) => {
    if (s === "ok") return <span className="text-success text-xs">✓ live</span>
    if (s === "quota") return <span className="text-warning text-xs">⏳ quota</span>
    if (s === "error") return <span className="text-destructive text-xs">✗ error</span>
    return <span className="text-muted-foreground text-xs">—</span>
  }

  // ── Loading ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 w-full bg-muted" />)}
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
        <button onClick={fetchData} className="text-xs text-primary hover:text-primary/80 flex items-center gap-1.5">
          <RefreshCw className="h-3 w-3" /> Retry
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* Tabs provider vào `actions` — nó là bộ lọc QUYẾT ĐỊNH toàn bộ dữ liệu bên dưới,
          để rời ra giữa trang thì người dùng thấy hai chỗ lọc ở hai nơi. */}
      <PageHeader
        title="Pool"
        desc="Account trong pool, sức khoẻ và hạn mức từng provider"
        actions={
          <div className="flex items-center gap-2">
            {tabProvider.map(([key, label]) => (
              <Button
                key={key}
                size="sm"
                onClick={() => setProvider(key)}
                className={provider === key
                  ? "h-8 bg-primary text-xs text-primary-foreground hover:bg-primary/90"
                  : "h-8 border border-border bg-transparent text-xs text-muted-foreground hover:bg-muted hover:text-foreground"}
              >
                {label}
              </Button>
            ))}
            <Badge className="bg-muted text-muted-foreground">{provAccounts.length}</Badge>
          </div>
        }
      />

      {/* KPI Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Tổng tài khoản" value={poolTotal} sub="Trong pool" icon={Users} />
        <KpiCard label="Sẵn sàng" value={poolActive} sub={`${pctActive}% tổng`} icon={Zap} tone="success" />
        <KpiCard label="Đang nghỉ" value={poolCooldown} sub={`${pctCooldown}% tổng`} icon={Snowflake} tone="warning" />
        <KpiCard label="Không dùng được" value={poolInactive} sub={poolTotal > 0 ? `${Math.round((poolInactive / poolTotal) * 100)}% tổng` : "—"} icon={AlertTriangle} tone="danger" />
      </div>

      {/* Gợi ý định tuyến: bể nào còn nhiều quota → nên ưu tiên model nào */}
      <RoutingHint />

      {/* Trước đây là 2 Card "Pool Distribution" + "Pool Health" hiện lại ĐÚNG 3 con số đã
          có ở hàng KPI ngay trên — ba lần biểu diễn cùng dữ liệu, đẩy bảng xuống ~700px.
          Một thanh phân bổ là đủ để thấy tỉ lệ. */}
      <SegmentBar
        segments={[
          { label: "Sẵn sàng", value: poolActive, tone: "success" },
          { label: "Cooldown", value: poolCooldown, tone: "warning" },
          { label: "Không dùng được", value: poolInactive, tone: "danger" },
        ]}
      />

      {/* Check progress bar */}
      {checkProgress && (
        <div className="flex items-center gap-3 bg-muted/60 rounded-lg px-4 py-2">
          <RefreshCw className="h-3.5 w-3.5 text-warning animate-spin" />
          <span className="text-xs text-foreground">Đang check…</span>
          <div className="flex-1 h-1.5 rounded-full bg-muted">
            <div
              className="h-full bg-warning rounded-full transition-all"
              style={{ width: `${checkProgress.total ? Math.round((checkProgress.done / checkProgress.total) * 100) : 0}%` }}
            />
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">{checkProgress.done}/{checkProgress.total}</span>
        </div>
      )}

      {/*
        MỘT thanh hành động duy nhất, thay vì trước đây có 6 nút trong toolbar VÀ 5 nút
        trong bulk-bar — 5 cặp trùng nghĩa, khác nhãn, khác màu, cách nhau 60 dòng
        (`Tắt` vs `All Off`). Không ai biết chúng khác nhau chỗ nào nếu không đọc code.

        Nhãn đổi theo ngữ cảnh: chưa chọn dòng nào thì áp cho TOÀN BỘ (các handler vốn đã
        làm vậy), chọn rồi thì áp cho phần đã chọn. Nói rõ trong nhãn để không bấm nhầm.
      */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 px-4 py-2">
        <span className="mr-1 text-xs text-muted-foreground">
          {selected.size > 0 ? `${selected.size} đã chọn` : `Toàn bộ ${sorted.length} account`}
        </span>
        <Button size="sm" onClick={() => handleBulkEnable(true, sel())} className="h-7 gap-1 bg-success text-xs text-success-foreground hover:bg-success">
          <Power className="h-3 w-3" /> Bật
        </Button>
        {/* Tắt hàng loạt KHÔNG hoàn tác được và mặc định áp cho cả 700 account → phải xác nhận. */}
        <Button size="sm" onClick={() => setConfirm("off")} className="h-7 gap-1 bg-muted text-xs text-foreground hover:bg-muted-foreground/40">
          <PowerOff className="h-3 w-3" /> Tắt
        </Button>
        <Button size="sm" onClick={handleWake} className="h-7 gap-1 bg-muted text-xs text-foreground hover:bg-muted-foreground/40">
          <Snowflake className="h-3 w-3" /> Gỡ cooldown
        </Button>
        <Button size="sm" onClick={handleBulkQuota} className="h-7 gap-1 bg-muted text-xs text-foreground hover:bg-muted-foreground/40">
          <Gauge className="h-3 w-3" /> Nạp quota
        </Button>
        <Button size="sm" onClick={() => startCheck("token")} className="h-7 gap-1 bg-muted text-xs text-foreground hover:bg-muted-foreground/40">
          <FlaskConical className="h-3 w-3" /> Test token
        </Button>
        {/* Quét live cả pool mất ~8 phút và chạy dày sẽ bị Google chặn tốc độ → xác nhận. */}
        <Button size="sm" onClick={() => (selected.size > 0 ? startCheck("live") : setConfirm("live"))} className="h-7 gap-1 bg-muted text-xs text-foreground hover:bg-muted-foreground/40">
          <Activity className="h-3 w-3" /> Check live
        </Button>
      </div>

      {/* Table */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <CardTitle className="text-sm font-medium text-foreground flex items-center gap-2">
              <Server className="h-4 w-4 text-muted-foreground" />
              Pool — {provider === "agy" ? "Antigravity" : "Kiro"} ({filtered.length})
            </CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              {/* Search */}
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Tìm email…"
                  value={search}
                  onChange={e => { setSearch(e.target.value); }}
                  className="pl-8 bg-muted border-border text-foreground placeholder:text-muted-foreground h-8 text-xs w-44"
                />
              </div>
              {/* Filter */}
              <Select value={filter} onValueChange={(v) => setFilter(v ?? "all")}>
                <SelectTrigger className="h-8 w-28 text-xs">
                  <span className="truncate">
                    {{ all: "Tất cả", on: "Bật", off: "Tắt", cooldown: "Cooldown", dead: "Dead" }[filter] ?? "Tất cả"}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {(["all", "on", "off", "cooldown", "dead"] as const).map((v) => (
                    <SelectItem key={v} value={v} className="text-xs">
                      {{ all: "Tất cả", on: "Bật", off: "Tắt", cooldown: "Cooldown", dead: "Dead" }[v]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* Bỏ dropdown sắp xếp — bảng đã sắp xếp bằng click tiêu đề cột (DataTable),
                  để cả hai là hai chỗ làm cùng một việc và dễ lệch nhau. */}
              <Button size="sm" onClick={fetchData} className="border border-border bg-transparent text-muted-foreground hover:text-warning h-8 text-xs gap-1">
                <RefreshCw className="h-3 w-3" /> Refresh
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable
            rows={sorted}
            rowKey={(a) => a.email}
            pageSize={pageSize}
            selection={{ selected, onChange: setSelected }}
            initialSort={{ key: "email", dir: "asc" }}
            empty={filter !== "all" || search ? "Không có account khớp" : "Chưa có account trong pool"}
            columns={[
              {
                key: "enabled",
                header: "On",
                sort: (a) => (a.enabled ? 1 : 0),
                render: (a) => (
                  <button
                    onClick={() => handleToggle(a, !a.enabled)}
                    disabled={spinning[a.email]?.toggle}
                    aria-label={a.enabled ? "Tắt account" : "Bật account"}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${a.enabled ? "bg-primary" : "bg-muted"}`}
                  >
                    <span className={`inline-block h-3.5 w-3.5 transform rounded-full transition-transform ${a.enabled ? "translate-x-4 bg-primary-foreground" : "translate-x-1 bg-foreground/60"}`} />
                  </button>
                ),
              },
              {
                key: "email",
                header: "Email",
                sort: (a) => a.email,
                render: (a) => (
                  <span className="block max-w-[220px] truncate font-mono text-sm text-foreground" title={a.email}>{a.email}</span>
                ),
              },
              {
                key: "quota",
                // Nhãn lấy từ bể thật của provider đang xem, không đoán theo tên.
                header: nhanQuota,
                sort: (a) => a.geminiPct ?? -1,
                render: (a) => (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {a.geminiPct != null ? (
                      <span className={a.geminiPct >= 50 ? "text-success" : a.geminiPct >= 20 ? "text-warning" : "text-destructive"}>
                        {a.geminiPct}%
                      </span>
                    ) : "—"}
                  </span>
                ),
              },
              { key: "status", header: "Status", render: (a) => statusBadge(a) },
              {
                key: "health",
                header: "Health / Live",
                sort: (a) => a.health ?? "",
                render: (a) => (
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-1">
                      {healthBadge(a.health)}
                      {liveBadge(a.liveStatus)}
                    </div>
                    {/* "alive" của 1 phút trước và của 3 ngày trước tin được khác hẳn
                        nhau — không có mốc này thì badge nói được rất ít. */}
                    {a.lastCheckAt ? (
                      <span
                        className="text-[10px] text-muted-foreground"
                        title={`Kiểm lúc ${new Date(a.lastCheckAt).toLocaleString("vi-VN")}`}
                      >
                        {fmtAgo(a.lastCheckAt)}
                      </span>
                    ) : (
                      <span className="text-[10px] text-muted-foreground/60">chưa kiểm</span>
                    )}
                  </div>
                ),
              },
              {
                key: "cooldown",
                header: "Cooldown",
                sort: (a) => a.cooldownUntil ?? 0,
                render: (a) => (
                  <span className="text-xs tabular-nums text-warning">{a.cooldown ? fmtCooldown(a.cooldownUntil) : "—"}</span>
                ),
              },
              {
                key: "requests",
                header: "Requests",
                align: "right",
                sort: (a) => a.requests ?? 0,
                render: (a) => <span className="text-sm tabular-nums text-muted-foreground">{fmtNum(a.requests ?? 0)}</span>,
              },
              {
                key: "lastUsed",
                header: "Last used",
                sort: (a) => a.lastUsed ?? 0,
                render: (a) => <span className="text-xs text-muted-foreground">{fmtAgo(a.lastUsed)}</span>,
              },
              {
                key: "actions",
                header: "",
                align: "right",
                render: (a) => {
                  const sp = spinning[a.email] ?? {}
                  return (
                    <div className="flex items-center justify-end gap-1">
                      <button
                        title="Test token"
                        onClick={() => handleTest(a.email)}
                        disabled={sp.test}
                        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-success disabled:opacity-50"
                      >
                        {sp.test ? <RefreshCw className="h-3 w-3 animate-spin" /> : <FlaskConical className="h-3 w-3" />}
                      </button>
                      <button
                        title="Check live"
                        onClick={() => handleCheckLive(a.email)}
                        disabled={sp.live}
                        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-warning disabled:opacity-50"
                      >
                        {sp.live ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
                      </button>
                      <button
                        title="Refresh quota"
                        onClick={() => handleRefreshQuota(a.email)}
                        disabled={sp.quota}
                        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-info disabled:opacity-50"
                      >
                        {sp.quota ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Gauge className="h-3 w-3" />}
                      </button>
                    </div>
                  )
                },
              },
            ]}
          />
        </CardContent>
      </Card>
      {/* Hai hành động không hoàn tác / tốn 8 phút — ConfirmDialog đã có sẵn ở common/ mà
          trang này chưa từng dùng, dù `All Off` tắt cả 700 account chỉ bằng một cú bấm. */}
      <ConfirmDialog
        open={confirm !== null}
        onCancel={() => setConfirm(null)}
        danger={confirm === "off"}
        title={confirm === "off" ? "Tắt account hàng loạt?" : "Quét live toàn bộ pool?"}
        desc={
          confirm === "off"
            ? `Sẽ tắt ${selected.size > 0 ? `${selected.size} account đã chọn` : `TOÀN BỘ ${sorted.length} account`}. Account đã tắt không nhận request cho tới khi bật lại.`
            : `Sẽ gọi thử lần lượt ${sorted.length} account — mất khoảng ${Math.max(1, Math.ceil(sorted.length * 1.2 / 60))} phút. Chạy quá dày có thể bị upstream chặn tốc độ.`
        }
        onConfirm={() => {
          if (confirm === "off") handleBulkEnable(false, sel())
          else startCheck("live")
          setConfirm(null)
        }}
      />

    </div>
  )
}
