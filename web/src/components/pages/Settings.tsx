import { useEffect, useState, useCallback } from "react"
import {
  Settings as SettingsIcon,
  RefreshCw,
  AlertTriangle,
  Save,
  CheckCircle2,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Skeleton } from "@/components/ui/skeleton"
import { Separator } from "@/components/ui/separator"

// ── Types ──────────────────────────────────────────────────────────────

interface GatewayConfig {
  enabled?: boolean
  rotation?: string
  cooldownSec?: number
  maxRetries?: number
  timeout?: number
  logLevel?: string
  [key: string]: unknown
}

// ── Settings Page ───────────────────────────────────────────────────────

export function Settings() {
  const [config, setConfig] = useState<GatewayConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Form state
  const [enabled, setEnabled] = useState(true)
  const [rotation, setRotation] = useState("round-robin")
  const [cooldownSec, setCooldownSec] = useState("60")
  const [maxRetries, setMaxRetries] = useState("3")
  const [timeout, setTimeout_] = useState("30")
  const [logLevel, setLogLevel] = useState("info")

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/gateway/config")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as GatewayConfig
      setConfig(json)
      // Sync form state
      setEnabled(json.enabled !== false)
      setRotation(json.rotation ?? "round-robin")
      setCooldownSec(String(json.cooldownSec ?? 60))
      setMaxRetries(String(json.maxRetries ?? 3))
      setTimeout_(String(json.timeout ?? 30))
      setLogLevel(json.logLevel ?? "info")
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchConfig()
  }, [fetchConfig])

  const handleSave = async () => {
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const patch: GatewayConfig = {
        enabled,
        rotation,
        cooldownSec: parseInt(cooldownSec, 10) || 60,
        maxRetries: parseInt(maxRetries, 10) || 3,
        timeout: parseInt(timeout, 10) || 30,
        logLevel,
      }

      const res = await fetch("/api/gateway/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      })

      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
      await fetchConfig()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  // ── Loading ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-48 w-full bg-slate-800" />
        <Skeleton className="h-48 w-full bg-slate-800" />
      </div>
    )
  }

  // ── Error (initial load) ─────────────────────────────────────────────

  if (error && !config) {
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

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <SettingsIcon className="h-4 w-4 text-slate-500" />
          <h2 className="text-sm font-medium text-slate-300">Cấu hình Gateway</h2>
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

      {/* Gateway toggle */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-slate-300">
            Gateway
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between py-1">
            <div>
              <p className="text-sm text-slate-200">Gateway Enabled</p>
              <p className="text-xs text-slate-500 mt-0.5">
                Bật/tắt toàn bộ gateway proxy
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Badge
                className={
                  enabled
                    ? "bg-emerald-500/15 text-emerald-400 border-none text-[10px]"
                    : "bg-slate-700 text-slate-400 border-none text-[10px]"
                }
              >
                {enabled ? "Enabled" : "Disabled"}
              </Badge>
              <Switch
                checked={enabled}
                onCheckedChange={setEnabled}
                className="data-[state=checked]:bg-orange-500"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Rotation & Cooldown */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-slate-300">
            Rotation & Cooldown
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Rotation strategy */}
          <div className="space-y-2">
            <label className="text-sm text-slate-200">Rotation Strategy</label>
            <p className="text-xs text-slate-500">
              Chiến lược xoay vòng accounts
            </p>
            <select
              value={rotation}
              onChange={(e) => setRotation(e.target.value)}
              className="w-full h-9 px-3 rounded-md bg-slate-800 border border-slate-700 text-slate-200 text-sm focus:outline-none focus:ring-1 focus:ring-orange-500"
            >
              <option value="round-robin">Round Robin</option>
              <option value="random">Random</option>
              <option value="least-used">Least Used</option>
              <option value="first-available">First Available</option>
            </select>
          </div>

          <Separator className="bg-slate-800" />

          {/* Cooldown */}
          <div className="space-y-2">
            <label className="text-sm text-slate-200">
              Cooldown (giây)
            </label>
            <p className="text-xs text-slate-500">
              Thời gian chờ sau khi account bị 429 hoặc lỗi
            </p>
            <Input
              type="number"
              min={0}
              max={3600}
              value={cooldownSec}
              onChange={(e) => setCooldownSec(e.target.value)}
              className="bg-slate-800 border-slate-700 text-slate-200 h-9 text-sm w-40"
            />
          </div>
        </CardContent>
      </Card>

      {/* Advanced */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-slate-300">
            Advanced
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Max retries */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm text-slate-200">Max Retries</label>
              <p className="text-xs text-slate-500">Số lần retry khi lỗi</p>
              <Input
                type="number"
                min={0}
                max={10}
                value={maxRetries}
                onChange={(e) => setMaxRetries(e.target.value)}
                className="bg-slate-800 border-slate-700 text-slate-200 h-9 text-sm"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm text-slate-200">Timeout (giây)</label>
              <p className="text-xs text-slate-500">Request timeout</p>
              <Input
                type="number"
                min={5}
                max={300}
                value={timeout}
                onChange={(e) => setTimeout_(e.target.value)}
                className="bg-slate-800 border-slate-700 text-slate-200 h-9 text-sm"
              />
            </div>
          </div>

          <Separator className="bg-slate-800" />

          {/* Log level */}
          <div className="space-y-2">
            <label className="text-sm text-slate-200">Log Level</label>
            <p className="text-xs text-slate-500">Mức độ log</p>
            <select
              value={logLevel}
              onChange={(e) => setLogLevel(e.target.value)}
              className="w-full h-9 px-3 rounded-md bg-slate-800 border border-slate-700 text-slate-200 text-sm focus:outline-none focus:ring-1 focus:ring-orange-500"
            >
              <option value="debug">Debug</option>
              <option value="info">Info</option>
              <option value="warn">Warn</option>
              <option value="error">Error</option>
            </select>
          </div>
        </CardContent>
      </Card>

      {/* Error from save */}
      {error && config && (
        <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5">
          <AlertTriangle className="h-3.5 w-3.5 text-red-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-red-400">{error}</p>
        </div>
      )}

      {/* Save button */}
      <div className="flex items-center gap-3">
        <Button
          onClick={handleSave}
          disabled={saving}
          className="bg-orange-500 hover:bg-orange-600 text-white gap-2 disabled:opacity-50"
        >
          {saving ? (
            <RefreshCw className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          {saving ? "Đang lưu..." : "Lưu cấu hình"}
        </Button>

        {saved && (
          <div className="flex items-center gap-1.5 text-emerald-400 text-sm">
            <CheckCircle2 className="h-4 w-4" />
            Đã lưu thành công!
          </div>
        )}
      </div>

      {/* Raw config preview */}
      {config && (
        <Card className="bg-slate-900 border-slate-800">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-slate-500">
              Raw Config
            </CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="text-[11px] text-slate-400 overflow-x-auto leading-relaxed">
              {JSON.stringify(config, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
