import { useEffect, useState, useCallback } from "react"
import {
  Globe,
  RefreshCw,
  AlertTriangle,
  Plus,
  Trash2,
  Copy,
  Check,
  ServerCrash,
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
  host: string
  port?: number
  protocol?: string
  username?: string
  status?: string
  latency?: number
  lastChecked?: string
}

interface ProxyData {
  proxies: ProxyEntry[]
}

// ── Proxy Page ─────────────────────────────────────────────────────────

export function Proxy() {
  const [data, setData] = useState<ProxyData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notConfigured, setNotConfigured] = useState(false)
  const [newProxy, setNewProxy] = useState("")
  const [adding, setAdding] = useState(false)
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)

  const fetchProxies = useCallback(async () => {
    try {
      const res = await fetch("/api/gateway/proxies")
      if (res.status === 404) {
        setNotConfigured(true)
        setData(null)
        setError(null)
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as ProxyData
      setData(json)
      setNotConfigured(false)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchProxies()
    const interval = setInterval(fetchProxies, 30_000)
    return () => clearInterval(interval)
  }, [fetchProxies])

  const handleAdd = async () => {
    const trimmed = newProxy.trim()
    if (!trimmed) return
    setAdding(true)
    try {
      const res = await fetch("/api/gateway/proxies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxy: trimmed }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setNewProxy("")
      fetchProxies()
    } catch {
      // ignore — server may not support POST
    } finally {
      setAdding(false)
    }
  }

  const handleDelete = async (host: string) => {
    try {
      const res = await fetch("/api/gateway/proxies", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      fetchProxies()
    } catch {
      // ignore
    }
  }

  const handleCopy = (text: string, idx: number) => {
    navigator.clipboard.writeText(text)
    setCopiedIdx(idx)
    setTimeout(() => setCopiedIdx(null), 1500)
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

  // ── Error ──────────────────────────────────────────────────────────

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <AlertTriangle className="h-8 w-8 text-red-500" />
        <p className="text-sm text-slate-400">Error: {error}</p>
        <button
          onClick={fetchProxies}
          className="text-xs text-orange-400 hover:text-orange-300 flex items-center gap-1.5"
        >
          <RefreshCw className="h-3 w-3" /> Retry
        </button>
      </div>
    )
  }

  // ── Not configured ─────────────────────────────────────────────────

  if (notConfigured) {
    return (
      <div className="space-y-4">
        <Card className="bg-slate-900 border-slate-800">
          <CardContent className="pt-6">
            <div className="flex flex-col items-center justify-center py-12 gap-4">
              <div className="p-4 rounded-2xl bg-slate-800/50">
                <ServerCrash className="h-10 w-10 text-slate-600" />
              </div>
              <div className="text-center space-y-1.5">
                <h3 className="text-sm font-medium text-slate-300">
                  Chưa cấu hình proxy
                </h3>
                <p className="text-xs text-slate-500 max-w-sm">
                  Proxy chưa được thiết lập. Thêm proxy vào file{" "}
                  <code className="px-1 py-0.5 rounded bg-slate-800 text-orange-400 font-mono text-[11px]">
                    proxies.csv
                  </code>{" "}
                  hoặc cấu hình qua API.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={fetchProxies}
                className="border-slate-700 text-slate-400 hover:text-orange-400 h-8 text-xs gap-1.5 mt-2"
              >
                <RefreshCw className="h-3 w-3" /> Kiểm tra lại
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  // ── Data ────────────────────────────────────────────────────────────

  const proxies = data?.proxies ?? []

  const statusBadge = (status?: string) => {
    switch (status) {
      case "active":
      case "ok":
        return (
          <Badge className="bg-emerald-500/15 text-emerald-400 border-none text-[10px]">
            Active
          </Badge>
        )
      case "error":
      case "dead":
        return (
          <Badge className="bg-red-500/15 text-red-400 border-none text-[10px]">
            Error
          </Badge>
        )
      case "slow":
        return (
          <Badge className="bg-amber-500/15 text-amber-400 border-none text-[10px]">
            Slow
          </Badge>
        )
      default:
        return (
          <Badge className="bg-slate-700 text-slate-400 border-none text-[10px]">
            {status ?? "Unknown"}
          </Badge>
        )
    }
  }

  const formatProxy = (p: ProxyEntry) => {
    const proto = p.protocol ?? "http"
    const port = p.port ? `:${p.port}` : ""
    return `${proto}://${p.host}${port}`
  }

  return (
    <div className="space-y-4">
      {/* Add proxy bar */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-lg">
          <Globe className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500" />
          <Input
            placeholder="http://host:port hoặc socks5://user:pass@host:port"
            value={newProxy}
            onChange={(e) => setNewProxy(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAdd()
            }}
            className="pl-9 bg-slate-900 border-slate-800 text-slate-200 placeholder:text-slate-600 h-9 text-sm"
          />
        </div>
        <Button
          size="sm"
          onClick={handleAdd}
          disabled={adding || !newProxy.trim()}
          className="bg-orange-500 hover:bg-orange-600 text-white h-9 text-xs gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" />
          Thêm
        </Button>
      </div>

      {/* Proxy table */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
              <Globe className="h-4 w-4 text-slate-500" />
              Proxies ({proxies.length})
            </CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={fetchProxies}
              className="border-slate-700 text-slate-400 hover:text-orange-400 h-7 text-xs gap-1"
            >
              <RefreshCw className="h-3 w-3" /> Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="border-slate-800 hover:bg-transparent">
                <TableHead className="text-slate-500 text-xs">
                  Host
                </TableHead>
                <TableHead className="text-slate-500 text-xs">
                  Protocol
                </TableHead>
                <TableHead className="text-slate-500 text-xs">
                  Status
                </TableHead>
                <TableHead className="text-slate-500 text-xs text-right">
                  Latency
                </TableHead>
                <TableHead className="text-slate-500 text-xs">
                  Last Checked
                </TableHead>
                <TableHead className="text-slate-500 text-xs w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {proxies.length === 0 ? (
                <TableRow className="border-slate-800">
                  <TableCell
                    colSpan={6}
                    className="text-center text-slate-600 text-xs py-8"
                  >
                    Không có proxy nào
                  </TableCell>
                </TableRow>
              ) : (
                proxies.map((proxy, idx) => (
                  <TableRow
                    key={`${proxy.host}-${idx}`}
                    className="border-slate-800 hover:bg-slate-800/50"
                  >
                    <TableCell className="text-sm text-slate-200 font-mono">
                      {proxy.host}
                      {proxy.port ? `:${proxy.port}` : ""}
                    </TableCell>
                    <TableCell>
                      <Badge className="bg-slate-700 text-slate-300 border-none text-[10px]">
                        {proxy.protocol ?? "http"}
                      </Badge>
                    </TableCell>
                    <TableCell>{statusBadge(proxy.status)}</TableCell>
                    <TableCell className="text-right text-sm text-slate-400 tabular-nums">
                      {proxy.latency != null ? `${proxy.latency}ms` : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-slate-500">
                      {proxy.lastChecked
                        ? new Date(proxy.lastChecked).toLocaleString()
                        : "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1 justify-end">
                        <button
                          onClick={() => handleCopy(formatProxy(proxy), idx)}
                          className="p-1 rounded text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-colors"
                          title="Copy proxy URL"
                        >
                          {copiedIdx === idx ? (
                            <Check className="h-3 w-3 text-emerald-400" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                        </button>
                        <button
                          onClick={() => handleDelete(proxy.host)}
                          className="p-1 rounded text-slate-500 hover:text-red-400 hover:bg-slate-800 transition-colors"
                          title="Xoá proxy"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
