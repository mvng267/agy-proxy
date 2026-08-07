import { useEffect, useState, useCallback, useRef } from "react"
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
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
      <Badge className="bg-slate-700 text-slate-400 border-none text-[10px]">—</Badge>
    )
  }
  const map: Record<string, string> = {
    ok: "bg-emerald-500/15 text-emerald-400",
    active: "bg-emerald-500/15 text-emerald-400",
    error: "bg-red-500/15 text-red-400",
    dead: "bg-red-500/15 text-red-400",
    slow: "bg-amber-500/15 text-amber-400",
  }
  const cls = map[status] ?? "bg-slate-700 text-slate-400"
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
        <Skeleton className="h-10 w-full bg-slate-800" />
        <Skeleton className="h-64 w-full bg-slate-800" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <AlertTriangle className="h-8 w-8 text-red-500" />
        <p className="text-sm text-slate-400">Lỗi: {error}</p>
        <button
          onClick={fetchProxies}
          className="text-xs text-orange-400 hover:text-orange-300 flex items-center gap-1.5"
        >
          <RefreshCw className="h-3 w-3" /> Retry
        </button>
      </div>
    )
  }

  const proxies = data?.proxies ?? []

  return (
    <div className="space-y-4">
      {/* Import form */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
              <Download className="h-4 w-4 text-slate-500" />
              Import Proxy
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <label className="text-xs text-slate-500">URL (tùy chọn — load từ URL)</label>
            <Input
              placeholder="https://example.com/proxies.txt"
              value={importUrl}
              onChange={(e) => setImportUrl(e.target.value)}
              className="bg-slate-950 border-slate-700 text-slate-200 placeholder:text-slate-600 h-9 text-sm"
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs text-slate-500">
              Paste danh sách proxy (mỗi dòng 1 proxy: <code className="text-orange-400">host:port:user:pass</code> hoặc URL đầy đủ)
            </label>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder={"1.2.3.4:8080:user:pass\n5.6.7.8:3128\nsocks5://user:pass@9.10.11.12:1080"}
              rows={5}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-orange-500/50 focus:ring-1 focus:ring-orange-500/30 resize-y"
            />
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-400">
              <input
                type="checkbox"
                checked={importReplace}
                onChange={(e) => setImportReplace(e.target.checked)}
                className="rounded border-slate-600 bg-slate-800 text-orange-500"
              />
              Thay thế (xoá proxy cũ)
            </label>
            <Button
              size="sm"
              onClick={handleImport}
              disabled={importing || (!importText.trim() && !importUrl.trim())}
              className="bg-orange-500 hover:bg-orange-600 text-white h-8 text-xs gap-1.5"
            >
              {importing ? (
                <RefreshCw className="h-3 w-3 animate-spin" />
              ) : (
                <Download className="h-3 w-3" />
              )}
              {importing ? "Đang import…" : "Import"}
            </Button>
            {importMsg && (
              <span className={`text-xs ${importMsg.startsWith("Lỗi") ? "text-red-400" : "text-emerald-400"}`}>
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
          className="bg-slate-700 hover:bg-slate-600 text-slate-200 h-8 text-xs gap-1.5"
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
          className="border-slate-700 text-slate-400 hover:text-orange-400 h-8 text-xs gap-1"
        >
          <RefreshCw className="h-3 w-3" /> Refresh
        </Button>
        {assignMsg && (
          <span className={`text-xs ${assignMsg.startsWith("Lỗi") ? "text-red-400" : "text-emerald-400"}`}>
            {assignMsg}
          </span>
        )}
        <span className="text-xs text-slate-500 ml-auto">{proxies.length} proxy</span>
      </div>

      {/* Proxy table */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
            <Globe className="h-4 w-4 text-slate-500" />
            Danh sách proxy ({proxies.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="border-slate-800 hover:bg-transparent">
                <TableHead className="text-slate-500 text-xs pl-4">Label / Host</TableHead>
                <TableHead className="text-slate-500 text-xs">Protocol</TableHead>
                <TableHead className="text-slate-500 text-xs">Status</TableHead>
                <TableHead className="text-slate-500 text-xs">Latency</TableHead>
                <TableHead className="text-slate-500 text-xs">Country</TableHead>
                <TableHead className="text-slate-500 text-xs">Tested</TableHead>
                <TableHead className="text-slate-500 text-xs w-36" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {proxies.length === 0 ? (
                <TableRow className="border-slate-800">
                  <TableCell
                    colSpan={7}
                    className="text-center text-slate-600 text-xs py-10"
                  >
                    Chưa có proxy nào — import proxy bên trên để bắt đầu
                  </TableCell>
                </TableRow>
              ) : (
                proxies.map((proxy) => {
                  const testRes = testResults[proxy.label]
                  const isTestLoading = testRes === "loading"
                  const testResultObj = testRes !== undefined && testRes !== "loading" ? testRes : null
                  const isConfirmDelete = deletingLabel === proxy.label

                  // Effective latency: from test result or stored
                  const latency = testResultObj?.ms ?? proxy.latency

                  // Effective status: override from test result
                  const displayStatus = testResultObj
                    ? testResultObj.ok
                      ? "ok"
                      : "error"
                    : proxy.status

                  // Country from test result or stored
                  const country = testResultObj?.country ?? proxy.country

                  return (
                    <TableRow
                      key={proxy.label}
                      className="border-slate-800 hover:bg-slate-800/40"
                    >
                      <TableCell className="text-sm text-slate-200 font-mono pl-4">
                        {proxy.label}
                        {proxy.host && proxy.host !== proxy.label && (
                          <span className="text-slate-500 text-xs block">{proxy.host}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge className="bg-slate-800 text-slate-400 border-none text-[10px]">
                          {proxy.protocol ?? "http"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {isTestLoading ? (
                          <Badge className="bg-slate-700 text-slate-400 border-none text-[10px]">
                            <RefreshCw className="h-2.5 w-2.5 animate-spin mr-1 inline" />
                            testing…
                          </Badge>
                        ) : testResultObj && !testResultObj.ok ? (
                          <Badge className="bg-red-500/15 text-red-400 border-none text-[10px]">
                            ✕ {testResultObj.error?.slice(0, 20) ?? "fail"}
                          </Badge>
                        ) : (
                          <StatusBadge status={displayStatus} />
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-slate-400 tabular-nums">
                        {latency != null ? `${latency}ms` : "—"}
                      </TableCell>
                      <TableCell className="text-xs text-slate-500">
                        {country || "—"}
                      </TableCell>
                      <TableCell className="text-xs text-slate-500">
                        {proxy.lastTested
                          ? new Date(proxy.lastTested).toLocaleString("vi-VN", {
                              day: "2-digit",
                              month: "2-digit",
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1 justify-end pr-2">
                          {/* Test */}
                          <button
                            onClick={() => handleTest(proxy.label)}
                            disabled={isTestLoading}
                            className="p-1.5 rounded text-slate-500 hover:text-amber-400 hover:bg-slate-800 transition-colors disabled:opacity-50"
                            title="Test proxy"
                          >
                            <Zap className="h-3.5 w-3.5" />
                          </button>
                          {/* Copy */}
                          <button
                            onClick={() => handleCopy(proxy.label)}
                            className="p-1.5 rounded text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-colors"
                            title="Copy label"
                          >
                            {copiedLabel === proxy.label ? (
                              <Check className="h-3.5 w-3.5 text-emerald-400" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </button>
                          {/* Delete (2-click confirm) */}
                          <button
                            onClick={() => handleDelete(proxy.label)}
                            className={`p-1.5 rounded transition-colors ${
                              isConfirmDelete
                                ? "bg-red-500/20 text-red-400"
                                : "text-slate-500 hover:text-red-400 hover:bg-slate-800"
                            }`}
                            title={isConfirmDelete ? "Bấm lần nữa để xác nhận xoá" : "Xoá proxy"}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Dismiss confirm delete on outside click info */}
      {deletingLabel && (
        <p className="text-xs text-amber-400 text-center">
          Đang xoá <strong>{deletingLabel}</strong> — bấm nút đỏ lần nữa để xác nhận,{" "}
          <button
            onClick={() => setDeletingLabel(null)}
            className="underline hover:text-amber-300"
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
