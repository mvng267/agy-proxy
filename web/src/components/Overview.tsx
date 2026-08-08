import { useEffect, useState, useCallback } from "react"
import {
  Users,
  Zap,
  Activity,
  AlertTriangle,
  Server,
  RefreshCw,
  BarChart3,
  Cpu,
  Globe,
} from "lucide-react"
import { KpiCard, PageHeader } from "@/components/common"
import { DonutStat, PoolDonut, RankBar, SegmentBar, TimeSeries } from "@/components/common/charts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"

// ── Types ──────────────────────────────────────────────────────────────

interface QuotaProvider {
  label: string
  pct?: number
  reset?: string
}

interface SeriesPoint {
  bucket: string
  requests?: number
  tokIn?: number
  tokOut?: number
}

interface PerfProvider {
  label: string
  n?: number
  okRate?: number
  p95?: number
  latency?: number
}

interface ProviderAccount {
  email: string
  provider: string
  status: string
  cooldownUntil?: string
  model?: string
  requestCount?: number
}

interface OverviewData {
  accounts?: {
    total?: number
    active?: number
    cooldown?: number
    byProvider?: Record<string, { total: number; active: number; cooldown: number }>
    counts?: Record<string, { ok?: number; total?: number; cooldown?: number; dead?: number }>
  }
  gateway?: {
    // /api/overview hiện trả các trường PHẲNG; `pool` lồng là shape của bản cũ,
    // giữ lại để dashboard cũ (nếu còn) không vỡ.
    total?: number
    enabled?: number
    cooldown?: number
    dead?: number
    requests?: number
    tokens?: number
    pool?: {
      total?: number
      active?: number
      cooldown?: number
      enabled?: number
      dead?: number
    }
    requests7d?: number
    requestsToday?: number
    models?: string[]
    topModels?: Array<{ model: string; count: number; requests?: number }>
    topAccounts?: Array<{ email: string; count: number; requests?: number; tokIn?: number; tokOut?: number }>
  }
  poolAccounts?: ProviderAccount[]

  // from /api/overview
  providers?: Array<{
    id: string
    label: string
    ready?: number
    total?: number
    cooldown?: number
    quotaAvg?: number
    requests?: number
    tokens?: number
    estimated?: boolean
    probeOk?: number
  }>
  quota?: {
    geminiAvg?: number
    thirdPartyAvg?: number
    tier?: string
    fetched?: number
    geminiReset?: string
    thirdPartyReset?: string
    providers?: QuotaProvider[]
  }
  usage?: {
    totals?: { requests?: number; tokIn?: number; tokOut?: number }
    series?: SeriesPoint[]
    byModel?: Array<{ model: string; requests?: number; count?: number; tokIn?: number; tokOut?: number }>
    byAccount?: Array<{ email: string; requests?: number; count?: number; tokIn?: number; tokOut?: number }>
  }
  proxyLoad?: Record<string, number>
  perf?: PerfProvider[]
}

// ── Helpers ────────────────────────────────────────────────────────────

function fmtNum(n: number | undefined) {
  if (n == null) return "—"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function fmtReset(iso?: string | null) {
  if (!iso) return ""
  const d = new Date(iso).getTime() - Date.now()
  if (d <= 0) return "đã reset"
  const days = Math.floor(d / 86400000)
  const hrs = Math.floor((d % 86400000) / 3600000)
  return days > 0 ? `${days}d ${hrs}h` : `${hrs}h`
}

function reqOf(item: { requests?: number; count?: number }): number {
  return item.requests ?? item.count ?? 0
}

// ── SVG Bars ───────────────────────────────────────────────────────────


// ── SVG Donut ──────────────────────────────────────────────────────────

// ── Stacked health bar ─────────────────────────────────────────────────


// ── H-Bar row ──────────────────────────────────────────────────────────


// ── DonutChart for pool health (existing) ─────────────────────────────


// ── KPI Card ───────────────────────────────────────────────────────────


// ── Provider Health Card ───────────────────────────────────────────────

function ProviderHealthCard({
  name, total, active, cooldown,
}: {
  name: string; total: number; active: number; cooldown: number
}) {
  const inactive = total - active - cooldown
  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium text-foreground flex items-center gap-2">
            <Server className="h-4 w-4 text-muted-foreground" />
            {name}
          </CardTitle>
          <Badge variant={active > 0 ? "default" : "destructive"} className={active > 0 ? "bg-success/15 text-success border-none text-[10px]" : "text-[10px]"}>
            {active > 0 ? "Online" : "Offline"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-6">
          <PoolDonut
            center={active}
            size={90}
            strokeWidth={8}
            segments={[
              { label: "Active", value: active, tone: "success" },
              { label: "Cooldown", value: cooldown, tone: "warning" },
              { label: "Inactive", value: Math.max(0, total - active - cooldown), tone: "danger" },
            ]}
          />
          <div className="flex-1 space-y-2 text-xs">
            {[
              { label: "Active", value: active, color: "bg-success" },
              { label: "Cooldown", value: cooldown, color: "bg-warning" },
              { label: "Inactive", value: inactive, color: "bg-muted-foreground/40" },
            ].map((row) => (
              <div key={row.label} className="flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <span className={`h-2 w-2 rounded-full ${row.color}`} />
                  <span className="text-muted-foreground">{row.label}</span>
                </span>
                <span className="font-medium text-foreground tabular-nums">{row.value}</span>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ── Pool Health Card ───────────────────────────────────────────────────

function PoolHealthCard({ total, active, cooldown }: { total: number; active: number; cooldown: number }) {
  const pctActive = total > 0 ? Math.round((active / total) * 100) : 0
  const pctCooldown = total > 0 ? Math.round((cooldown / total) * 100) : 0
  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-foreground flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          Pool Health
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Active</span>
            <span className="text-success font-medium tabular-nums">{active} / {total} ({pctActive}%)</span>
          </div>
          <Progress value={pctActive}>
            <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-success transition-all duration-500 rounded-full" style={{ width: `${pctActive}%` }} />
            </div>
          </Progress>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Cooldown</span>
            <span className="text-warning font-medium tabular-nums">{cooldown} / {total} ({pctCooldown}%)</span>
          </div>
          <Progress value={pctCooldown}>
            <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-warning transition-all duration-500 rounded-full" style={{ width: `${pctCooldown}%` }} />
            </div>
          </Progress>
        </div>
      </CardContent>
    </Card>
  )
}

// ── Top Models Card ────────────────────────────────────────────────────

function TopModelsCard({ models }: { models: Array<{ model: string; count: number; requests?: number }> }) {
  const maxCount = Math.max(...models.map((m) => m.requests ?? m.count), 1)
  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-foreground flex items-center gap-2">
          <Zap className="h-4 w-4 text-muted-foreground" />
          Top Models (7D)
        </CardTitle>
      </CardHeader>
      <CardContent>
        {models.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">No data</p>
        ) : (
          <div className="space-y-3">
            {models.slice(0, 6).map((m) => (
              <div key={m.model} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground truncate max-w-[60%] font-mono">{m.model}</span>
                  <span className="text-foreground font-medium tabular-nums">{(m.requests ?? m.count).toLocaleString()}</span>
                </div>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div className="h-full rounded-full bg-chart-2/70 transition-all duration-500"
                    style={{ width: `${((m.requests ?? m.count) / maxCount) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── Overview Page ──────────────────────────────────────────────────────

export function Overview() {
  const [data, setData] = useState<OverviewData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Stats (for perf chart)
  const [stats, setStats] = useState<{ providers?: PerfProvider[] } | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/overview")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as OverviewData
      setData(json)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch")
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/gateway/stats?days=1")
      if (!res.ok) return
      const json = await res.json() as { providers?: PerfProvider[] }
      setStats(json)
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    fetchData()
    fetchStats()
    const interval = setInterval(() => { fetchData(); fetchStats() }, 30_000)
    return () => clearInterval(interval)
  }, [fetchData, fetchStats])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <AlertTriangle className="h-8 w-8 text-destructive" />
        <p className="text-sm text-muted-foreground">Error: {error}</p>
        <button onClick={fetchData} className="text-xs text-warning hover:text-warning flex items-center gap-1.5">
          <RefreshCw className="h-3 w-3" /> Retry
        </button>
      </div>
    )
  }

  // ── Data extraction ────────────────────────────────────────────────

  const acc = data?.accounts ?? {}
  const gw = data?.gateway ?? {}
  // /api/overview trả gateway PHẲNG {total,enabled,cooldown,dead}; shape cũ lồng
  // trong .pool. Đọc cả hai — trước đây chỉ đọc .pool nên toàn dashboard hiện 0.
  const pool = {
    total: gw.pool?.total ?? gw.total ?? 0,
    enabled: gw.pool?.enabled ?? gw.enabled ?? 0,
    cooldown: gw.pool?.cooldown ?? gw.cooldown ?? 0,
    dead: gw.pool?.dead ?? gw.dead ?? 0,
    active: gw.pool?.active,
  }
  const apiProviders = data?.providers ?? []
  const byProvider = acc.byProvider ?? {}
  const providers = apiProviders.length > 0
    ? apiProviders.map((p) => ({
        name: p.label ?? p.id,
        total: p.total ?? 0,
        active: p.ready ?? 0,
        cooldown: p.cooldown ?? 0,
      }))
    : Object.keys(byProvider).map((name) => ({ name, ...byProvider[name]! }))
  // "Sẵn sàng" = enabled + không dead + hết cooldown, tính sẵn từng provider ở backend.
  const poolReady = apiProviders.length > 0
    ? apiProviders.reduce((s, p) => s + (p.ready ?? 0), 0)
    : (pool.active ?? 0)

  const topModels = gw.topModels ?? []

  // Usage from /api/overview
  const usageSeries: SeriesPoint[] = data?.usage?.series ?? []
  const usageByModel = data?.usage?.byModel ?? []
  const usageByAccount = data?.usage?.byAccount ?? []
  const usageTotals = data?.usage?.totals ?? {}

  // Quota
  const quota = data?.quota ?? {}

  // Perf from stats
  const perfProviders = stats?.providers ?? []

  // Proxy load
  const proxyLoadEntries = Object.entries(data?.proxyLoad ?? {})
    .map(([label, n]) => ({ label, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 8)

  // ── Stacked pool bar ───────────────────────────────────────────────

  const poolEnabled = pool.enabled || pool.active || 0
  const poolCooldown = pool.cooldown
  const poolDead = pool.dead
  const poolTotal = pool.total
  const poolOff = Math.max(0, poolTotal - poolEnabled)

  const poolSegments = [
    { label: "Sẵn sàng", value: poolReady, tone: "success" as const },
    { label: "Cooldown", value: poolCooldown, tone: "warning" as const },
    { label: "Chết", value: poolDead, tone: "danger" as const },
    { label: "Tắt", value: poolOff, tone: "muted" as const },
  ]

  // "Hôm nay" trên KPI Requests: API không có trường riêng — lấy bucket cuối
  // của series 7 ngày (bucket theo ngày, phần tử cuối chính là hôm nay).
  const todayReq = gw.requestsToday ?? usageSeries[usageSeries.length - 1]?.requests

  // Series bar items
  const seriesItems = usageSeries.map((s) => ({
    label: s.bucket,
    value: s.requests ?? 0,
  }))

  // const maxModelReq = Math.max(1, ...usageByModel.map(reqOf))
  const maxAccReq = Math.max(1, ...usageByAccount.map(reqOf))
  const maxProxyLoad = Math.max(1, ...proxyLoadEntries.map((x) => x.n))

  return (
    <div className="space-y-4">
      <PageHeader title="Dashboard" desc="Tổng quan pool, lưu lượng và sức khoẻ hệ thống" />
      {/* ── KPI Row ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Tài khoản"
          value={acc.total ?? 0}
          sub={acc.counts
            ? `${acc.counts.agy?.ok ?? 0} agy ok · ${acc.counts.kiro?.ok ?? 0} kiro ok`
            : `${acc.active ?? 0} active`}
          icon={Users}
        />
        <KpiCard
          label="Pool hoạt động"
          value={poolReady}
          sub={`/ ${poolTotal} total`}
          icon={Zap}
          tone="success"
        />
        <KpiCard
          label="Requests 7D"
          value={fmtNum(gw.requests7d ?? usageTotals.requests)}
          sub={`${fmtNum(todayReq)} hôm nay`}
          icon={Activity}
          spark={usageSeries.slice(-14).map((d) => reqOf(d))}
        />
        <KpiCard
          label="Cooldown"
          value={poolCooldown}
          sub={poolTotal ? `${Math.round((poolCooldown / poolTotal) * 100)}% của pool` : "—"}
          icon={AlertTriangle}
          tone={poolCooldown > 0 ? "warning" : "default"}
        />
      </div>

      {/* ── Provider Health + Pool Health ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {providers.length > 0 ? (
          providers.slice(0, 2).map((p) => (
            <ProviderHealthCard key={p.name} name={p.name} total={p.total} active={p.active} cooldown={p.cooldown} />
          ))
        ) : (
          <>
            <ProviderHealthCard name="Antigravity" total={0} active={0} cooldown={0} />
            <ProviderHealthCard name="Kiro" total={0} active={0} cooldown={0} />
          </>
        )}
        <PoolHealthCard total={poolTotal} active={poolReady} cooldown={poolCooldown} />
      </div>

      {/* ── Pool Health Stacked Bar ── */}
      {poolTotal > 0 && (
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-foreground flex items-center gap-2">
              <Activity className="h-4 w-4 text-muted-foreground" />
              Phân bổ pool
            </CardTitle>
          </CardHeader>
          <CardContent>
            <SegmentBar segments={poolSegments} />
          </CardContent>
        </Card>
      )}

      {/* ── Quota Donuts ── */}
      {(quota.geminiAvg != null || quota.thirdPartyAvg != null || (quota.providers ?? []).length > 0) && (
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-foreground flex items-center gap-2">
              <Cpu className="h-4 w-4 text-muted-foreground" />
              Hạn mức (Quota)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-6 flex-wrap">
              {quota.geminiAvg != null && (
                <DonutStat pct={quota.geminiAvg} label="Gemini" />
              )}
              {quota.thirdPartyAvg != null && (
                <DonutStat pct={quota.thirdPartyAvg} label="Claude/GPT" />
              )}
              {(quota.providers ?? []).map((p) => (
                <DonutStat key={p.label} pct={p.pct} label={p.label} />
              ))}
            </div>
            <div className="mt-3 space-y-0.5 text-xs text-muted-foreground">
              {quota.fetched != null && (
                <p>{quota.fetched}/{poolTotal || (acc.total ?? 0)} pool entry đã nạp hạn mức</p>
              )}
              {quota.tier && <p>Tier: {quota.tier}</p>}
              {quota.geminiReset && (
                <p>Gemini reset: {fmtReset(quota.geminiReset)}</p>
              )}
              {quota.thirdPartyReset && (
                <p>Claude/GPT reset: {fmtReset(quota.thirdPartyReset)}</p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Request bars + Top Models ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Requests 7d bars */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-foreground flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
              Requests 7 ngày
            </CardTitle>
          </CardHeader>
          <CardContent>
            {seriesItems.length > 0 ? (
              <TimeSeries
                data={usageSeries.map((x) => ({ ngay: x.bucket?.slice(5) ?? "", requests: x.requests ?? 0 }))}
                xKey="ngay"
                series={[{ key: "requests", label: "Request" }]}
                height={180}
              />
            ) : (
              <p className="text-xs text-muted-foreground text-center py-8">Chưa có dữ liệu</p>
            )}
          </CardContent>
        </Card>

        <TopModelsCard models={topModels.length > 0 ? topModels : usageByModel.slice(0, 6).map((m) => ({ model: m.model ?? (m as { model?: string }).model ?? "", count: reqOf(m), requests: reqOf(m) }))} />
      </div>

      {/* ── Provider Perf + Top Accounts ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Provider performance */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-foreground flex items-center gap-2">
              <Activity className="h-4 w-4 text-muted-foreground" />
              Hiệu năng provider (24h)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {perfProviders.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-6">Chưa có lệnh gọi trong 24h</p>
            ) : (
              <div className="space-y-4">
                {perfProviders.map((p) => {
                  const okRate = p.okRate ?? 0
                  const p95s = (p.p95 ?? p.latency ?? 0) / 1000
                  const okColor = okRate >= 0.95 ? "bg-success" : okRate >= 0.8 ? "bg-warning" : "bg-destructive"
                  return (
                    <div key={p.label} className="space-y-2">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium text-foreground">{p.label}</span>
                        <span className="text-muted-foreground">{p.n ?? 0} lượt gọi</span>
                      </div>
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-muted-foreground w-14 flex-shrink-0">Tỉ lệ ok</span>
                          <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                            <div className={`h-full rounded-full ${okColor} transition-all duration-500`} style={{ width: `${Math.round(okRate * 100)}%` }} />
                          </div>
                          <span className="text-foreground w-8 text-right tabular-nums">{Math.round(okRate * 100)}%</span>
                        </div>
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-muted-foreground w-14 flex-shrink-0">p95 độ trễ</span>
                          <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                            <div className="h-full rounded-full bg-info transition-all duration-500" style={{ width: `${Math.min(100, p95s / 3 * 100)}%` }} />
                          </div>
                          <span className="text-foreground w-12 text-right tabular-nums">{p95s.toFixed(1)}s</span>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Top Accounts */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-foreground flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              Top Accounts (7D)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {usageByAccount.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-6">Chưa có dữ liệu</p>
            ) : (
              <div className="space-y-3">
                {usageByAccount.slice(0, 6).map((a) => (
                  <RankBar key={a.email} label={a.email} value={reqOf(a)} max={maxAccReq} tone="chart-info" />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Proxy Load ── */}
      {proxyLoadEntries.length > 0 && (
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-foreground flex items-center gap-2">
              <Globe className="h-4 w-4 text-muted-foreground" />
              Phân bổ tải theo proxy / IP
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {proxyLoadEntries.map((entry) => (
                <RankBar key={entry.label} label={entry.label} value={entry.n} max={maxProxyLoad} tone="chart-muted" />
              ))}
            </div>
            {proxyLoadEntries[0]?.label === "(direct)" && proxyLoadEntries[0]?.n > 20 && (
              <p className="text-xs text-warning mt-3">
                ⚠ {proxyLoadEntries[0].n} account dùng chung IP máy này — cân nhắc gán proxy
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
