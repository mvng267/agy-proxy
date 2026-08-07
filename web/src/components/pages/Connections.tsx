import { useEffect, useState, useCallback } from "react"
import {
  Link,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Globe,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Skeleton } from "@/components/ui/skeleton"

// ── Types ──────────────────────────────────────────────────────────────

interface GatewayConfig {
  enabled?: boolean
  rotation?: string
  cooldownSec?: number
  omniroute?: {
    enabled?: boolean
    url?: string
    key?: string
  }
  connections?: Connection[]
  providers?: ProviderConn[]
}

interface Connection {
  id: string
  name: string
  url?: string
  enabled?: boolean
  status?: string
  type?: string
}

interface ProviderConn {
  name: string
  enabled?: boolean
  status?: string
  accountCount?: number
  activeCount?: number
}

// ── Connections Page ────────────────────────────────────────────────────

export function Connections() {
  const [config, setConfig] = useState<GatewayConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/gateway/config")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as GatewayConfig
      setConfig(json)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchConfig()
    const interval = setInterval(fetchConfig, 30_000)
    return () => clearInterval(interval)
  }, [fetchConfig])

  const toggleProvider = async (name: string, enabled: boolean) => {
    setSaving(name)
    try {
      await fetch("/api/gateway/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [`provider.${name}.enabled`]: enabled }),
      })
      await fetchConfig()
    } catch {
      // ignore
    } finally {
      setSaving(null)
    }
  }

  // ── Loading ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full bg-slate-800" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Skeleton className="h-48 w-full bg-slate-800" />
          <Skeleton className="h-48 w-full bg-slate-800" />
        </div>
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
          onClick={fetchConfig}
          className="text-xs text-orange-400 hover:text-orange-300 flex items-center gap-1.5"
        >
          <RefreshCw className="h-3 w-3" /> Retry
        </button>
      </div>
    )
  }

  // ── Derive connections from config ───────────────────────────────────

  // Build provider list from config shape
  const providers: ProviderConn[] = config?.providers ?? []

  // If no explicit providers field, derive from known fields
  const derivedProviders: ProviderConn[] =
    providers.length > 0
      ? providers
      : [
          {
            name: "agy",
            enabled: config?.enabled ?? true,
            status: config?.enabled ? "active" : "disabled",
          },
          {
            name: "kiro",
            enabled: config?.enabled ?? true,
            status: config?.enabled ? "active" : "disabled",
          },
        ]

  const connections: Connection[] = config?.connections ?? []

  // OmniRoute connection from config
  const omniRoute = config?.omniroute

  const statusBadge = (status?: string, enabled?: boolean) => {
    if (enabled === false) {
      return (
        <Badge className="bg-slate-700 text-slate-400 border-none text-[10px]">
          Disabled
        </Badge>
      )
    }
    switch (status) {
      case "active":
      case "ok":
        return (
          <Badge className="bg-emerald-500/15 text-emerald-400 border-none text-[10px]">
            Active
          </Badge>
        )
      case "error":
      case "offline":
        return (
          <Badge className="bg-red-500/15 text-red-400 border-none text-[10px]">
            Offline
          </Badge>
        )
      default:
        return (
          <Badge className="bg-blue-500/15 text-blue-400 border-none text-[10px]">
            {status ?? "Unknown"}
          </Badge>
        )
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Link className="h-4 w-4 text-slate-500" />
          <h2 className="text-sm font-medium text-slate-300">
            Connections
          </h2>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={fetchConfig}
          className="border-slate-700 text-slate-400 hover:text-orange-400 h-7 text-xs gap-1"
        >
          <RefreshCw className="h-3 w-3" /> Refresh
        </Button>
      </div>

      {/* Gateway status card */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
              <Globe className="h-4 w-4 text-slate-500" />
              Gateway
            </CardTitle>
            {config?.enabled ? (
              <div className="flex items-center gap-1.5 text-emerald-400 text-xs">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Online
              </div>
            ) : (
              <div className="flex items-center gap-1.5 text-red-400 text-xs">
                <XCircle className="h-3.5 w-3.5" />
                Offline
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-xs">
            <div>
              <p className="text-slate-500 mb-0.5">Rotation</p>
              <p className="text-slate-200 font-medium capitalize">
                {config?.rotation ?? "—"}
              </p>
            </div>
            <div>
              <p className="text-slate-500 mb-0.5">Cooldown</p>
              <p className="text-slate-200 font-medium">
                {config?.cooldownSec != null ? `${config.cooldownSec}s` : "—"}
              </p>
            </div>
            <div>
              <p className="text-slate-500 mb-0.5">Status</p>
              <p
                className={`font-medium ${config?.enabled ? "text-emerald-400" : "text-red-400"}`}
              >
                {config?.enabled ? "Enabled" : "Disabled"}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* OmniRoute */}
      {omniRoute && (
        <Card className="bg-slate-900 border-slate-800">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
                <Link className="h-4 w-4 text-slate-500" />
                OmniRoute
              </CardTitle>
              {statusBadge(omniRoute.enabled ? "active" : "disabled", omniRoute.enabled)}
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-xs">
              {omniRoute.url && (
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">URL</span>
                  <span className="text-slate-300 font-mono truncate max-w-[260px]">
                    {omniRoute.url}
                  </span>
                </div>
              )}
              {omniRoute.key && (
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">Key</span>
                  <span className="text-slate-400 font-mono">
                    {omniRoute.key.slice(0, 8)}••••
                  </span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Providers */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
            <Link className="h-4 w-4 text-slate-500" />
            Providers ({derivedProviders.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {derivedProviders.map((prov) => (
              <div
                key={prov.name}
                className="flex items-center justify-between bg-slate-800/50 rounded-lg px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`h-2 w-2 rounded-full ${
                      prov.enabled !== false
                        ? "bg-emerald-400"
                        : "bg-slate-600"
                    }`}
                  />
                  <div>
                    <p className="text-sm font-medium text-slate-200 uppercase">
                      {prov.name}
                    </p>
                    {prov.accountCount != null && (
                      <p className="text-xs text-slate-500">
                        {prov.activeCount ?? 0}/{prov.accountCount} accounts active
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {statusBadge(prov.status, prov.enabled)}
                  <Switch
                    checked={prov.enabled !== false}
                    disabled={saving === prov.name}
                    onCheckedChange={(v) => toggleProvider(prov.name, v)}
                    className="data-[state=checked]:bg-orange-500"
                  />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Custom connections */}
      {connections.length > 0 && (
        <Card className="bg-slate-900 border-slate-800">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
              <Link className="h-4 w-4 text-slate-500" />
              Custom Connections ({connections.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {connections.map((conn) => (
                <div
                  key={conn.id}
                  className="flex items-center justify-between bg-slate-800/50 rounded-lg px-4 py-3"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`h-2 w-2 rounded-full ${
                        conn.enabled !== false ? "bg-emerald-400" : "bg-slate-600"
                      }`}
                    />
                    <div>
                      <p className="text-sm font-medium text-slate-200">
                        {conn.name}
                      </p>
                      {conn.url && (
                        <p className="text-xs text-slate-500 font-mono truncate max-w-[240px]">
                          {conn.url}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {conn.type && (
                      <span className="text-xs text-slate-500 uppercase">
                        {conn.type}
                      </span>
                    )}
                    {statusBadge(conn.status, conn.enabled)}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Empty state */}
      {connections.length === 0 && !omniRoute && derivedProviders.length === 0 && (
        <Card className="bg-slate-900 border-slate-800">
          <CardContent className="pt-6">
            <div className="flex flex-col items-center justify-center py-8 gap-3">
              <Link className="h-8 w-8 text-slate-600" />
              <p className="text-sm text-slate-500">Không có kết nối nào</p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
