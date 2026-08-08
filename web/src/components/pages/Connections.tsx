import { useEffect, useState, useCallback } from "react"
import {
  Link,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Trash2,
  ToggleLeft,
  ToggleRight,
  Wifi,
  WifiOff,
  Zap,
} from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

// ── Types ──────────────────────────────────────────────────────────────

interface Connection {
  id: string
  name: string
  url?: string
  model?: string
  status?: string       // "active" | "offline" | "unknown"
  testStatus?: string   // "active" | "failed" | "unknown"
  provider?: string
  authType?: string
  proxyEnabled?: boolean
  latency?: number      // ms
  requests?: number
  enabled?: boolean
  createdAt?: string | number
}

interface ConnectionsResponse {
  ok: boolean
  connections?: Connection[]
  error?: string
}

type PingState = { status: "idle" | "pinging" | "ok" | "fail"; ms?: number; error?: string }

// ── Helpers ────────────────────────────────────────────────────────────

function fmtMs(ms: number | undefined) {
  if (ms == null) return "—"
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function fmtNum(n: number | undefined) {
  if (n == null) return "—"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function StatusBadge({ status, enabled }: { status?: string; enabled?: boolean }) {
  if (enabled === false) {
    return (
      <Badge className="bg-slate-700/60 text-slate-400 border-none text-[10px] font-normal">
        Disabled
      </Badge>
    )
  }
  const s = (status ?? "unknown").toLowerCase()
  if (s === "active" || s === "ok" || s === "online") {
    return (
      <Badge className="bg-emerald-500/15 text-emerald-400 border-none text-[10px] font-normal">
        <CheckCircle2 className="h-2.5 w-2.5 mr-1" />
        Online
      </Badge>
    )
  }
  if (s === "failed" || s === "offline" || s === "error") {
    return (
      <Badge className="bg-red-500/15 text-red-400 border-none text-[10px] font-normal">
        <XCircle className="h-2.5 w-2.5 mr-1" />
        Offline
      </Badge>
    )
  }
  return (
    <Badge className="bg-slate-700/60 text-slate-400 border-none text-[10px] font-normal">
      <HelpCircle className="h-2.5 w-2.5 mr-1" />
      {status ?? "Unknown"}
    </Badge>
  )
}

// ── Connections Page ────────────────────────────────────────────────────

export function Connections() {
  const [connections, setConnections] = useState<Connection[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState("")

  // Per-connection ping state
  const [pingState, setPingState] = useState<Record<string, PingState>>({})
  // Per-connection toggling
  const [toggling, setToggling] = useState<Set<string>>(new Set())
  // Deleting
  const [deleting, setDeleting] = useState<Set<string>>(new Set())

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/omniroute/connections")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as ConnectionsResponse
      if (!json.ok) throw new Error(json.error ?? "Unknown error")
      setConnections(json.connections ?? [])
      setNote(`${(json.connections ?? []).length} connection${(json.connections ?? []).length !== 1 ? "s" : ""}`)
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

  const pingConnection = async (id: string) => {
    setPingState((prev) => ({ ...prev, [id]: { status: "pinging" } }))
    try {
      const res = await fetch(`/api/omniroute/connections/${encodeURIComponent(id)}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      const json = await res.json() as { ok?: boolean; ms?: number; error?: string; latency?: number }
      if (json.ok) {
        setPingState((prev) => ({
          ...prev,
          [id]: { status: "ok", ms: json.ms ?? json.latency },
        }))
      } else {
        setPingState((prev) => ({
          ...prev,
          [id]: { status: "fail", error: json.error ?? "Ping failed" },
        }))
      }
    } catch (err) {
      setPingState((prev) => ({
        ...prev,
        [id]: { status: "fail", error: err instanceof Error ? err.message : "Error" },
      }))
    }
  }

  const toggleConnection = async (conn: Connection) => {
    setToggling((prev) => new Set(prev).add(conn.id))
    try {
      const newEnabled = conn.enabled === false ? true : false
      await fetch(`/api/omniroute/connections/${encodeURIComponent(conn.id)}/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: newEnabled }),
      })
      // Optimistic update
      setConnections((prev) =>
        prev.map((c) => (c.id === conn.id ? { ...c, enabled: newEnabled } : c))
      )
    } catch {
      // ignore
    } finally {
      setToggling((prev) => {
        const s = new Set(prev)
        s.delete(conn.id)
        return s
      })
    }
  }

  const deleteConnection = async (id: string) => {
    if (!confirm(`Xóa connection "${id}"?`)) return
    setDeleting((prev) => new Set(prev).add(id))
    try {
      await fetch(`/api/omniroute/connections/${encodeURIComponent(id)}`, {
        method: "DELETE",
      })
      setConnections((prev) => prev.filter((c) => c.id !== id))
      setNote((prev) => prev.replace(/^\d+/, String(connections.length - 1)))
    } catch {
      // ignore
    } finally {
      setDeleting((prev) => {
        const s = new Set(prev)
        s.delete(id)
        return s
      })
    }
  }

  // ── Loading ────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48 bg-slate-800" />
        {[...Array(3)].map((_, i) => (
          <Skeleton key={i} className="h-24 w-full bg-slate-800" />
        ))}
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

  // ── Sort by provider ───────────────────────────────────────────────

  const sorted = [...connections].sort((a, b) =>
    (a.provider ?? "").localeCompare(b.provider ?? "")
  )

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Link className="h-4 w-4 text-slate-500" />
          <h2 className="text-sm font-medium text-slate-300">Connections OmniRoute</h2>
          {note && (
            <span className="text-xs text-slate-500">· {note}</span>
          )}
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

      {/* Summary KPIs */}
      <div className="grid grid-cols-3 gap-3">
        <Card className="bg-slate-900 border-slate-800">
          <CardContent className="pt-4">
            <p className="text-xs text-slate-500 mb-1">Tổng connections</p>
            <p className="text-2xl font-bold text-slate-100 tabular-nums">{connections.length}</p>
          </CardContent>
        </Card>
        <Card className="bg-slate-900 border-slate-800">
          <CardContent className="pt-4">
            <p className="text-xs text-slate-500 mb-1">Active</p>
            <p className="text-2xl font-bold text-emerald-400 tabular-nums">
              {connections.filter((c) => {
                const s = (c.status ?? c.testStatus ?? "").toLowerCase()
                return s === "active" || s === "ok" || s === "online"
              }).length}
            </p>
          </CardContent>
        </Card>
        <Card className="bg-slate-900 border-slate-800">
          <CardContent className="pt-4">
            <p className="text-xs text-slate-500 mb-1">Offline/Lỗi</p>
            <p className="text-2xl font-bold text-red-400 tabular-nums">
              {connections.filter((c) => {
                const s = (c.status ?? c.testStatus ?? "").toLowerCase()
                return s === "failed" || s === "offline" || s === "error"
              }).length}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Connection List */}
      {sorted.length === 0 ? (
        <Card className="bg-slate-900 border-slate-800">
          <CardContent className="pt-6">
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <Link className="h-8 w-8 text-slate-600" />
              <p className="text-sm text-slate-500">Chưa có connection nào</p>
              <p className="text-xs text-slate-600">Thêm connection OmniRoute từ trang Settings</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {sorted.map((conn) => {
            const ping = pingState[conn.id] ?? { status: "idle" }
            const isPinging = ping.status === "pinging"
            const isToggling = toggling.has(conn.id)
            const isDeleting = deleting.has(conn.id)
            const effectiveStatus = conn.testStatus ?? conn.status
            const enabled = conn.enabled !== false

            return (
              <Card
                key={conn.id}
                className={`bg-slate-900 border-slate-800 transition-opacity ${
                  isDeleting ? "opacity-40" : ""
                }`}
              >
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-start justify-between gap-4">
                    {/* Left: info */}
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                      {/* Status dot */}
                      <div className="mt-1 flex-shrink-0">
                        {enabled ? (
                          <Wifi className="h-4 w-4 text-emerald-400" />
                        ) : (
                          <WifiOff className="h-4 w-4 text-slate-600" />
                        )}
                      </div>

                      <div className="min-w-0 flex-1">
                        {/* Name + badges */}
                        <div className="flex items-center flex-wrap gap-2 mb-1">
                          <span className="text-sm font-medium text-slate-200">
                            {conn.name}
                          </span>
                          {conn.provider && (
                            <Badge className="bg-slate-700/60 text-slate-300 border-none text-[10px] font-normal">
                              {conn.provider}
                            </Badge>
                          )}
                          {conn.authType && (
                            <Badge className="bg-slate-700/40 text-slate-400 border-none text-[10px] font-normal">
                              {conn.authType}
                            </Badge>
                          )}
                          <StatusBadge
                            status={effectiveStatus}
                            enabled={enabled}
                          />
                        </div>

                        {/* URL */}
                        {conn.url && (
                          <p className="text-xs text-slate-500 font-mono truncate mb-1">
                            {conn.url}
                          </p>
                        )}

                        {/* Model badge */}
                        {conn.model && (
                          <p className="text-xs text-slate-400 mb-1">
                            <span className="text-slate-600">model: </span>
                            <span className="font-mono">{conn.model}</span>
                          </p>
                        )}

                        {/* Stats row */}
                        <div className="flex items-center gap-4 text-xs text-slate-500 mt-1.5">
                          {conn.latency != null && (
                            <span>
                              <span className="text-slate-600">latency: </span>
                              <span className="text-slate-300 tabular-nums">{fmtMs(conn.latency)}</span>
                            </span>
                          )}
                          {conn.requests != null && (
                            <span>
                              <span className="text-slate-600">requests: </span>
                              <span className="text-slate-300 tabular-nums">{fmtNum(conn.requests)}</span>
                            </span>
                          )}
                          {conn.proxyEnabled && (
                            <span className="text-blue-400">proxy ✓</span>
                          )}
                          {conn.createdAt && (
                            <span>
                              {new Date(conn.createdAt).toLocaleDateString()}
                            </span>
                          )}
                        </div>

                        {/* Ping result */}
                        {ping.status === "ok" && (
                          <p className="text-xs text-emerald-400 mt-1.5 flex items-center gap-1">
                            <CheckCircle2 className="h-3 w-3" />
                            Ping OK · {fmtMs(ping.ms)}
                          </p>
                        )}
                        {ping.status === "fail" && (
                          <p className="text-xs text-red-400 mt-1.5 flex items-center gap-1">
                            <XCircle className="h-3 w-3" />
                            {ping.error ?? "Ping failed"}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Right: actions */}
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {/* Ping button */}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={isPinging}
                        onClick={() => pingConnection(conn.id)}
                        className="border-slate-700 text-slate-400 hover:text-blue-400 h-7 text-xs gap-1"
                        title="Test connection"
                      >
                        {isPinging ? (
                          <RefreshCw className="h-3 w-3 animate-spin" />
                        ) : (
                          <Zap className="h-3 w-3" />
                        )}
                        Ping
                      </Button>

                      {/* Toggle enable/disable */}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={isToggling}
                        onClick={() => toggleConnection(conn)}
                        className={`border-slate-700 h-7 text-xs gap-1 ${
                          enabled
                            ? "text-orange-400 hover:text-orange-300"
                            : "text-slate-400 hover:text-emerald-400"
                        }`}
                        title={enabled ? "Tắt connection" : "Bật connection"}
                      >
                        {isToggling ? (
                          <RefreshCw className="h-3 w-3 animate-spin" />
                        ) : enabled ? (
                          <ToggleRight className="h-3 w-3" />
                        ) : (
                          <ToggleLeft className="h-3 w-3" />
                        )}
                        {enabled ? "Tắt" : "Bật"}
                      </Button>

                      {/* Delete */}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={isDeleting}
                        onClick={() => deleteConnection(conn.id)}
                        className="border-slate-700 text-slate-500 hover:text-red-400 hover:border-red-800 h-7 w-7 p-0"
                        title="Xóa connection"
                      >
                        {isDeleting ? (
                          <RefreshCw className="h-3 w-3 animate-spin" />
                        ) : (
                          <Trash2 className="h-3 w-3" />
                        )}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
