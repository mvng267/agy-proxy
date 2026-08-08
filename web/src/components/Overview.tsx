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
import { KpiCard } from "@/components/common"
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

function SvgBars({
  items,
  height = 90,
  color = "#f97316",
}: {
  items: Array<{ label: string; value: number }>
  height?: number
  color?: string
}) {
  if (!items.length) return <p className="text-xs text-muted-foreground text-center py-4">Chưa có dữ liệu</p>
  const w = 300
  const pad = 8
  const gap = items.length > 20 ? 1 : 2
  const max = Math.max(1, ...items.map((i) => i.value))
  const bw = Math.max(2, (w - 2 * pad) / items.length - gap)
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
      {items.map((item, i) => {
        const bh = ((item.value / max) * (height - 2 * pad))
        const x = pad + i * ((w - 2 * pad) / items.length)
        const y = height - pad - bh
        return bh <= 0 ? null : (
          <rect key={i} x={x.toFixed(1)} y={y.toFixed(1)} width={bw.toFixed(1)} height={bh.toFixed(1)} fill={color} rx="1" opacity="0.85">
            <title>{item.label}: {item.value}</title>
          </rect>
        )
      })}
    </svg>
  )
}

// ── SVG Donut ──────────────────────────────────────────────────────────

function Donut({ pct, label }: { pct?: number; label: string }) {
  const p = pct ?? 0
  const r = 34
  const c = 2 * Math.PI * r
  const off = c * (1 - p / 100)
  const col = p >= 50 ? "#22c55e" : p >= 20 ? "#f97316" : "#ef4444"
  return (
    <div className="flex flex-col items-center gap-1.5">
      <svg viewBox="0 0 90 90" className="w-20 h-20">
        <circle cx="45" cy="45" r={r} fill="none" stroke="#1e293b" strokeWidth="9" />
        <circle
          cx="45" cy="45" r={r} fill="none"
          stroke={pct == null ? "#475569" : col} strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={`${c.toFixed(1)}`}
          strokeDashoffset={off.toFixed(1)}
          transform="rotate(-90 45 45)"
          className="transition-all duration-700"
        />
        <text x="45" y="50" textAnchor="middle" fill="#f1f5f9" fontSize="14" fontWeight="600">
          {pct == null ? "—" : `${p}%`}
        </text>
      </svg>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  )
}

// ── Stacked health bar ─────────────────────────────────────────────────

function StackedBar({
  segments,
}: {
  segments: Array<{ label: string; value: number; color: string }>
}) {
  const total = segments.reduce((s, x) => s + (x.value || 0), 0)
  if (!total) return <div className="h-3 rounded-full bg-muted w-full" />
  return (
    <div className="space-y-1.5">
      <div className="flex h-3 rounded-full overflow-hidden">
        {segments.filter((s) => s.value > 0).map((s, i) => (
          <div
            key={i}
            className="transition-all duration-500"
            style={{ width: `${(s.value / total) * 100}%`, background: s.color }}
            title={`${s.label}: ${s.value}`}
          />
        ))}
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        {segments.map((s, i) => (
          <span key={i} className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />
            {s.label} {s.value}
          </span>
        ))}
      </div>
    </div>
  )
}

// ── H-Bar row ──────────────────────────────────────────────────────────

function HBar({ label, value, max, color = "bg-orange-500" }: { label: string; value: number; max: number; color?: string }) {
  const pct = max > 0 ? (value / max) * 100 : 0
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground font-mono truncate max-w-[200px]" title={label}>{label}</span>
        <span className="text-foreground tabular-nums ml-4 flex-shrink-0">{fmtNum(value)}</span>
      </div>
      <div className="h-1 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all duration-500`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

// ── DonutChart for pool health (existing) ─────────────────────────────

function DonutChart({
  total, active, cooldown, size = 100, strokeWidth = 10,
}: {
  total: number; active: number; cooldown: number; size?: number; strokeWidth?: number
}) {
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const center = size / 2

  if (total === 0) {
    return (
      <svg width={size} height={size} className="transform -rotate-90">
        <circle cx={center} cy={center} r={radius} fill="none" stroke="currentColor" strokeWidth={strokeWidth} className="text-border" />
      </svg>
    )
  }

  const activeRatio = active / total
  const cooldownRatio = cooldown / total
  const inactiveRatio = 1 - activeRatio - cooldownRatio
  const activeLen = circumference * activeRatio
  const cooldownLen = circumference * cooldownRatio
  const inactiveLen = circumference * inactiveRatio

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="transform -rotate-90">
        {active > 0 && (
          <circle cx={center} cy={center} r={radius} fill="none" stroke="#22c55e" strokeWidth={strokeWidth}
            strokeDasharray={`${activeLen} ${circumference - activeLen}`} strokeDashoffset={0}
            strokeLinecap="round" className="transition-all duration-700" />
        )}
        {cooldown > 0 && (
          <circle cx={center} cy={center} r={radius} fill="none" stroke="#f97316" strokeWidth={strokeWidth}
            strokeDasharray={`${cooldownLen} ${circumference - cooldownLen}`} strokeDashoffset={-(activeLen)}
            strokeLinecap="round" className="transition-all duration-700" />
        )}
        {inactiveRatio > 0 && (
          <circle cx={center} cy={center} r={radius} fill="none" stroke="#334155" strokeWidth={strokeWidth}
            strokeDasharray={`${inactiveLen} ${circumference - inactiveLen}`} strokeDashoffset={-(activeLen + cooldownLen)}
            className="transition-all duration-700" />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-xl font-bold text-foreground">{active}</span>
        <span className="text-[10px] text-muted-foreground uppercase tracking-wider">active</span>
      </div>
    </div>
  )
}

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
          <Badge variant={active > 0 ? "default" : "destructive"} className={active > 0 ? "bg-emerald-500/15 text-emerald-400 border-none text-[10px]" : "text-[10px]"}>
            {active > 0 ? "Online" : "Offline"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-6">
          <DonutChart total={total} active={active} cooldown={cooldown} size={90} strokeWidth={8} />
          <div className="flex-1 space-y-2 text-xs">
            {[
              { label: "Active", value: active, color: "bg-emerald-500" },
              { label: "Cooldown", value: cooldown, color: "bg-orange-500" },
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
            <span className="text-emerald-400 font-medium tabular-nums">{active} / {total} ({pctActive}%)</span>
          </div>
          <Progress value={pctActive}>
            <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-emerald-500 transition-all duration-500 rounded-full" style={{ width: `${pctActive}%` }} />
            </div>
          </Progress>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Cooldown</span>
            <span className="text-orange-400 font-medium tabular-nums">{cooldown} / {total} ({pctCooldown}%)</span>
          </div>
          <Progress value={pctCooldown}>
            <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-orange-500 transition-all duration-500 rounded-full" style={{ width: `${pctCooldown}%` }} />
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
                  <div className="h-full rounded-full bg-orange-500/70 transition-all duration-500"
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
        <AlertTriangle className="h-8 w-8 text-red-500" />
        <p className="text-sm text-muted-foreground">Error: {error}</p>
        <button onClick={fetchData} className="text-xs text-orange-400 hover:text-orange-300 flex items-center gap-1.5">
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
    { label: "Sẵn sàng", value: poolReady, color: "#22c55e" },
    { label: "Cooldown", value: poolCooldown, color: "#f97316" },
    { label: "Chết", value: poolDead, color: "#ef4444" },
    { label: "Tắt", value: poolOff, color: "#334155" },
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
            <StackedBar segments={poolSegments} />
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
                <Donut pct={quota.geminiAvg} label="Gemini" />
              )}
              {quota.thirdPartyAvg != null && (
                <Donut pct={quota.thirdPartyAvg} label="Claude/GPT" />
              )}
              {(quota.providers ?? []).map((p) => (
                <Donut key={p.label} pct={p.pct} label={p.label} />
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
              <>
                <SvgBars items={seriesItems} height={90} color="#f97316" />
                <div className="flex justify-between mt-1 text-[10px] text-muted-foreground">
                  <span>{usageSeries[0]?.bucket?.slice(5)}</span>
                  <span>{usageSeries[usageSeries.length - 1]?.bucket?.slice(5)}</span>
                </div>
              </>
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
                  const okColor = okRate >= 0.95 ? "bg-emerald-500" : okRate >= 0.8 ? "bg-amber-500" : "bg-red-500"
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
                            <div className="h-full rounded-full bg-purple-500 transition-all duration-500" style={{ width: `${Math.min(100, p95s / 3 * 100)}%` }} />
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
                  <HBar key={a.email} label={a.email} value={reqOf(a)} max={maxAccReq} color="bg-blue-500" />
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
                <HBar key={entry.label} label={entry.label} value={entry.n} max={maxProxyLoad} color="bg-muted-foreground/50" />
              ))}
            </div>
            {proxyLoadEntries[0]?.label === "(direct)" && proxyLoadEntries[0]?.n > 20 && (
              <p className="text-xs text-amber-400 mt-3">
                ⚠ {proxyLoadEntries[0].n} account dùng chung IP máy này — cân nhắc gán proxy
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
