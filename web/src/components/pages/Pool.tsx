import { useEffect, useState, useCallback } from "react"
import {
  Zap,
  Users,
  AlertTriangle,
  RefreshCw,
  Activity,
  Server,
  Snowflake,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
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

interface PoolAccount {
  email: string
  provider: string
  status: string
  cooldownUntil?: string
  model?: string
  requestCount?: number
}

interface PoolData {
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
  }
  poolAccounts?: PoolAccount[]
}

// ── Donut Chart ────────────────────────────────────────────────────────

function DonutChart({
  total,
  active,
  cooldown,
  size = 120,
  strokeWidth = 12,
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
      <div className="relative" style={{ width: size, height: size }}>
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
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-bold text-slate-500">0</span>
          <span className="text-[10px] text-slate-600 uppercase tracking-wider">total</span>
        </div>
      </div>
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
        <span className="text-2xl font-bold text-slate-100">{active}</span>
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
  color = "orange",
}: {
  title: string
  value: number | string
  subtitle?: string
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>
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
      </CardContent>
    </Card>
  )
}

// ── Pool Page ──────────────────────────────────────────────────────────

export function Pool() {
  const [data, setData] = useState<PoolData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/overview")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as PoolData
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

  const handleWake = async (provider: string) => {
    try {
      await fetch("/api/gateway/accounts/wake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      })
      fetchData()
    } catch {
      // ignore
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full bg-slate-800" />
          ))}
        </div>
        <Skeleton className="h-64 w-full bg-slate-800" />
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

  const pool = data?.gateway?.pool ?? { total: 0, active: 0, cooldown: 0 }
  const poolTotal = pool.total ?? 0
  const poolActive = pool.active ?? 0
  const poolCooldown = pool.cooldown ?? 0
  const poolInactive = poolTotal - poolActive - poolCooldown

  const pctActive = poolTotal > 0 ? Math.round((poolActive / poolTotal) * 100) : 0
  const pctCooldown = poolTotal > 0 ? Math.round((poolCooldown / poolTotal) * 100) : 0

  const byProvider = data?.accounts?.byProvider ?? {}
  const poolAccounts = data?.poolAccounts ?? []

  const statusBadge = (status: string) => {
    switch (status) {
      case "active":
        return <Badge className="bg-emerald-500/15 text-emerald-400 border-none text-[10px]">Active</Badge>
      case "cooldown":
        return <Badge className="bg-orange-500/15 text-orange-400 border-none text-[10px]">Cooldown</Badge>
      default:
        return <Badge className="bg-slate-700 text-slate-400 border-none text-[10px]">{status}</Badge>
    }
  }

  return (
    <div className="space-y-6">
      {/* KPI Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          title="Pool Total"
          value={poolTotal}
          subtitle="Tổng tài khoản trong pool"
          icon={Users}
          color="blue"
        />
        <KpiCard
          title="Active"
          value={poolActive}
          subtitle={`${pctActive}% of pool`}
          icon={Zap}
          color="green"
        />
        <KpiCard
          title="Cooldown"
          value={poolCooldown}
          subtitle={`${pctCooldown}% of pool`}
          icon={Snowflake}
          color="orange"
        />
        <KpiCard
          title="Inactive"
          value={poolInactive}
          subtitle={poolTotal > 0 ? `${Math.round((poolInactive / poolTotal) * 100)}% of pool` : "—"}
          icon={AlertTriangle}
          color="red"
        />
      </div>

      {/* Donut + Health + Provider Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Donut */}
        <Card className="bg-slate-900 border-slate-800">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
              <Zap className="h-4 w-4 text-slate-500" />
              Pool Distribution
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-6">
              <DonutChart total={poolTotal} active={poolActive} cooldown={poolCooldown} size={110} strokeWidth={10} />
              <div className="flex-1 space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    <span className="text-slate-400">Active</span>
                  </span>
                  <span className="font-medium text-slate-200 tabular-nums">{poolActive}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-orange-500" />
                    <span className="text-slate-400">Cooldown</span>
                  </span>
                  <span className="font-medium text-slate-200 tabular-nums">{poolCooldown}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-slate-600" />
                    <span className="text-slate-400">Inactive</span>
                  </span>
                  <span className="font-medium text-slate-200 tabular-nums">{poolInactive}</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Health Bars */}
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
                <span className="text-emerald-400 font-medium tabular-nums">{poolActive} / {poolTotal} ({pctActive}%)</span>
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
                <span className="text-orange-400 font-medium tabular-nums">{poolCooldown} / {poolTotal} ({pctCooldown}%)</span>
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

        {/* Provider Breakdown */}
        <Card className="bg-slate-900 border-slate-800">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
                <Server className="h-4 w-4 text-slate-500" />
                Providers
              </CardTitle>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleWake("agy")}
                  className="border-slate-700 text-slate-400 hover:text-orange-400 h-6 text-[10px] gap-1 px-2"
                >
                  <Snowflake className="h-3 w-3" /> Wake AGY
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleWake("kiro")}
                  className="border-slate-700 text-slate-400 hover:text-orange-400 h-6 text-[10px] gap-1 px-2"
                >
                  <Snowflake className="h-3 w-3" /> Wake Kiro
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {Object.keys(byProvider).length === 0 ? (
              <p className="text-xs text-slate-600 text-center py-4">Không có dữ liệu provider</p>
            ) : (
              Object.entries(byProvider).map(([name, stats]) => (
                <div key={name} className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-300 font-medium">{name}</span>
                    <Badge
                      className={
                        stats.active > 0
                          ? "bg-emerald-500/15 text-emerald-400 border-none text-[10px]"
                          : "bg-slate-700 text-slate-400 border-none text-[10px]"
                      }
                    >
                      {stats.active}/{stats.total}
                    </Badge>
                  </div>
                  <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-emerald-500/70 transition-all duration-500"
                      style={{ width: stats.total > 0 ? `${(stats.active / stats.total) * 100}%` : "0%" }}
                    />
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* Pool Accounts Table */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
              <Users className="h-4 w-4 text-slate-500" />
              Pool Accounts ({poolAccounts.length})
            </CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={fetchData}
              className="border-slate-700 text-slate-400 hover:text-orange-400 h-7 text-xs gap-1"
            >
              <RefreshCw className="h-3 w-3" /> Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="border-slate-800 hover:bg-transparent">
                <TableHead className="text-slate-500 text-xs">Email</TableHead>
                <TableHead className="text-slate-500 text-xs">Provider</TableHead>
                <TableHead className="text-slate-500 text-xs">Status</TableHead>
                <TableHead className="text-slate-500 text-xs">Model</TableHead>
                <TableHead className="text-slate-500 text-xs text-right">Requests</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {poolAccounts.length === 0 ? (
                <TableRow className="border-slate-800">
                  <TableCell colSpan={5} className="text-center text-slate-600 text-xs py-8">
                    Không có tài khoản trong pool
                  </TableCell>
                </TableRow>
              ) : (
                poolAccounts.map((acc) => (
                  <TableRow key={acc.email} className="border-slate-800 hover:bg-slate-800/50">
                    <TableCell className="text-sm text-slate-200 font-mono">{acc.email}</TableCell>
                    <TableCell>
                      <Badge className="bg-slate-700 text-slate-300 border-none text-[10px]">
                        {acc.provider}
                      </Badge>
                    </TableCell>
                    <TableCell>{statusBadge(acc.status)}</TableCell>
                    <TableCell className="text-xs text-slate-400 font-mono">
                      {acc.model ?? "—"}
                    </TableCell>
                    <TableCell className="text-right text-sm text-slate-400 tabular-nums">
                      {(acc.requestCount ?? 0).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
