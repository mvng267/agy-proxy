import { useEffect, useState, useCallback } from "react"
import {
  Cpu,
  RefreshCw,
  AlertTriangle,
  Search,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

// ── Types ──────────────────────────────────────────────────────────────

interface Model {
  id: string
  provider?: string
  label?: string
  object?: string
  created?: number
  owned_by?: string
}

interface ModelsResponse {
  models?: Model[]
  data?: Model[]
}

// ── Models Page ────────────────────────────────────────────────────────

export function Models() {
  const [models, setModels] = useState<Model[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/gateway/models")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as ModelsResponse
      // API may return { models: [...] } or { data: [...] }
      setModels(json.models ?? json.data ?? [])
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

  // Extract unique providers
  const providers = [...new Set(models.map((m) => m.provider ?? m.owned_by ?? "unknown"))]

  const filtered = models.filter((m) => {
    if (!search) return true
    const q = search.toLowerCase()
    return (
      m.id.toLowerCase().includes(q) ||
      (m.label ?? "").toLowerCase().includes(q) ||
      (m.provider ?? m.owned_by ?? "").toLowerCase().includes(q)
    )
  })

  return (
    <div className="space-y-4">
      {/* Summary KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="bg-slate-900 border-slate-800">
          <CardContent className="pt-4">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Total Models</p>
                <p className="text-2xl font-bold text-slate-100 tabular-nums">{models.length}</p>
              </div>
              <div className="p-2 rounded-lg bg-orange-500/10 text-orange-500">
                <Cpu className="h-4 w-4" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-slate-900 border-slate-800">
          <CardContent className="pt-4">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Providers</p>
                <p className="text-2xl font-bold text-slate-100 tabular-nums">{providers.length}</p>
              </div>
              <div className="p-2 rounded-lg bg-blue-500/10 text-blue-500">
                <Cpu className="h-4 w-4" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-slate-900 border-slate-800">
          <CardContent className="pt-4">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Matched</p>
                <p className="text-2xl font-bold text-slate-100 tabular-nums">{filtered.length}</p>
                {search && <p className="text-xs text-slate-500">of {models.length}</p>}
              </div>
              <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-500">
                <Search className="h-4 w-4" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Search */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500" />
          <Input
            placeholder="Tìm model..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 bg-slate-900 border-slate-800 text-slate-200 placeholder:text-slate-600 h-9 text-sm"
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={fetchData}
          className="border-slate-700 text-slate-400 hover:text-orange-400 h-9 text-xs gap-1"
        >
          <RefreshCw className="h-3 w-3" /> Refresh
        </Button>
      </div>

      {/* Table */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
            <Cpu className="h-4 w-4 text-slate-500" />
            Models ({filtered.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="border-slate-800 hover:bg-transparent">
                <TableHead className="text-slate-500 text-xs">#</TableHead>
                <TableHead className="text-slate-500 text-xs">Model ID</TableHead>
                <TableHead className="text-slate-500 text-xs">Provider</TableHead>
                <TableHead className="text-slate-500 text-xs">Label</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow className="border-slate-800">
                  <TableCell colSpan={4} className="text-center text-slate-600 text-xs py-8">
                    {search ? "Không tìm thấy model" : "Không có model"}
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((m, idx) => (
                  <TableRow key={m.id} className="border-slate-800 hover:bg-slate-800/50">
                    <TableCell className="text-xs text-slate-600 tabular-nums w-10">
                      {idx + 1}
                    </TableCell>
                    <TableCell className="text-sm text-slate-200 font-mono">
                      {m.id}
                    </TableCell>
                    <TableCell>
                      <Badge className="bg-slate-700 text-slate-300 border-none text-[10px]">
                        {m.provider ?? m.owned_by ?? "—"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-slate-400">
                      {m.label ?? m.id.split("/").pop() ?? "—"}
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
