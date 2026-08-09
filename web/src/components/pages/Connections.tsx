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
import { KpiCard } from "@/components/common"
import { SegmentBar } from "@/components/common/charts"
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
      <Badge className="bg-muted/60 text-muted-foreground font-normal">
        Disabled
      </Badge>
    )
  }
  const s = (status ?? "unknown").toLowerCase()
  if (s === "active" || s === "ok" || s === "online") {
    return (
      <Badge className="bg-success/15 text-success font-normal">
        <CheckCircle2 className="h-2.5 w-2.5 mr-1" />
        Online
      </Badge>
    )
  }
  if (s === "failed" || s === "offline" || s === "error") {
    return (
      <Badge className="bg-destructive/15 text-destructive font-normal">
        <XCircle className="h-2.5 w-2.5 mr-1" />
        Offline
      </Badge>
    )
  }
  return (
    <Badge className="bg-muted/60 text-muted-foreground font-normal">
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
        <Skeleton className="h-8 w-48 bg-muted" />
        {[...Array(3)].map((_, i) => (
          <Skeleton key={i} className="h-24 w-full bg-muted" />
        ))}
      </div>
    )
  }

  // ── Error ──────────────────────────────────────────────────────────

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <AlertTriangle className="h-8 w-8 text-destructive" />
        <p className="text-sm text-muted-foreground">Error: {error}</p>
        <button
          onClick={fetchData}
          className="text-xs text-primary hover:text-primary flex items-center gap-1.5"
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

  // Gom điều kiện phân loại về một chỗ — trước đây lặp inline trong 2 thẻ KPI.
  const statusOf = (c: Connection) => (c.status ?? c.testStatus ?? "").toLowerCase()
  const connActive = connections.filter((c) => ["active", "ok", "online"].includes(statusOf(c))).length
  const connFailed = connections.filter((c) => ["failed", "offline", "error"].includes(statusOf(c))).length
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Link className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium text-foreground">Connections OmniRoute</h2>
          {note && (
            <span className="text-xs text-muted-foreground">· {note}</span>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={fetchData}
          className="border-border text-muted-foreground hover:text-primary h-7 text-xs gap-1"
        >
          <RefreshCw className="h-3 w-3" /> Refresh
        </Button>
      </div>

      {/* Summary KPIs — KpiCard chung thay 3 Card tay. */}
      <div className="grid grid-cols-3 gap-3">
        <KpiCard label="Tổng connections" value={connections.length} icon={Wifi} loading={loading} />
        <KpiCard label="Active" value={connActive} tone="success" icon={Wifi} loading={loading} />
        <KpiCard label="Offline/Lỗi" value={connFailed} tone="danger" icon={Wifi} loading={loading} />
      </div>

      {/* Ba trạng thái cộng lại thành tổng → SegmentBar. */}
      {connections.length > 0 && (
        <SegmentBar
          segments={[
            { label: "Active", value: connActive, tone: "success" },
            { label: "Offline/Lỗi", value: connFailed, tone: "danger" },
            { label: "Khác", value: Math.max(0, connections.length - connActive - connFailed), tone: "muted" },
          ]}
        />
      )}

      {/* Connection List */}
      {sorted.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <Link className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Chưa có connection nào</p>
              <p className="text-xs text-muted-foreground">Thêm connection OmniRoute từ trang Settings</p>
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
                className={`bg-card border-border transition-opacity ${
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
                          <Wifi className="h-4 w-4 text-success" />
                        ) : (
                          <WifiOff className="h-4 w-4 text-muted-foreground" />
                        )}
                      </div>

                      <div className="min-w-0 flex-1">
                        {/* Name + badges */}
                        <div className="flex items-center flex-wrap gap-2 mb-1">
                          <span className="text-sm font-medium text-foreground">
                            {conn.name}
                          </span>
                          {conn.provider && (
                            <Badge className="bg-muted/60 text-foreground font-normal">
                              {conn.provider}
                            </Badge>
                          )}
                          {conn.authType && (
                            <Badge className="bg-muted/40 text-muted-foreground font-normal">
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
                          <p className="text-xs text-muted-foreground font-mono truncate mb-1">
                            {conn.url}
                          </p>
                        )}

                        {/* Model badge */}
                        {conn.model && (
                          <p className="text-xs text-muted-foreground mb-1">
                            <span className="text-muted-foreground">model: </span>
                            <span className="font-mono">{conn.model}</span>
                          </p>
                        )}

                        {/* Stats row */}
                        <div className="flex items-center gap-4 text-xs text-muted-foreground mt-1.5">
                          {conn.latency != null && (
                            <span>
                              <span className="text-muted-foreground">latency: </span>
                              <span className="text-foreground tabular-nums">{fmtMs(conn.latency)}</span>
                            </span>
                          )}
                          {conn.requests != null && (
                            <span>
                              <span className="text-muted-foreground">requests: </span>
                              <span className="text-foreground tabular-nums">{fmtNum(conn.requests)}</span>
                            </span>
                          )}
                          {conn.proxyEnabled && (
                            <span className="text-info">proxy ✓</span>
                          )}
                          {conn.createdAt && (
                            <span>
                              {new Date(conn.createdAt).toLocaleDateString()}
                            </span>
                          )}
                        </div>

                        {/* Ping result */}
                        {ping.status === "ok" && (
                          <p className="text-xs text-success mt-1.5 flex items-center gap-1">
                            <CheckCircle2 className="h-3 w-3" />
                            Ping OK · {fmtMs(ping.ms)}
                          </p>
                        )}
                        {ping.status === "fail" && (
                          <p className="text-xs text-destructive mt-1.5 flex items-center gap-1">
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
                        className="border-border text-muted-foreground hover:text-info h-7 text-xs gap-1"
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
                        className={`border-border h-7 text-xs gap-1 ${
                          enabled
                            ? "text-primary hover:text-primary"
                            : "text-muted-foreground hover:text-success"
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
                        className="border-border text-muted-foreground hover:text-destructive hover:border-destructive h-7 w-7 p-0"
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
