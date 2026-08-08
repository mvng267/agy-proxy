import { useEffect, useState, useCallback } from "react"
import { KpiCard, PageHeader } from "@/components/common"
import { SegmentBar } from "@/components/common/charts"
import {
  Cpu,
  RefreshCw,
  AlertTriangle,
  Zap,
  Copy,
  Check,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Activity,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

// ── Types ──────────────────────────────────────────────────────────────

interface Model {
  id: string
  provider?: string
  providerLabel?: string
  label?: string
  bucket?: string        // "gemini" | "claude" | ...
  status?: string        // "ok" | "quota" | "error" | "unknown" | "image"
  detail?: string
  ms?: number
  image?: boolean
}

interface ModelsResponse {
  models?: Model[]
  data?: Model[]
}

interface CheckResponse {
  models?: Model[]
  account?: string
  error?: string
  queued?: number
}

type CopiedMap = Record<string, boolean>

// ── Helpers ────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { color: string; dotColor: string; label: string; icon: React.ReactNode }> = {
  ok:      { color: "bg-success/15 text-success", dotColor: "bg-success", label: "live",    icon: <CheckCircle2 className="h-2.5 w-2.5" /> },
  quota:   { color: "bg-warning/15 text-warning",     dotColor: "bg-warning",   label: "quota",   icon: <AlertTriangle className="h-2.5 w-2.5" /> },
  error:   { color: "bg-destructive/15 text-destructive",         dotColor: "bg-destructive",     label: "error",   icon: <XCircle className="h-2.5 w-2.5" /> },
  image:   { color: "bg-info/15 text-info",   dotColor: "bg-info",  label: "image",   icon: <Cpu className="h-2.5 w-2.5" /> },
  unknown: { color: "bg-muted/60 text-muted-foreground",     dotColor: "bg-muted-foreground/40",   label: "—",       icon: <HelpCircle className="h-2.5 w-2.5" /> },
}

function statusCfg(status?: string) {
  return STATUS_CONFIG[status ?? "unknown"] ?? STATUS_CONFIG.unknown
}

function fmtMs(ms: number | undefined) {
  if (ms == null) return ""
  return `${ms}ms`
}

// ── Model Chip ─────────────────────────────────────────────────────────

function ModelChip({
  model,
  onCopy,
  copied,
}: {
  model: Model
  onCopy: (id: string) => void
  copied: boolean
}) {
  const cfg = statusCfg(model.status)
  const tip = [
    cfg.label !== "—" ? cfg.label : "chưa kiểm",
    model.detail ? `— ${model.detail}` : "",
    model.ms ? fmtMs(model.ms) : "",
  ]
    .filter(Boolean)
    .join(" ")

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-border/50 text-xs font-mono ${cfg.color} bg-muted/70 group relative`}
      title={tip}
    >
      {/* Status dot */}
      <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${cfg.dotColor}`} />

      {/* Image icon */}
      {(model.image || model.status === "image") && (
        <span className="text-[10px]">🖼</span>
      )}

      {/* Model ID */}
      <span className="text-foreground">{model.id}</span>

      {/* Latency */}
      {model.ms != null && (
        <span className="text-muted-foreground text-[10px]">{fmtMs(model.ms)}</span>
      )}

      {/* Copy button */}
      <button
        onClick={() => onCopy(model.id)}
        className="opacity-0 group-hover:opacity-100 transition-opacity ml-0.5 text-muted-foreground hover:text-foreground"
        title="Copy model id"
      >
        {copied ? (
          <Check className="h-2.5 w-2.5 text-success" />
        ) : (
          <Copy className="h-2.5 w-2.5" />
        )}
      </button>
    </span>
  )
}

// ── Models Page ────────────────────────────────────────────────────────

export function Models() {
  const [models, setModels] = useState<Model[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeProvider, setActiveProvider] = useState<string>("all")
  const [checkingAll, setCheckingAll] = useState(false)
  const [probingKiro, setProbingKiro] = useState(false)
  const [checkResult, setCheckResult] = useState<string | null>(null)
  const [copied, setCopied] = useState<CopiedMap>({})

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/gateway/models")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as ModelsResponse
      const list = json.models ?? json.data ?? []
      setModels(list)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 60_000)
    return () => clearInterval(interval)
  }, [fetchData])

  const handleCopy = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id)
      setCopied((prev) => ({ ...prev, [id]: true }))
      setTimeout(() => setCopied((prev) => ({ ...prev, [id]: false })), 1500)
    } catch {
      // ignore
    }
  }

  const copyAll = async (providerModels: Model[]) => {
    try {
      const ids = providerModels.map((m) => m.id).join("\n")
      await navigator.clipboard.writeText(ids)
      setCheckResult(`Đã copy ${providerModels.length} model id`)
      setTimeout(() => setCheckResult(null), 2000)
    } catch {
      // ignore
    }
  }

  const checkAllLive = async () => {
    setCheckingAll(true)
    setCheckResult("Đang gọi thử từng model (1–2 phút)…")
    try {
      const res = await fetch("/api/gateway/models/check?provider=all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      const json = (await res.json()) as CheckResponse
      if (json.models && json.models.length > 0) {
        // Merge status into existing models
        const statusMap: Record<string, Partial<Model>> = {}
        for (const m of json.models) statusMap[m.id] = m
        setModels((prev) =>
          prev.map((m) => (statusMap[m.id] ? { ...m, ...statusMap[m.id] } : m))
        )
        const ok = json.models.filter((m) => m.status === "ok").length
        setCheckResult(`Check live: ${ok}/${json.models.length} model gọi được · via ${json.account ?? "unknown"}`)
      } else if (json.error) {
        setCheckResult(`Lỗi: ${json.error}`)
      } else {
        setCheckResult("Check xong")
      }
    } catch (err) {
      setCheckResult(`Lỗi: ${err instanceof Error ? err.message : "Unknown"}`)
    } finally {
      setCheckingAll(false)
    }
  }

  const checkSingleModel = async (model: Model) => {
    try {
      const res = await fetch(`/api/gateway/models/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: model.provider ?? "agy" }),
      })
      const json = (await res.json()) as CheckResponse
      if (json.models) {
        const statusMap: Record<string, Partial<Model>> = {}
        for (const m of json.models) statusMap[m.id] = m
        setModels((prev) =>
          prev.map((m) => (statusMap[m.id] ? { ...m, ...statusMap[m.id] } : m))
        )
      }
    } catch {
      // ignore
    }
  }

  const probeKiro = async () => {
    setProbingKiro(true)
    setCheckResult("Đang dò tài khoản Kiro (nền)…")
    try {
      const res = await fetch("/api/gateway/probe?provider=kr&limit=10", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      const json = await res.json() as { queued?: number; error?: string }
      if (json.error) {
        setCheckResult(`Lỗi probe: ${json.error}`)
      } else {
        setCheckResult(`Đang dò ${json.queued ?? 10} account Kiro (nền — xem Live log)`)
      }
    } catch (err) {
      setCheckResult(`Lỗi: ${err instanceof Error ? err.message : "Unknown"}`)
    } finally {
      setProbingKiro(false)
    }
  }

  // ── Loading ────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="flex gap-2">
          <Skeleton className="h-8 w-24 bg-muted" />
          <Skeleton className="h-8 w-24 bg-muted" />
        </div>
        <Skeleton className="h-48 w-full bg-muted" />
        <Skeleton className="h-48 w-full bg-muted" />
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

  // ── Group models by provider + bucket ─────────────────────────────

  const BUCKET_LABEL: Record<string, string> = {
    gemini: "Gemini Models",
    claude: "Claude and GPT models",
  }

  type ProviderGroup = {
    key: string
    providerKey: string
    title: string
    models: Model[]
    bucket?: string
  }

  const groupMap: Record<string, ProviderGroup> = {}
  for (const m of models) {
    const pid = m.provider ?? "unknown"
    const bk = m.bucket
    const key = bk ? `${pid}:${bk}` : pid
    if (!groupMap[key]) {
      const bucketLabel = bk ? BUCKET_LABEL[bk] ?? bk : null
      const provLabel = m.providerLabel ?? pid.toUpperCase()
      const title = bucketLabel ? `${provLabel} · ${bucketLabel}` : provLabel
      groupMap[key] = { key, providerKey: pid, title, models: [], bucket: bk }
    }
    groupMap[key].models.push(m)
  }

  const groups = Object.values(groupMap)

  // Extract unique providers for tabs
  const providerKeys = [...new Set(groups.map((g) => g.providerKey))]

  const filteredGroups =
    activeProvider === "all"
      ? groups
      : groups.filter((g) => g.providerKey === activeProvider)

  const statusCounts = {
    ok: models.filter((m) => m.status === "ok").length,
    quota: models.filter((m) => m.status === "quota").length,
    error: models.filter((m) => m.status === "error").length,
    unknown: models.filter((m) => !m.status || m.status === "unknown").length,
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Models" desc="Model khả dụng của từng provider và trạng thái kiểm tra" />
      {/* Header + actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Cpu className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium text-foreground">
            Models ({models.length})
          </h2>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={fetchData}
            className="border-border text-muted-foreground hover:text-primary h-7 text-xs gap-1"
          >
            <RefreshCw className="h-3 w-3" /> Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={checkingAll}
            onClick={checkAllLive}
            className="border-border text-muted-foreground hover:text-success h-7 text-xs gap-1"
            title="Gọi thử từng model (1-2 phút)"
          >
            {checkingAll ? (
              <RefreshCw className="h-3 w-3 animate-spin" />
            ) : (
              <Activity className="h-3 w-3" />
            )}
            Check all live
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={probingKiro}
            onClick={probeKiro}
            className="border-border text-muted-foreground hover:text-info h-7 text-xs gap-1"
            title="Probe Kiro accounts để tìm model dùng được"
          >
            {probingKiro ? (
              <RefreshCw className="h-3 w-3 animate-spin" />
            ) : (
              <Zap className="h-3 w-3" />
            )}
            Probe Kiro
          </Button>
        </div>
      </div>

      {/* Status feedback */}
      {checkResult && (
        <div className="bg-muted/60 border border-border rounded-lg px-4 py-2.5 text-xs text-foreground">
          {checkResult}
        </div>
      )}

      {/* KPI row — KpiCard chung (text-xl/bold tay trước đây khác cỡ với các trang khác). */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="Live" value={statusCounts.ok} tone="success" icon={Cpu} loading={loading} />
        <KpiCard label="Quota" value={statusCounts.quota} tone="warning" icon={Cpu} loading={loading} />
        <KpiCard label="Error" value={statusCounts.error} tone="danger" icon={Cpu} loading={loading} />
        <KpiCard label="Chưa kiểm" value={statusCounts.unknown} icon={Cpu} loading={loading} />
      </div>

      {/* Bốn trạng thái cộng lại = tổng số model → SegmentBar. */}
      {models.length > 0 && (
        <SegmentBar
          segments={[
            { label: "Live", value: statusCounts.ok, tone: "success" },
            { label: "Quota", value: statusCounts.quota, tone: "warning" },
            { label: "Error", value: statusCounts.error, tone: "danger" },
            { label: "Chưa kiểm", value: statusCounts.unknown, tone: "muted" },
          ]}
        />
      )}

      {/* Provider tabs */}
      {providerKeys.length > 1 && (
        <div className="flex items-center gap-1.5 bg-muted/60 rounded-lg p-1 w-fit">
          <button
            onClick={() => setActiveProvider("all")}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              activeProvider === "all"
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Tất cả
          </button>
          {providerKeys.map((pk) => {
            const provLabel =
              models.find((m) => (m.provider ?? "unknown") === pk)?.providerLabel ??
              pk.toUpperCase()
            return (
              <button
                key={pk}
                onClick={() => setActiveProvider(pk)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  activeProvider === pk
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {provLabel}
                <span className="ml-1.5 text-muted-foreground text-[10px]">
                  {models.filter((m) => (m.provider ?? "unknown") === pk).length}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {/* Groups */}
      {filteredGroups.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="pt-6">
            <div className="flex flex-col items-center justify-center py-8 gap-3">
              <Cpu className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Không có model</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        filteredGroups.map((group) => {
          const okCount = group.models.filter((m) => m.status === "ok").length
          const quotaCount = group.models.filter((m) => m.status === "quota").length
          const checkedCount = group.models.filter((m) => m.status && m.status !== "unknown").length

          return (
            <Card key={group.key} className="bg-card border-border">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <CardTitle className="text-sm font-medium text-foreground flex items-center gap-2">
                    <Cpu className="h-4 w-4 text-muted-foreground" />
                    {group.title}
                    <span className="text-muted-foreground font-normal text-xs">
                      {group.models.length} model
                    </span>
                  </CardTitle>
                  <div className="flex items-center gap-2 flex-wrap">
                    {/* Status summary */}
                    {checkedCount > 0 && (
                      <div className="flex items-center gap-1.5 text-xs">
                        {okCount > 0 && (
                          <span className="text-success">{okCount} live</span>
                        )}
                        {quotaCount > 0 && (
                          <span className="text-warning">{quotaCount} quota</span>
                        )}
                      </div>
                    )}
                    {/* Check provider button */}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => checkSingleModel(group.models[0])}
                      className="h-6 text-[10px] text-muted-foreground hover:text-foreground px-2 gap-1"
                      title="Check provider này"
                    >
                      <Activity className="h-3 w-3" />
                      Check
                    </Button>
                    {/* Copy all */}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => copyAll(group.models)}
                      className="h-6 text-[10px] text-muted-foreground hover:text-foreground px-2 gap-1"
                    >
                      <Copy className="h-3 w-3" />
                      Copy tất cả
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {group.models.map((m) => (
                    <ModelChip
                      key={m.id}
                      model={m}
                      onCopy={handleCopy}
                      copied={!!copied[m.id]}
                    />
                  ))}
                </div>

                {/* Legend */}
                <div className="flex items-center gap-3 mt-3 pt-3 border-t border-border">
                  {Object.entries(STATUS_CONFIG)
                    .filter(([k]) => k !== "unknown")
                    .map(([k, cfg]) => (
                      <span key={k} className="flex items-center gap-1 text-[10px] text-muted-foreground">
                        <span className={`h-1.5 w-1.5 rounded-full ${cfg.dotColor}`} />
                        {cfg.label}
                      </span>
                    ))}
                  <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
                    chưa kiểm
                  </span>
                </div>
              </CardContent>
            </Card>
          )
        })
      )}
    </div>
  )
}
