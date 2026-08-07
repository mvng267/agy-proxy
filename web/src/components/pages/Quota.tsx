import { useEffect, useState, useCallback } from "react"
import {
  Gauge,
  RefreshCw,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

// ── Types ──────────────────────────────────────────────────────────────

interface ProviderQuota {
  name: string
  quotaPct?: number
  used?: number
  limit?: number
  remaining?: number
  resetsAt?: string
  status?: string
}

interface QuotaSummary {
  providers: ProviderQuota[]
}

interface QuotaHistoryEntry {
  timestamp: string
  provider: string
  quotaPct: number
}

interface QuotaHistory {
  history: QuotaHistoryEntry[]
}

// ── Donut Chart ────────────────────────────────────────────────────────

function QuotaDonut({
  label,
  pct,
  color,
  size = 100,
  strokeWidth = 10,
}: {
  label: string
  pct: number
  color: string
  size?: number
  strokeWidth?: number
}) {
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const center = size / 2
  const filled = circumference * (pct / 100)

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="transform -rotate-90">
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke="#334155"
            strokeWidth={strokeWidth}
          />
          {pct > 0 && (
            <circle
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke={color}
              strokeWidth={strokeWidth}
              strokeDasharray={`${filled} ${circumference - filled}`}
              strokeDashoffset={0}
              strokeLinecap="round"
              className="transition-all duration-700"
            />
          )}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-bold text-slate-100 tabular-nums">
            {Math.round(pct)}%
          </span>
        </div>
      </div>
      <span className="text-xs text-slate-400 font-medium">{label}</span>
    </div>
  )
}

// ── Sparkline ──────────────────────────────────────────────────────────

function Sparkline({
  data,
  color,
  width = 200,
  height = 40,
}: {
  data: number[]
  color: string
  width?: number
  height?: number
}) {
  if (data.length < 2) return null

  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const padding = 2

  const points = data.map((val, i) => {
    const x = padding + (i / (data.length - 1)) * (width - padding * 2)
    const y = height - padding - ((val - min) / range) * (height - padding * 2)
    return `${x},${y}`
  })

  const pathD = points.map((p, i) => (i === 0 ? `M${p}` : `L${p}`)).join(" ")

  return (
    <svg width={width} height={height} className="overflow-visible">
      <path
        d={pathD}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        className="transition-all duration-500"
      />
    </svg>
  )
}

// ── Quota Page ─────────────────────────────────────────────────────────

export function Quota() {
  const [summary, setSummary] = useState<QuotaSummary | null>(null)
  const [history, setHistory] = useState<QuotaHistory | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const [summaryRes, historyRes] = await Promise.all([
        fetch("/api/gateway/quota-summary"),
        fetch("/api/gateway/quota/history"),
      ])

      if (!summaryRes.ok) throw new Error(`Summary: HTTP ${summaryRes.status}`)

      const summaryJson = (await summaryRes.json()) as QuotaSummary
      setSummary(summaryJson)

      // History may 404 — that's ok
      if (historyRes.ok) {
        const historyJson = (await historyRes.json()) as QuotaHistory
        setHistory(historyJson)
      }

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

  // ── Loading ────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-48 w-full bg-slate-800" />
          ))}
        </div>
        <Skeleton className="h-64 w-full bg-slate-800" />
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

  const providers = summary?.providers ?? []
  const historyEntries = history?.history ?? []

  // Colors per provider
  const COLORS: Record<string, string> = {
    agy: "#f97316",
    kiro: "#3b82f6",
    anthropic: "#8b5cf6",
    openai: "#22c55e",
  }

  const getColor = (name: string) =>
    COLORS[name.toLowerCase()] ?? "#64748b"

  // Build sparkline data per provider from history
  const sparklineByProvider: Record<string, number[]> = {}
  for (const entry of historyEntries) {
    const key = entry.provider.toLowerCase()
    if (!sparklineByProvider[key]) sparklineByProvider[key] = []
    sparklineByProvider[key].push(entry.quotaPct)
  }

  const quotaStatusBadge = (pct: number) => {
    if (pct >= 90) {
      return (
        <Badge className="bg-red-500/15 text-red-400 border-none text-[10px]">
          Critical
        </Badge>
      )
    }
    if (pct >= 70) {
      return (
        <Badge className="bg-amber-500/15 text-amber-400 border-none text-[10px]">
          Warning
        </Badge>
      )
    }
    return (
      <Badge className="bg-emerald-500/15 text-emerald-400 border-none text-[10px]">
        OK
      </Badge>
    )
  }

  const trendIcon = (name: string) => {
    const data = sparklineByProvider[name.toLowerCase()]
    if (!data || data.length < 2) return null
    const last = data[data.length - 1]
    const prev = data[data.length - 2]
    if (last > prev) {
      return <TrendingUp className="h-3 w-3 text-red-400" />
    }
    if (last < prev) {
      return <TrendingDown className="h-3 w-3 text-emerald-400" />
    }
    return null
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Gauge className="h-4 w-4 text-slate-500" />
          <h2 className="text-sm font-medium text-slate-300">
            Quota ({providers.length} providers)
          </h2>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={fetchData}
          className="border-slate-700 text-slate-400 hover:text-orange-400 h-7 text-xs gap-1"
        >
          <RefreshCw className="h-3 w-3" /> Refresh
        </Button>
      </div>

      {/* Provider donuts */}
      {providers.length === 0 ? (
        <Card className="bg-slate-900 border-slate-800">
          <CardContent className="pt-6">
            <div className="flex flex-col items-center justify-center py-8 gap-3">
              <Gauge className="h-8 w-8 text-slate-600" />
              <p className="text-sm text-slate-500">
                Chưa có dữ liệu hạn mức
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {providers.map((prov) => {
            const pct = prov.quotaPct ?? 0
            const color = getColor(prov.name)

            return (
              <Card
                key={prov.name}
                className="bg-slate-900 border-slate-800"
              >
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
                      {prov.name.toUpperCase()}
                      {trendIcon(prov.name)}
                    </CardTitle>
                    {quotaStatusBadge(pct)}
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-4">
                    <QuotaDonut
                      label="Used"
                      pct={pct}
                      color={color}
                      size={90}
                      strokeWidth={8}
                    />
                    <div className="flex-1 space-y-2">
                      {prov.used != null && prov.limit != null && (
                        <div className="space-y-1">
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-slate-500">Used</span>
                            <span className="text-slate-300 tabular-nums">
                              {prov.used.toLocaleString()} / {prov.limit.toLocaleString()}
                            </span>
                          </div>
                          <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all duration-500"
                              style={{
                                width: `${Math.min(pct, 100)}%`,
                                backgroundColor: color,
                              }}
                            />
                          </div>
                        </div>
                      )}
                      {prov.remaining != null && (
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-slate-500">Remaining</span>
                          <span className="text-slate-300 tabular-nums">
                            {prov.remaining.toLocaleString()}
                          </span>
                        </div>
                      )}
                      {prov.resetsAt && (
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-slate-500">Resets</span>
                          <span className="text-slate-400">
                            {new Date(prov.resetsAt).toLocaleDateString()}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* History sparklines */}
      {Object.keys(sparklineByProvider).length > 0 && (
        <Card className="bg-slate-900 border-slate-800">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-slate-500" />
              Quota History
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {Object.entries(sparklineByProvider).map(
                ([provName, data]) => (
                  <div key={provName} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-slate-400">
                        {provName.toUpperCase()}
                      </span>
                      <span className="text-xs text-slate-500 tabular-nums">
                        {data.length > 0
                          ? `${Math.round(data[data.length - 1])}%`
                          : "—"}
                      </span>
                    </div>
                    <div className="bg-slate-800/50 rounded-lg p-3">
                      <Sparkline
                        data={data}
                        color={getColor(provName)}
                        width={280}
                        height={50}
                      />
                    </div>
                  </div>
                )
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
