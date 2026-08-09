import { useEffect, useState, useCallback, useRef } from "react"
import { PageHeader } from "@/components/common"
import {
  Globe,
  RefreshCw,
  AlertTriangle,
  Trash2,
  Copy,
  Check,
  Zap,
  Download,
  Link2,
} from "lucide-react"
import { DataTable } from "@/components/common/DataTable"
import { Checkbox } from "@/components/ui/checkbox"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"

// ── Types ──────────────────────────────────────────────────────────────

interface ProxyEntry {
  label: string
  host?: string
  protocol?: string
  status?: string
  latency?: number
  lastTested?: string
  country?: string
}

interface ProxyData {
  proxies: ProxyEntry[]
}

interface TestResult {
  ok: boolean
  ip?: string
  ms?: number
  country?: string
  error?: string
}

interface ImportResult {
  added?: number
  error?: string
}

interface AutoAssignResult {
  assigned?: number
  error?: string
}

// ── Status badge ───────────────────────────────────────────────────────

function StatusBadge({ status }: { status?: string }) {
  if (!status) {
    return (
      <Badge className="bg-muted text-muted-foreground">—</Badge>
    )
  }
  const map: Record<string, string> = {
    ok: "bg-success/15 text-success",
    active: "bg-success/15 text-success",
    error: "bg-destructive/15 text-destructive",
    dead: "bg-destructive/15 text-destructive",
    slow: "bg-warning/15 text-warning",
  }
  const cls = map[status] ?? "bg-muted text-muted-foreground"
  return (
    <Badge className={`${cls} border-none text-[10px]`}>{status}</Badge>
  )
}

// ── Proxy Page ─────────────────────────────────────────────────────────

export function Proxy() {
  const [data, setData] = useState<ProxyData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Import form state
  const [importUrl, setImportUrl] = useState("")
  const [importText, setImportText] = useState("")
  const [importReplace, setImportReplace] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState<string | null>(null)

  // Per-row test state
  const [testResults, setTestResults] = useState<Record<string, TestResult | "loading">>({})

  // Copy state
  const [copiedLabel, setCopiedLabel] = useState<string | null>(null)

  // Auto-assign state
  const [assigning, setAssigning] = useState(false)
  const [assignMsg, setAssignMsg] = useState<string | null>(null)

  // Delete confirm
  const [deletingLabel, setDeletingLabel] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)

  const fetchProxies = useCallback(async () => {
    try {
      const res = await fetch("/api/proxies")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as ProxyData
      setData(json)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchProxies()
  }, [fetchProxies])

  // ── Import ─────────────────────────────────────────────────────────

  const handleImport = async () => {
    if (!importText.trim() && !importUrl.trim()) return
    setImporting(true)
    setImportMsg(null)
    try {
      const res = await fetch("/api/proxies/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: importUrl.trim() || undefined,
          text: importText.trim() || undefined,
          replace: importReplace,
        }),
      })
      const json = (await res.json()) as ImportResult
      if (json.error) {
        setImportMsg(`Lỗi: ${json.error}`)
      } else {
        setImportMsg(`Đã import ${json.added ?? 0} proxy`)
        setImportText("")
        setImportUrl("")
        fetchProxies()
      }
    } catch (err) {
      setImportMsg(err instanceof Error ? err.message : "Import lỗi")
    } finally {
      setImporting(false)
    }
  }

  // ── Test proxy ─────────────────────────────────────────────────────

  const handleTest = async (label: string) => {
    setTestResults((prev) => ({ ...prev, [label]: "loading" }))
    try {
      const res = await fetch(`/api/proxies/test/${encodeURIComponent(label)}`, {
        method: "POST",
      })
      const json = (await res.json()) as TestResult
      setTestResults((prev) => ({ ...prev, [label]: json }))
    } catch {
      setTestResults((prev) => ({ ...prev, [label]: { ok: false, error: "Request failed" } }))
    }
  }

  // ── Delete proxy ───────────────────────────────────────────────────

  const handleDelete = async (label: string) => {
    if (deletingLabel !== label) {
      setDeletingLabel(label)
      return
    }
    // Second click = confirmed
    setDeletingLabel(null)
    try {
      await fetch(`/api/proxies/${encodeURIComponent(label)}`, { method: "DELETE" })
      fetchProxies()
    } catch {
      // ignore
    }
  }

  // ── Copy proxy label ───────────────────────────────────────────────

  const handleCopy = (label: string) => {
    navigator.clipboard.writeText(label).catch(() => {})
    setCopiedLabel(label)
    setTimeout(() => setCopiedLabel(null), 1500)
  }

  // ── Auto-assign ────────────────────────────────────────────────────

  const handleAutoAssign = async () => {
    setAssigning(true)
    setAssignMsg(null)
    try {
      const res = await fetch("/api/accounts/auto-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      const json = (await res.json()) as AutoAssignResult
      if (json.error) {
        setAssignMsg(`Lỗi: ${json.error}`)
      } else {
        setAssignMsg(`Đã gán proxy cho ${json.assigned ?? 0} account`)
      }
    } catch (err) {
      setAssignMsg(err instanceof Error ? err.message : "Lỗi auto-assign")
    } finally {
      setAssigning(false)
    }
  }

  // ── Loading ────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-4">
        <PageHeader title="Proxy" desc="Danh sách proxy và kết quả kiểm tra kết nối" />
        <Skeleton className="h-10 w-full bg-muted" />
        <Skeleton className="h-64 w-full bg-muted" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <AlertTriangle className="h-8 w-8 text-destructive" />
        <p className="text-sm text-muted-foreground">Lỗi: {error}</p>
        <button
          onClick={fetchProxies}
          className="text-xs text-primary hover:text-primary flex items-center gap-1.5"
        >
          <RefreshCw className="h-3 w-3" /> Retry
        </button>
      </div>
    )
  }

  const proxies = data?.proxies ?? []

  return (
    <div className="space-y-4">
      <PageHeader title="Proxy" desc="Danh sách proxy và kết quả kiểm tra kết nối" />
      {/* Import form */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium text-foreground flex items-center gap-2">
              <Download className="h-4 w-4 text-muted-foreground" />
              Import Proxy
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground">URL (tùy chọn — load từ URL)</label>
            <Input
              placeholder="https://example.com/proxies.txt"
              value={importUrl}
              onChange={(e) => setImportUrl(e.target.value)}
              className="bg-background border-border text-foreground placeholder:text-muted-foreground h-9 text-sm"
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground">
              Paste danh sách proxy (mỗi dòng 1 proxy: <code className="text-primary">host:port:user:pass</code> hoặc URL đầy đủ)
            </label>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder={"1.2.3.4:8080:user:pass\n5.6.7.8:3128\nsocks5://user:pass@9.10.11.12:1080"}
              rows={5}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30 resize-y"
            />
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-2 cursor-pointer text-xs text-muted-foreground">
              <Checkbox checked={importReplace} onCheckedChange={(v) => setImportReplace(!!v)} />
              Thay thế (xoá proxy cũ)
            </label>
            <Button
              size="sm"
              onClick={handleImport}
              disabled={importing || (!importText.trim() && !importUrl.trim())}
              className="bg-primary hover:bg-primary text-primary-foreground h-8 text-xs gap-1.5"
            >
              {importing ? (
                <RefreshCw className="h-3 w-3 animate-spin" />
              ) : (
                <Download className="h-3 w-3" />
              )}
              {importing ? "Đang import…" : "Import"}
            </Button>
            {importMsg && (
              <span className={`text-xs ${importMsg.startsWith("Lỗi") ? "text-destructive" : "text-success"}`}>
                {importMsg}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Auto-assign + actions */}
      <div className="flex items-center gap-3 flex-wrap">
        <Button
          size="sm"
          onClick={handleAutoAssign}
          disabled={assigning}
          className="bg-muted hover:bg-muted-foreground/40 text-foreground h-8 text-xs gap-1.5"
        >
          {assigning ? (
            <RefreshCw className="h-3 w-3 animate-spin" />
          ) : (
            <Link2 className="h-3 w-3" />
          )}
          Auto-assign proxy
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={fetchProxies}
          className="border-border text-muted-foreground hover:text-primary h-8 text-xs gap-1"
        >
          <RefreshCw className="h-3 w-3" /> Refresh
        </Button>
        {assignMsg && (
          <span className={`text-xs ${assignMsg.startsWith("Lỗi") ? "text-destructive" : "text-success"}`}>
            {assignMsg}
          </span>
        )}
        <span className="text-xs text-muted-foreground ml-auto">{proxies.length} proxy</span>
      </div>

      {/* Proxy table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-foreground flex items-center gap-2">
            <Globe className="h-4 w-4 text-muted-foreground" />
            Danh sách proxy ({proxies.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable
            rows={proxies}
            rowKey={(p) => p.label}
            pageSize={25}
            empty="Chưa có proxy nào — import proxy bên trên để bắt đầu"
            columns={[
              {
                key: "label",
                header: "Label / Host",
                sort: (p) => p.label,
                render: (p) => (
                  <div className="font-mono text-sm text-foreground">
                    {p.label}
                    {p.host && p.host !== p.label && (
                      <span className="block text-xs text-muted-foreground">{p.host}</span>
                    )}
                  </div>
                ),
              },
              {
                key: "protocol",
                header: "Protocol",
                sort: (p) => p.protocol ?? "http",
                render: (p) => (
                  <Badge className="bg-muted text-muted-foreground">{p.protocol ?? "http"}</Badge>
                ),
              },
              {
                key: "status",
                header: "Status",
                sort: (p) => p.status ?? "",
                render: (p) => {
                  const t = testResults[p.label]
                  const obj = t !== undefined && t !== "loading" ? t : null
                  if (t === "loading") {
                    return (
                      <Badge className="bg-muted text-muted-foreground">
                        <RefreshCw className="mr-1 inline h-2.5 w-2.5 animate-spin" />testing…
                      </Badge>
                    )
                  }
                  if (obj && !obj.ok) {
                    return (
                      <Badge className="bg-destructive/15 text-destructive">
                        ✕ {obj.error?.slice(0, 20) ?? "fail"}
                      </Badge>
                    )
                  }
                  return <StatusBadge status={obj ? (obj.ok ? "ok" : "error") : p.status} />
                },
              },
              {
                key: "latency",
                header: "Latency",
                sort: (p) => {
                  const t = testResults[p.label]
                  const obj = t !== undefined && t !== "loading" ? t : null
                  return obj?.ms ?? p.latency ?? Number.MAX_SAFE_INTEGER
                },
                render: (p) => {
                  const t = testResults[p.label]
                  const obj = t !== undefined && t !== "loading" ? t : null
                  const ms = obj?.ms ?? p.latency
                  return <span className="text-sm tabular-nums text-muted-foreground">{ms != null ? `${ms}ms` : "—"}</span>
                },
              },
              {
                key: "country",
                header: "Country",
                sort: (p) => p.country ?? "",
                render: (p) => {
                  const t = testResults[p.label]
                  const obj = t !== undefined && t !== "loading" ? t : null
                  return <span className="text-xs text-muted-foreground">{obj?.country ?? p.country ?? "—"}</span>
                },
              },
              {
                key: "lastTested",
                header: "Tested",
                sort: (p) => p.lastTested ?? 0,
                render: (p) => (
                  <span className="text-xs text-muted-foreground">
                    {p.lastTested
                      ? new Date(p.lastTested).toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
                      : "—"}
                  </span>
                ),
              },
              {
                key: "actions",
                header: "",
                align: "right",
                render: (p) => {
                  const isLoading = testResults[p.label] === "loading"
                  const confirming = deletingLabel === p.label
                  return (
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => handleTest(p.label)}
                        disabled={isLoading}
                        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-warning disabled:opacity-50"
                        title="Test proxy"
                      >
                        <Zap className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => handleCopy(p.label)}
                        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        title="Copy label"
                      >
                        {copiedLabel === p.label ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
                      </button>
                      {/* Xoá 2 lần bấm — giữ nguyên. */}
                      <button
                        onClick={() => handleDelete(p.label)}
                        className={`rounded p-1.5 transition-colors ${
                          confirming ? "bg-destructive/20 text-destructive" : "text-muted-foreground hover:bg-muted hover:text-destructive"
                        }`}
                        title={confirming ? "Bấm lần nữa để xác nhận xoá" : "Xoá proxy"}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )
                },
              },
            ]}
          />
        </CardContent>
      </Card>

      {/* Dismiss confirm delete on outside click info */}
      {deletingLabel && (
        <p className="text-xs text-warning text-center">
          Đang xoá <strong>{deletingLabel}</strong> — bấm nút đỏ lần nữa để xác nhận,{" "}
          <button
            onClick={() => setDeletingLabel(null)}
            className="underline hover:text-warning"
          >
            hoặc huỷ
          </button>
        </p>
      )}

      {/* Hidden file input (for future use) */}
      <input ref={fileInputRef} type="file" className="hidden" accept=".txt,.csv" />
    </div>
  )
}
