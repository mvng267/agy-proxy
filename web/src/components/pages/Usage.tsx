import { useEffect, useState, useCallback } from "react"
import {
  BarChart3,
  RefreshCw,
  AlertTriangle,
  Download,
  Users,
  Cpu,
  Activity,
  TrendingUp,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

// ── Types ──────────────────────────────────────────────────────────────

interface ModelUsage {
  model: string
  requests?: number
  count?: number       // old field compat
  tokIn?: number
  tokOut?: number
}

interface AccountUsage {
  email: string
  provider?: string
  requests?: number
  count?: number
  tokIn?: number
  tokOut?: number
}

interface SeriesPoint {
  bucket: string        // date label e.g. "2025-07-01"
  requests?: number
  tokIn?: number
  tokOut?: number
}

interface UsageTotals {
  requests?: number
  tokIn?: number
  tokOut?: number
  accounts?: number
}

interface UsageData {
  // new API shape (range= param)
  series?: SeriesPoint[]
  byModel?: ModelUsage[]
  byAccount?: AccountUsage[]
  totals?: UsageTotals

  // old API compat (days= param)
  models?: ModelUsage[]
  accounts?: AccountUsage[]
  total?: number
  days?: number
}

// ── Helpers ────────────────────────────────────────────────────────────

function fmtNum(n: number | undefined) {
  if (n == null) return "—"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function reqOf(item: ModelUsage | AccountUsage): number {
  return (item as ModelUsage).requests ?? item.count ?? 0
}

// ── SVG Bars chart (pure, no deps) ─────────────────────────────────────

interface BarItem {
  label: string
  value: number
}

function SvgBars({
  items,
  height = 100,
  color = "var(--orange-500, #f97316)",
  className = "",
}: {
  items: BarItem[]
  height?: number
  color?: string
  className?: string
}) {
  if (!items.length) {
    return (
      <p className="text-xs text-slate-600 text-center py-4">Chưa có dữ liệu</p>
    )
  }
  const w = 300
  const pad = 8
  const gap = items.length > 20 ? 1 : 2
  const max = Math.max(1, ...items.map((i) => i.value))
  const bw = Math.max(2, (w - 2 * pad) / items.length - gap)

  return (
    <svg
      viewBox={`0 0 ${w} ${height}`}
      preserveAspectRatio="none"
      className={`w-full ${className}`}
      style={{ height }}
    >
      {items.map((item, i) => {
        const bh = ((item.value / max) * (height - 2 * pad))
        const x = pad + i * ((w - 2 * pad) / items.length)
        const y = height - pad - bh
        return bh <= 0 ? null : (
          <rect
            key={i}
            x={x.toFixed(1)}
            y={y.toFixed(1)}
            width={bw.toFixed(1)}
            height={bh.toFixed(1)}
            fill={color}
            rx="1"
            opacity="0.85"
          >
            <title>{item.label}: {item.value}</title>
          </rect>
        )
      })}
    </svg>
  )
}

// ── Horizontal bar row ─────────────────────────────────────────────────

function HBar({
  label,
  value,
  max,
  color = "bg-orange-500",
  sub,
}: {
  label: string
  value: number
  max: number
  color?: string
  sub?: string
}) {
  const pct = max > 0 ? (value / max) * 100 : 0
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-300 font-mono truncate max-w-[200px]" title={label}>
          {label}
        </span>
        <span className="text-slate-400 tabular-nums ml-4 flex-shrink-0">
          {fmtNum(value)}{sub ? ` ${sub}` : ""}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

// ── Usage Page ─────────────────────────────────────────────────────────

export function Usage() {
  const [range, setRange] = useState<"7d" | "30d">("7d")
  const [data, setData] = useState<UsageData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [metric, setMetric] = useState<"req" | "tok">("req")

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/gateway/usage?range=${range}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as UsageData
      setData(json)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch")
    } finally {
      setLoading(false)
    }
  }, [range])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ── Loading ────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="flex gap-2">
          <Skeleton className="h-8 w-16 bg-slate-800" />
          <Skeleton className="h-8 w-16 bg-slate-800" />
        </div>
        <Skeleton className="h-16 w-full bg-slate-800" />
        <Skeleton className="h-48 w-full bg-slate-800" />
        <Skeleton className="h-48 w-full bg-slate-800" />
      </div>
    )
  }

  // ── Error ──────────────────────────────────────────────────────────

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

  // ── Normalize data (handle both API shapes) ────────────────────────

  const series: SeriesPoint[] = data?.series ?? []
  const byModel: ModelUsage[] = data?.byModel ?? data?.models ?? []
  const byAccount: AccountUsage[] = data?.byAccount ?? data?.accounts ?? []
  const totals = data?.totals ?? {
    requests: data?.total,
    tokIn: undefined,
    tokOut: undefined,
    accounts: (data?.accounts ?? []).length,
  }

  const totalRequests = totals.requests ?? 0
  const totalTokIn = totals.tokIn ?? 0
  const totalTokOut = totals.tokOut ?? 0
  const activeAccounts = totals.accounts ?? byAccount.length

  const days = range === "7d" ? 7 : 30
  const avgPerDay = days > 0 && totalRequests > 0 ? Math.round(totalRequests / days) : 0

  // Series chart items
  const seriesItems: BarItem[] = series.map((s) => ({
    label: s.bucket,
    value: metric === "tok" ? ((s.tokIn ?? 0) + (s.tokOut ?? 0)) : (s.requests ?? 0),
  }))

  // Date range label
  const dateFrom = series[0]?.bucket
  const dateTo = series[series.length - 1]?.bucket

  const maxModelReq = Math.max(1, ...byModel.map(reqOf))
  const maxAccReq = Math.max(1, ...byAccount.map(reqOf))

  return (
    <div className="space-y-4">
      {/* Header + controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-slate-500" />
          <h2 className="text-sm font-medium text-slate-300">Báo cáo Usage</h2>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Range selector */}
          {(["7d", "30d"] as const).map((r) => (
            <Button
              key={r}
              variant={range === r ? "default" : "outline"}
              size="sm"
              onClick={() => setRange(r)}
              className={
                range === r
                  ? "bg-orange-500 hover:bg-orange-600 text-white h-8 text-xs"
                  : "border-slate-700 text-slate-400 hover:text-slate-200 hover:bg-slate-800 h-8 text-xs"
              }
            >
              {r}
            </Button>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={fetchData}
            className="border-slate-700 text-slate-400 hover:text-orange-400 h-8 text-xs gap-1"
          >
            <RefreshCw className="h-3 w-3" /> Refresh
          </Button>
          {/* Export CSV */}
          <a
            href={`/api/gateway/usage/export.csv?range=${range}`}
            download
            className="inline-flex items-center gap-1 px-3 h-8 rounded-md border border-slate-700 text-slate-400 hover:text-emerald-400 hover:border-emerald-700 text-xs transition-colors"
          >
            <Download className="h-3 w-3" /> Export CSV
          </a>
        </div>
      </div>

      {/* KPI */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card className="bg-slate-900 border-slate-800">
          <CardContent className="pt-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-slate-500 mb-1">Requests</p>
                <p className="text-2xl font-bold text-slate-100 tabular-nums">
                  {fmtNum(totalRequests)}
                </p>
                <p className="text-xs text-slate-500 mt-0.5">{range}</p>
              </div>
              <div className="p-2 rounded-lg bg-orange-500/10 text-orange-500">
                <Activity className="h-4 w-4" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-slate-900 border-slate-800">
          <CardContent className="pt-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-slate-500 mb-1">Avg / ngày</p>
                <p className="text-2xl font-bold text-slate-100 tabular-nums">
                  {fmtNum(avgPerDay)}
                </p>
                <p className="text-xs text-slate-500 mt-0.5">req / day</p>
              </div>
              <div className="p-2 rounded-lg bg-blue-500/10 text-blue-500">
                <TrendingUp className="h-4 w-4" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-slate-900 border-slate-800">
          <CardContent className="pt-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-slate-500 mb-1">Tokens</p>
                <p className="text-2xl font-bold text-slate-100 tabular-nums">
                  {fmtNum(totalTokIn + totalTokOut)}
                </p>
                <p className="text-xs text-slate-500 mt-0.5">in + out</p>
              </div>
              <div className="p-2 rounded-lg bg-purple-500/10 text-purple-500">
                <Cpu className="h-4 w-4" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-slate-900 border-slate-800">
          <CardContent className="pt-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-slate-500 mb-1">Accounts</p>
                <p className="text-2xl font-bold text-slate-100 tabular-nums">
                  {activeAccounts}
                </p>
                <p className="text-xs text-slate-500 mt-0.5">active</p>
              </div>
              <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-500">
                <Users className="h-4 w-4" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Series chart */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-slate-500" />
              Lưu lượng theo ngày
            </CardTitle>
            {/* Metric toggle */}
            <div className="flex items-center gap-1 bg-slate-800 rounded-md p-0.5">
              {([
                { key: "req", label: "Requests" },
                { key: "tok", label: "Tokens" },
              ] as const).map((m) => (
                <button
                  key={m.key}
                  onClick={() => setMetric(m.key)}
                  className={`px-2.5 py-1 rounded text-[10px] font-medium transition-colors ${
                    metric === m.key
                      ? "bg-slate-700 text-slate-100"
                      : "text-slate-500 hover:text-slate-300"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {series.length === 0 ? (
            <p className="text-xs text-slate-600 text-center py-8">Chưa có dữ liệu sử dụng</p>
          ) : (
            <>
              <SvgBars
                items={seriesItems}
                height={110}
                color={metric === "tok" ? "#a855f7" : "#f97316"}
              />
              {(dateFrom || dateTo) && (
                <div className="flex items-center justify-between mt-2 text-[10px] text-slate-600">
                  <span>{dateFrom}</span>
                  {dateTo && dateTo !== dateFrom && <span>{dateTo}</span>}
                </div>
              )}
              {/* Axis labels — every N-th bucket */}
              {series.length > 0 && (
                <div className="flex justify-between mt-0.5 px-0">
                  {series.filter((_, i) => i === 0 || i === series.length - 1 || i === Math.floor(series.length / 2)).map((s, i) => (
                    <span key={i} className="text-[9px] text-slate-700">{s.bucket.slice(5)}</span>
                  ))}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Top Models + Top Accounts side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Top Models */}
        <Card className="bg-slate-900 border-slate-800">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
              <Cpu className="h-4 w-4 text-slate-500" />
              Top Models
            </CardTitle>
          </CardHeader>
          <CardContent>
            {byModel.length === 0 ? (
              <p className="text-xs text-slate-600 text-center py-6">Không có dữ liệu</p>
            ) : (
              <div className="space-y-3">
                {byModel.slice(0, 8).map((m) => (
                  <HBar
                    key={m.model}
                    label={m.model}
                    value={reqOf(m)}
                    max={maxModelReq}
                    color="bg-orange-500"
                    sub="req"
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Top Accounts */}
        <Card className="bg-slate-900 border-slate-800">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
              <Users className="h-4 w-4 text-slate-500" />
              Top Accounts
            </CardTitle>
          </CardHeader>
          <CardContent>
            {byAccount.length === 0 ? (
              <p className="text-xs text-slate-600 text-center py-6">Không có dữ liệu</p>
            ) : (
              <div className="space-y-3">
                {byAccount.slice(0, 8).map((a) => (
                  <HBar
                    key={a.email}
                    label={a.email}
                    value={reqOf(a)}
                    max={maxAccReq}
                    color="bg-blue-500"
                    sub="req"
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Full model table */}
      {byModel.length > 0 && (
        <Card className="bg-slate-900 border-slate-800">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
              <Cpu className="h-4 w-4 text-slate-500" />
              Tất cả models ({byModel.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-800">
                    <th className="text-left text-slate-500 pb-2 font-normal">Model</th>
                    <th className="text-right text-slate-500 pb-2 font-normal">Requests</th>
                    <th className="text-right text-slate-500 pb-2 font-normal">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {byModel.map((m) => (
                    <tr key={m.model} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                      <td className="py-1.5 text-slate-300 font-mono truncate max-w-[200px]">
                        {m.model}
                      </td>
                      <td className="py-1.5 text-slate-400 text-right tabular-nums">
                        {reqOf(m).toLocaleString()}
                      </td>
                      <td className="py-1.5 text-slate-500 text-right tabular-nums">
                        {(m.tokIn != null || m.tokOut != null)
                          ? fmtNum((m.tokIn ?? 0) + (m.tokOut ?? 0))
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
