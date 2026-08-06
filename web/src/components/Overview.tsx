import { useEffect, useState, useCallback } from "react"
import {
  Users,
  Zap,
  Activity,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Server,
  RefreshCw,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"

// ── Types ──────────────────────────────────────────────────────────────

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
  }
  gateway?: {
    pool?: {
      total?: number
      active?: number
      cooldown?: number
    }
    requests7d?: number
    requestsToday?: number
    models?: string[]
    topModels?: Array<{ model: string; count: number }>
  }
  poolAccounts?: ProviderAccount[]
}

// ── Donut Chart (CSS) ──────────────────────────────────────────────────

function DonutChart({
  total,
  active,
  cooldown,
  size = 100,
  strokeWidth = 10,
}: {
  total: number
  active: number
  cooldown: number
  size?: number
  strokeWidth?: number
}) {
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const center = size / 2

  if (total === 0) {
    return (
      <svg width={size} height={size} className="transform -rotate-90">
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          className="text-slate-700"
        />
      </svg>
    )
  }

  const activeRatio = active / total
  const cooldownRatio = cooldown / total
  const inactiveRatio = 1 - activeRatio - cooldownRatio

  const activeLen = circumference * activeRatio
  const cooldownLen = circumference * cooldownRatio
  const inactiveLen = circumference * inactiveRatio

  const activeOffset = 0
  const cooldownOffset = -(activeLen)
  const inactiveOffset = -(activeLen + cooldownLen)

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="transform -rotate-90">
        {/* Active - green */}
        {active > 0 && (
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke="#22c55e"
            strokeWidth={strokeWidth}
            strokeDasharray={`${activeLen} ${circumference - activeLen}`}
            strokeDashoffset={activeOffset}
            strokeLinecap="round"
            className="transition-all duration-700"
          />
        )}
        {/* Cooldown - orange */}
        {cooldown > 0 && (
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke="#f97316"
            strokeWidth={strokeWidth}
            strokeDasharray={`${cooldownLen} ${circumference - cooldownLen}`}
            strokeDashoffset={cooldownOffset}
            strokeLinecap="round"
            className="transition-all duration-700"
          />
        )}
        {/* Inactive - slate */}
        {inactiveRatio > 0 && (
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke="#334155"
            strokeWidth={strokeWidth}
            strokeDasharray={`${inactiveLen} ${circumference - inactiveLen}`}
            strokeDashoffset={inactiveOffset}
            className="transition-all duration-700"
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-xl font-bold text-slate-100">{active}</span>
        <span className="text-[10px] text-slate-500 uppercase tracking-wider">active</span>
      </div>
    </div>
  )
}

// ── KPI Card ───────────────────────────────────────────────────────────

function KpiCard({
  title,
  value,
  subtitle,
  icon: Icon,
  trend,
  trendLabel,
  color = "orange",
}: {
  title: string
  value: number | string
  subtitle?: string
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>
  trend?: "up" | "down" | "neutral"
  trendLabel?: string
  color?: "orange" | "green" | "blue" | "red"
}) {
  const colorMap = {
    orange: "bg-orange-500/10 text-orange-500",
    green: "bg-emerald-500/10 text-emerald-500",
    blue: "bg-blue-500/10 text-blue-500",
    red: "bg-red-500/10 text-red-500",
  }

  return (
    <Card className="bg-slate-900 border-slate-800">
      <CardContent className="pt-4">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">{title}</p>
            <p className="text-2xl font-bold text-slate-100 tabular-nums">{value}</p>
            {subtitle && <p className="text-xs text-slate-500">{subtitle}</p>}
          </div>
          <div className={`p-2 rounded-lg ${colorMap[color]}`}>
            <Icon className="h-4 w-4" />
          </div>
        </div>
        {trend && trendLabel && (
          <div className="mt-3 flex items-center gap-1.5 text-xs">
            {trend === "up" && <TrendingUp className="h-3 w-3 text-emerald-500" />}
            {trend === "down" && <TrendingDown className="h-3 w-3 text-red-500" />}
            <span className={trend === "up" ? "text-emerald-500" : trend === "down" ? "text-red-500" : "text-slate-500"}>
              {trendLabel}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── Provider Card ──────────────────────────────────────────────────────

function ProviderHealthCard({
  name,
  total,
  active,
  cooldown,
}: {
  name: string
  total: number
  active: number
  cooldown: number
}) {
  const inactive = total - active - cooldown

  return (
    <Card className="bg-slate-900 border-slate-800">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
            <Server className="h-4 w-4 text-slate-500" />
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
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                <span className="text-slate-400">Active</span>
              </span>
              <span className="font-medium text-slate-200 tabular-nums">{active}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-orange-500" />
                <span className="text-slate-400">Cooldown</span>
              </span>
              <span className="font-medium text-slate-200 tabular-nums">{cooldown}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-slate-600" />
                <span className="text-slate-400">Inactive</span>
              </span>
              <span className="font-medium text-slate-200 tabular-nums">{inactive}</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ── Pool Health Card ───────────────────────────────────────────────────

function PoolHealthCard({
  total,
  active,
  cooldown,
}: {
  total: number
  active: number
  cooldown: number
}) {
  const pctActive = total > 0 ? Math.round((active / total) * 100) : 0
  const pctCooldown = total > 0 ? Math.round((cooldown / total) * 100) : 0

  return (
    <Card className="bg-slate-900 border-slate-800">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
          <Activity className="h-4 w-4 text-slate-500" />
          Pool Health
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-400">Active</span>
            <span className="text-emerald-400 font-medium tabular-nums">{active} / {total} ({pctActive}%)</span>
          </div>
          <Progress value={pctActive}>
            <div className="relative h-2 w-full overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full bg-emerald-500 transition-all duration-500 rounded-full"
                style={{ width: `${pctActive}%` }}
              />
            </div>
          </Progress>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-400">Cooldown</span>
            <span className="text-orange-400 font-medium tabular-nums">{cooldown} / {total} ({pctCooldown}%)</span>
          </div>
          <Progress value={pctCooldown}>
            <div className="relative h-2 w-full overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full bg-orange-500 transition-all duration-500 rounded-full"
                style={{ width: `${pctCooldown}%` }}
              />
            </div>
          </Progress>
        </div>
      </CardContent>
    </Card>
  )
}

// ── Top Models Card ────────────────────────────────────────────────────

function TopModelsCard({ models }: { models: Array<{ model: string; count: number }> }) {
  const maxCount = Math.max(...models.map((m) => m.count), 1)

  return (
    <Card className="bg-slate-900 border-slate-800">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
          <Zap className="h-4 w-4 text-slate-500" />
          Top Models (7D)
        </CardTitle>
      </CardHeader>
      <CardContent>
        {models.length === 0 ? (
          <p className="text-xs text-slate-600 text-center py-4">No data</p>
        ) : (
          <div className="space-y-3">
            {models.slice(0, 6).map((m) => (
              <div key={m.model} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-400 truncate max-w-[60%]">{m.model}</span>
                  <span className="text-slate-300 font-medium tabular-nums">{m.count.toLocaleString()}</span>
                </div>
                <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-orange-500/70 transition-all duration-500"
                    style={{ width: `${(m.count / maxCount) * 100}%` }}
                  />
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

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 30_000)
    return () => clearInterval(interval)
  }, [fetchData])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="h-6 w-6 animate-spin text-slate-600" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <AlertTriangle className="h-8 w-8 text-red-500" />
        <p className="text-sm text-slate-400">Error: {error}</p>
        <button
          onClick={fetchData}
          className="text-xs text-orange-400 hover:text-orange-300 flex items-center gap-1.5"
        >
          <RefreshCw className="h-3 w-3" /> Retry
        </button>
      </div>
    )
  }

  const acc = data?.accounts ?? {}
  const gw = data?.gateway ?? {}
  const pool = gw.pool ?? { total: 0, active: 0, cooldown: 0 }
  const byProvider = acc.byProvider ?? {}

  // Get providers — default to Antigravity and Kiro if empty
  const providerNames = Object.keys(byProvider)
  const providers = providerNames.length > 0
    ? providerNames.map((name) => ({
        name,
        ...byProvider[name],
      }))
    : []

  const topModels = gw.topModels ?? []

  return (
    <div className="space-y-6">
      {/* KPI Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          title="Tài khoản"
          value={acc.total ?? 0}
          subtitle={`${acc.active ?? 0} active`}
          icon={Users}
          color="blue"
        />
        <KpiCard
          title="Pool hoạt động"
          value={pool.active ?? 0}
          subtitle={`/ ${pool.total ?? 0} total`}
          icon={Zap}
          color="green"
        />
        <KpiCard
          title="Requests 7D"
          value={(gw.requests7d ?? 0).toLocaleString()}
          subtitle={`${(gw.requestsToday ?? 0).toLocaleString()} today`}
          icon={Activity}
          color="orange"
          trend={gw.requestsToday != null && gw.requestsToday > 0 ? "up" : "neutral"}
          trendLabel={gw.requestsToday != null ? `${gw.requestsToday.toLocaleString()} today` : undefined}
        />
        <KpiCard
          title="Cooldown"
          value={pool.cooldown ?? 0}
          subtitle={pool.total ? `${Math.round(((pool.cooldown ?? 0) / pool.total) * 100)}% of pool` : "—"}
          icon={AlertTriangle}
          color="red"
        />
      </div>

      {/* Provider Health + Pool Health Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {providers.length > 0 ? (
          providers.slice(0, 2).map((p) => (
            <ProviderHealthCard
              key={p.name}
              name={p.name}
              total={p.total}
              active={p.active}
              cooldown={p.cooldown}
            />
          ))
        ) : (
          <>
            <ProviderHealthCard name="Antigravity" total={0} active={0} cooldown={0} />
            <ProviderHealthCard name="Kiro" total={0} active={0} cooldown={0} />
          </>
        )}
        <PoolHealthCard
          total={pool.total ?? 0}
          active={pool.active ?? 0}
          cooldown={pool.cooldown ?? 0}
        />
      </div>

      {/* Top Models */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TopModelsCard models={topModels} />
        {/* Placeholder for future charts */}
        <Card className="bg-slate-900 border-slate-800">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
              <Activity className="h-4 w-4 text-slate-500" />
              Request Trend
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-center h-48 text-slate-600 text-xs">
              Chart coming soon
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
