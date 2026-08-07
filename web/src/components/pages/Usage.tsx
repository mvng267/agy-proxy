import { useEffect, useState, useCallback } from "react"
import {
  BarChart3,
  RefreshCw,
  AlertTriangle,
  Download,
  Users,
  Cpu,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

// ── Types ──────────────────────────────────────────────────────────────

interface ModelUsage {
  model: string
  count: number
}

interface AccountUsage {
  email: string
  provider?: string
  count: number
}

interface UsageData {
  models: ModelUsage[]
  accounts: AccountUsage[]
  total: number
  days?: number
}

// ── Usage Page ─────────────────────────────────────────────────────────

export function Usage() {
  const [days, setDays] = useState<7 | 30>(7)
  const [data, setData] = useState<UsageData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/gateway/usage?days=${days}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as UsageData
      setData(json)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch")
    } finally {
      setLoading(false)
    }
  }, [days])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ── Loading ──────────────────────────────────────────────────────────

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

  // ── Error ────────────────────────────────────────────────────────────

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

  const models = data?.models ?? []
  const accounts = data?.accounts ?? []
  const total = data?.total ?? 0

  // Max for bar width calculation
  const maxModelCount = Math.max(...models.map((m) => m.count), 1)
  const maxAccountCount = Math.max(...accounts.map((a) => a.count), 1)

  return (
    <div className="space-y-6">
      {/* Header + controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-slate-500" />
          <h2 className="text-sm font-medium text-slate-300">Báo cáo Usage</h2>
        </div>
        <div className="flex items-center gap-2">
          {([7, 30] as const).map((d) => (
            <Button
              key={d}
              variant={days === d ? "default" : "outline"}
              size="sm"
              onClick={() => setDays(d)}
              className={
                days === d
                  ? "bg-orange-500 hover:bg-orange-600 text-white h-8 text-xs"
                  : "border-slate-700 text-slate-400 hover:text-slate-200 hover:bg-slate-800 h-8 text-xs"
              }
            >
              {d}d
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
          <a
            href="/api/gateway/usage/export.csv"
            download
            className="inline-flex items-center gap-1 px-3 h-8 rounded-md border border-slate-700 text-slate-400 hover:text-emerald-400 hover:border-emerald-700 text-xs transition-colors"
          >
            <Download className="h-3 w-3" /> Export CSV
          </a>
        </div>
      </div>

      {/* KPI */}
      <div className="grid grid-cols-3 gap-4">
        <Card className="bg-slate-900 border-slate-800">
          <CardContent className="pt-4">
            <p className="text-xs text-slate-500 mb-1">Total Requests</p>
            <p className="text-2xl font-bold text-slate-100 tabular-nums">
              {total.toLocaleString()}
            </p>
            <p className="text-xs text-slate-500 mt-0.5">{days} ngày qua</p>
          </CardContent>
        </Card>
        <Card className="bg-slate-900 border-slate-800">
          <CardContent className="pt-4">
            <p className="text-xs text-slate-500 mb-1">Models Used</p>
            <p className="text-2xl font-bold text-slate-100 tabular-nums">
              {models.length}
            </p>
            <p className="text-xs text-slate-500 mt-0.5">unique models</p>
          </CardContent>
        </Card>
        <Card className="bg-slate-900 border-slate-800">
          <CardContent className="pt-4">
            <p className="text-xs text-slate-500 mb-1">Accounts</p>
            <p className="text-2xl font-bold text-slate-100 tabular-nums">
              {accounts.length}
            </p>
            <p className="text-xs text-slate-500 mt-0.5">active accounts</p>
          </CardContent>
        </Card>
      </div>

      {/* Top Models bar chart */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
            <Cpu className="h-4 w-4 text-slate-500" />
            Top Models
          </CardTitle>
        </CardHeader>
        <CardContent>
          {models.length === 0 ? (
            <p className="text-xs text-slate-600 text-center py-6">
              Không có dữ liệu
            </p>
          ) : (
            <div className="space-y-3">
              {models.slice(0, 10).map((m) => (
                <div key={m.model} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span
                      className="text-slate-300 font-mono truncate max-w-[260px]"
                      title={m.model}
                    >
                      {m.model}
                    </span>
                    <span className="text-slate-400 tabular-nums ml-4">
                      {m.count.toLocaleString()}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-orange-500 transition-all duration-500"
                      style={{
                        width: `${(m.count / maxModelCount) * 100}%`,
                      }}
                    />
                  </div>
                </div>
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
          {accounts.length === 0 ? (
            <p className="text-xs text-slate-600 text-center py-6">
              Không có dữ liệu
            </p>
          ) : (
            <div className="space-y-2">
              {accounts.slice(0, 10).map((acc, i) => (
                <div
                  key={acc.email}
                  className="flex items-center gap-3 bg-slate-800/40 rounded-lg px-3 py-2"
                >
                  <span className="text-xs text-slate-600 w-5 text-right tabular-nums">
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-slate-200 font-mono truncate">
                      {acc.email}
                    </p>
                    {acc.provider && (
                      <Badge className="bg-slate-700 text-slate-400 border-none text-[9px] mt-0.5">
                        {acc.provider}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <div className="w-24 h-1.5 rounded-full bg-slate-700 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-blue-500 transition-all duration-500"
                        style={{
                          width: `${(acc.count / maxAccountCount) * 100}%`,
                        }}
                      />
                    </div>
                    <span className="text-xs text-slate-400 tabular-nums w-16 text-right">
                      {acc.count.toLocaleString()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
