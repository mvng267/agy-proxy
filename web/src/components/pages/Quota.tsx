import { useState, useCallback } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { POLL } from "@/lib/queryClient"
import { KpiCard, PageHeader } from "@/components/common"
import { DonutStat } from "@/components/common/charts"
import {
  Gauge,
  RefreshCw,
  AlertTriangle,
  Search,
  LayoutGrid,
  Table2,
  ChevronLeft,
  ChevronRight,
} from "lucide-react"
import { DataTable } from "@/components/common/DataTable"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { AutoDisablePanel } from "./quota/AutoDisablePanel"
import { QuotaHistory } from "./quota/QuotaHistory"

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

/** Tổng hợp hạn mức tách theo provider — hai bên có mô hình khác hẳn nhau. */
interface QuotaSummary {
  byProvider?: Record<string, {
    provider: string
    label: string
    /** 'buckets' = nhiều bể độc lập (Antigravity) · 'credits' = một quỹ chung (Kiro). */
    kind: "buckets" | "credits"
    fetched: number
    total: number
    tiers: Record<string, number>
    groups: Array<{ key: string; label: string; avg: number | null; min: number | null; n: number }>
  }>
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
  const qc = useQueryClient()
  /** Lọc theo provider — hai bên mô hình hạn mức khác hẳn, xem lẫn lộn là hiểu sai. */
  const [prov, setProv] = useState<string>("all")

  /**
   * Account đang xem lịch sử. Ở lại đây (không xuống `QuotaHistory`) vì CẢ HAI view —
   * bảng và thẻ — đều đặt được giá trị này khi bấm vào một dòng.
   */
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

  /**
   * React Query thay `fetch` trần + `setInterval`.
   *
   * `fetch` trần bỏ qua tầng xử lý 401 của `lib/api` — phiên hết hạn thì trang im lặng
   * thay vì quay về màn đăng nhập. `setInterval` cũng chạy tiếp khi tab ẩn.
   *
   * `?withModels=1`: trang này CẦN chi tiết từng model. Payload mặc định đã cắt
   * `quota.models[]` vì nó chiếm 62% kích thước mà chỉ trang này dùng.
   */
  const QK_ACC = ["quota-accounts"] as const
  const qAcc = useQuery({
    queryKey: QK_ACC,
    queryFn: () => api.get<{ accounts: PoolAccount[] }>("/api/gateway/accounts?withModels=1"),
    refetchInterval: POLL.normal,
  })
  const qSum = useQuery({
    queryKey: ["quota-summary"],
    queryFn: () => api.get<QuotaSummary>("/api/gateway/quota-summary"),
    refetchInterval: POLL.normal,
  })

  const accounts = qAcc.data?.accounts ?? []
  const summary = qSum.data
  const loading = qAcc.isLoading
  const error = qAcc.error ? (qAcc.error instanceof Error ? qAcc.error.message : String(qAcc.error)) : null
  const fetchAccounts = useCallback(() => {
    void qc.invalidateQueries({ queryKey: QK_ACC })
    void qc.invalidateQueries({ queryKey: ["quota-summary"] })
  }, [qc])
  /** Cập nhật lạc quan: bấm refresh một account thì thấy ngay, không đợi vòng poll kế. */
  const setAccounts = useCallback(
    (fn: (prev: PoolAccount[]) => PoolAccount[]) => {
      qc.setQueryData<{ accounts: PoolAccount[] }>(QK_ACC, (old) =>
        old ? { ...old, accounts: fn(old.accounts ?? []) } : old,
      )
    },
    [qc],
  )

  // ── Per-account quota refresh
  const handleRefreshOne = async (email: string) => {
    setRefreshing(prev => ({ ...prev, [email]: true }))
    try {
      // CỐ Ý `fetch` trần: endpoint trả 200 kèm `{ok:false, error}` khi nạp hỏng — đó là
      // thông điệp cần hiện cho người dùng, `api` sẽ ném và mất nó.
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
      const data = await api.post<{ queued?: number }>("/api/gateway/quota/refresh", emails.length > 0 ? { emails } : {})
      showToast(`Đang nạp hạn mức ${data.queued ?? "?"} account (nền)…`)
    } finally {
      setBulkRefreshing(false)
    }
  }

  // ── Filter / sort / paginate
  const filtered = accounts.filter(a =>
    (prov === "all" || a.provider === prov) &&
    (!search || a.email.toLowerCase().includes(search.toLowerCase()))
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

  /**
   * Dòng tóm tắt xu hướng ở cuối trang — chỉ theo MỘT provider.
   *
   * Series giờ có nhiều provider xen kẽ nhau (migration v6). Map thẳng thành mảng số như
   * bản cũ sẽ cho ra dãy nhảy loạn giữa agy 1% và kr 91%, và câu "hạn mức đang phục hồi"
   * tính trên hai điểm liền kề của HAI provider khác nhau — vô nghĩa.
   *
   * Ưu tiên `agy` vì đó là bể hay cạn nhất; không có thì lấy provider đầu tiên.
   */
  /**
   * Tab provider dựng theo DỮ LIỆU THẬT, không khoá cứng ['agy','kr'].
   *
   * Bản trước liệt kê tay hai provider, nên account của provider thứ ba (OpenRouter, Nous)
   * không có tab nào để xem — chúng nằm trong pool mà không lối vào trên giao diện.
   * `byProvider` đã mang sẵn nhãn hiển thị của từng provider.
   */
  const tabProvider: Array<[string, string]> = [
    ['all', 'Tất cả'],
    ...Object.values(summary?.byProvider ?? {})
      .map((p) => [p.provider, p.label] as [string, string])
      .sort((a, b) => a[0].localeCompare(b[0])),
  ]


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
      {toast && (
        <div className="fixed bottom-4 right-4 z-50 bg-muted border border-border text-foreground text-sm px-4 py-2 rounded-lg shadow-lg">
          {toast}
        </div>
      )}

      {/*
        MỘT nút nạp thay vì ba. Trước đây có `Refresh All` (header), `Tải lại` (header) và
        `Refresh quota` (bulk-bar) — cái thứ nhất và thứ ba gọi CÙNG một hàm
        `handleBulkRefresh`, chỉ khác nhãn và cách nhau 170 dòng.

        `Tải lại` giữ riêng vì nó khác nghĩa thật: chỉ đọc lại danh sách từ server, không
        gọi upstream nạp hạn mức.
      */}
      <PageHeader
        title="Hạn mức"
        desc={`Quota còn lại theo từng account · ${withQ.length}/${accounts.length} đã nạp`}
        actions={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={handleBulkRefresh}
              disabled={bulkRefreshing}
              className="h-8 gap-1.5 border border-border bg-transparent text-xs text-muted-foreground hover:text-warning"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${bulkRefreshing ? "animate-spin" : ""}`} />
              {selected.size > 0 ? `Nạp ${selected.size} đã chọn` : "Nạp tất cả"}
            </Button>
            <Button
              size="sm"
              onClick={fetchAccounts}
              title="Đọc lại danh sách từ server (không gọi upstream)"
              className="h-8 gap-1.5 border border-border bg-transparent text-xs text-muted-foreground hover:text-foreground"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Tải lại
            </Button>
          </div>
        }
      />

      {/* Tự tắt/bật account theo hạn mức — quét mỗi ngày. */}
      <AutoDisablePanel onDone={fetchAccounts} />

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
        {/*
          Thẻ dựng theo DỮ LIỆU, không cứng "Gemini/Claude".
          Antigravity có 2 bể độc lập theo tuần; Kiro có 1 quỹ credit theo tháng và
          KHÔNG có Gemini. Bản trước gộp cả 702 account vào một số "Gemini TB" — đúng
          số học, vô nghĩa về ý nghĩa. Thêm provider mới cũng không phải sửa chỗ này.
        */}
        {(summary?.byProvider ? Object.values(summary.byProvider) : []).flatMap((p) =>
          p.groups.map((g) => (
            <Card key={`${p.provider}-${g.key}`}>
              <CardContent className="flex items-center gap-4 pt-4">
                {g.avg != null && (
                  <DonutStat label={g.label} pct={g.avg} tone={g.key === 'gemini' ? 'success' : g.key === 'credits' ? 'warning' : 'info'} size={80} strokeWidth={8} />
                )}
                <div className="flex-1">
                  <QuotaBar pct={g.avg ?? undefined} />
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {p.label} · {g.n} account{g.min != null ? ` · thấp nhất ${g.min}%` : ""}
                  </p>
                </div>
              </CardContent>
            </Card>
          )),
        )}
      </div>

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 flex-wrap">
        {/* Lọc provider — hai bên mô hình hạn mức khác hẳn nhau (agy 2 bể theo tuần,
            kr 1 quỹ credit theo tháng), xem lẫn lộn dễ đọc nhầm số. */}
        <div className="flex items-center gap-1">
          {tabProvider.map(([k, label]) => (
            <button
              key={k}
              onClick={() => { setProv(k); setPage(1) }}
              className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                prov === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
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
            aria-label="Xem dạng bảng"
            title="Xem dạng bảng"
            aria-pressed={viewMode === "table"}
            className={`flex h-6 w-6 items-center justify-center rounded ${viewMode === "table" ? "bg-muted" : ""}`}
          >
            <Table2 className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
          <button
            onClick={() => setViewAndSave("card")}
            aria-label="Xem dạng thẻ"
            title="Xem dạng thẻ"
            aria-pressed={viewMode === "card"}
            className={`flex h-6 w-6 items-center justify-center rounded ${viewMode === "card" ? "bg-muted" : ""}`}
          >
            <LayoutGrid className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </div>
      </div>

      {/* ── TABLE VIEW ─────────────────────────────────────────────────────── */}
      {viewMode === "table" && (
        <Card>
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
                /*
                  Cột hạn mức phụ thuộc PROVIDER, không cứng "Gemini/Claude":
                    agy  2 bể độc lập theo tuần (Gemini · Claude+GPT)
                    kr   1 quỹ credit theo tháng, KHÔNG có Gemini
                  Trước đây account Kiro hiện cùng một con số ở cả hai cột — vì
                  `geminiPct()` với provider một bể trả về chính quỹ đó (cố ý, để
                  rotation xếp hạng được). Đúng cho việc chọn account, sai khi hiển thị.
                */
                {
                  key: "q1",
                  header: prov === "kr" ? "Credits" : prov === "agy" ? "Gemini" : "Hạn mức",
                  sort: (a) => a.geminiPct ?? -1,
                  render: (a) => (
                    <div className="flex items-center gap-2">
                      <QuotaBar pct={a.geminiPct} />
                      {prov === "all" && (
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {a.quota?.groups?.[0]?.name ?? (a.provider === "kr" ? "credit" : "gemini")}
                        </span>
                      )}
                    </div>
                  ),
                },
                {
                  key: "q2",
                  header: "Bể 2",
                  sort: (a) => claudePct(a) ?? -1,
                  /**
                   * Đọc từ CHÍNH dữ liệu quota, không đoán theo tên provider.
                   *
                   * Bản trước giả định "không phải kr thì có bể Claude" — đúng với agy,
                   * sai với mọi provider thêm sau. Nous có BỐN bể theo nhịp (req/tok ×
                   * phút/giờ), không có bể nào tên Claude.
                   */
                  render: (a) => {
                    const g = a.quota?.groups ?? []
                    if (g.length < 2) {
                      return <span className="text-xs text-muted-foreground/60" title="Provider này dùng một quỹ chung, không chia bể">—</span>
                    }
                    return (
                      <div className="flex items-center gap-2">
                        <QuotaBar pct={g[1]?.pct} />
                        {prov === "all" && (
                          <span className="shrink-0 text-[10px] text-muted-foreground">{g[1]?.name}</span>
                        )}
                      </div>
                    )
                  },
                },
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
                        {q && <Badge className="bg-muted text-muted-foreground mt-1">{tier}</Badge>}
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

      {/*
        Biểu đồ xu hướng là thông tin THAM KHẢO — đặt nó giữa KPI và bảng thì ở laptop
        1366×768 bảng account (thứ người dùng vào trang này để xem) nằm dưới nếp gấp.
        Chuyển xuống cuối, sau bảng.
      */}
      <QuotaHistory email={histEmail} onClear={() => setHistEmail(null)} />

    </div>
  )
}
