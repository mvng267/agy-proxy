import { useEffect, useState, useCallback } from "react"
import {
  Shuffle,
  RefreshCw,
  AlertTriangle,
  Plus,
  Trash2,
  Search,
  Edit3,
  Copy,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Skeleton } from "@/components/ui/skeleton"
import { Separator } from "@/components/ui/separator"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

// ── Types ──────────────────────────────────────────────────────────────

interface Combo {
  id: string
  targets: string[]
  strategy: string
  enabled: boolean
}

interface CombosResponse {
  combos: Combo[]
  autoVariants?: boolean
}

interface ComboForm {
  id: string
  targets: string
  strategy: string
  enabled: boolean
}

const STRATEGIES = ["round-robin", "random", "least-used", "priority"]

const emptyForm: ComboForm = {
  id: "",
  targets: "",
  strategy: "round-robin",
  enabled: true,
}

// ── Combo Page ─────────────────────────────────────────────────────────

export function Combo() {
  const [combos, setCombos] = useState<Combo[]>([])
  const [autoVariants, setAutoVariants] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<ComboForm>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/combos")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as CombosResponse
      setCombos(json.combos ?? [])
      setAutoVariants(json.autoVariants ?? false)
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

  const handleCreate = () => {
    setEditingId(null)
    setForm(emptyForm)
    setDialogOpen(true)
  }

  const handleEdit = (combo: Combo) => {
    setEditingId(combo.id)
    setForm({
      id: combo.id,
      targets: combo.targets.join(", "),
      strategy: combo.strategy,
      enabled: combo.enabled,
    })
    setDialogOpen(true)
  }

  const handleSave = async () => {
    if (!form.id.trim() || !form.targets.trim()) return
    setSaving(true)
    try {
      const payload = {
        id: form.id.trim(),
        targets: form.targets.split(",").map((t) => t.trim()).filter(Boolean),
        strategy: form.strategy,
        enabled: form.enabled,
      }

      const res = await fetch("/api/combos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      setDialogOpen(false)
      setForm(emptyForm)
      setEditingId(null)
      fetchData()
    } catch {
      // keep dialog open on error
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/combos?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setDeleteConfirm(null)
      fetchData()
    } catch {
      // ignore
    }
  }

  const handleToggle = async (combo: Combo) => {
    try {
      await fetch("/api/combos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...combo,
          enabled: !combo.enabled,
        }),
      })
      fetchData()
    } catch {
      // ignore
    }
  }

  const copyId = (id: string) => {
    navigator.clipboard.writeText(id).catch(() => {
      // ignore
    })
  }

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

  const filtered = combos.filter((c) => {
    if (!search) return true
    const q = search.toLowerCase()
    return (
      c.id.toLowerCase().includes(q) ||
      c.targets.some((t) => t.toLowerCase().includes(q)) ||
      c.strategy.toLowerCase().includes(q)
    )
  })

  const enabledCount = combos.filter((c) => c.enabled).length

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="bg-slate-900 border-slate-800">
          <CardContent className="pt-4">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Total Combos</p>
                <p className="text-2xl font-bold text-slate-100 tabular-nums">{combos.length}</p>
              </div>
              <div className="p-2 rounded-lg bg-orange-500/10 text-orange-500">
                <Shuffle className="h-4 w-4" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-slate-900 border-slate-800">
          <CardContent className="pt-4">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Enabled</p>
                <p className="text-2xl font-bold text-emerald-400 tabular-nums">{enabledCount}</p>
              </div>
              <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-500">
                <Shuffle className="h-4 w-4" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-slate-900 border-slate-800">
          <CardContent className="pt-4">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Auto Variants</p>
                <p className="text-2xl font-bold text-slate-100">{autoVariants ? "On" : "Off"}</p>
              </div>
              <div className="p-2 rounded-lg bg-blue-500/10 text-blue-500">
                <Shuffle className="h-4 w-4" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500" />
          <Input
            placeholder="Tìm combo..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 bg-slate-900 border-slate-800 text-slate-200 placeholder:text-slate-600 h-9 text-sm"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={fetchData}
            className="border-slate-700 text-slate-400 hover:text-orange-400 h-9 text-xs gap-1"
          >
            <RefreshCw className="h-3 w-3" /> Refresh
          </Button>

          {/* Create Dialog */}
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger
              render={
                <Button
                  size="sm"
                  onClick={handleCreate}
                  className="bg-orange-500 hover:bg-orange-600 text-white h-9 text-xs gap-1"
                />
              }
            >
              <Plus className="h-3 w-3" /> Tạo Combo
            </DialogTrigger>
            <DialogContent className="bg-slate-900 border-slate-800 text-slate-200 sm:max-w-md">
              <DialogHeader>
                <DialogTitle className="text-slate-100">
                  {editingId ? "Sửa Combo" : "Tạo Combo mới"}
                </DialogTitle>
                <DialogDescription className="text-slate-500">
                  {editingId ? `Đang sửa: ${editingId}` : "Nhập thông tin combo model routing"}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-2">
                {/* Combo ID */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-slate-400">Combo ID</label>
                  <Input
                    placeholder="vd: claude-fast"
                    value={form.id}
                    onChange={(e) => setForm((f) => ({ ...f, id: e.target.value }))}
                    disabled={editingId !== null}
                    className="bg-slate-800 border-slate-700 text-slate-200 placeholder:text-slate-600 h-9 text-sm disabled:opacity-50"
                  />
                </div>

                {/* Targets */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-slate-400">Targets (comma-separated)</label>
                  <Input
                    placeholder="vd: claude-sonnet-4-20250514, claude-haiku"
                    value={form.targets}
                    onChange={(e) => setForm((f) => ({ ...f, targets: e.target.value }))}
                    className="bg-slate-800 border-slate-700 text-slate-200 placeholder:text-slate-600 h-9 text-sm"
                  />
                  <p className="text-[10px] text-slate-600">Các model ID cách nhau bằng dấu phẩy</p>
                </div>

                {/* Strategy */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-slate-400">Strategy</label>
                  <div className="flex flex-wrap gap-1.5">
                    {STRATEGIES.map((s) => (
                      <Button
                        key={s}
                        variant={form.strategy === s ? "default" : "outline"}
                        size="sm"
                        onClick={() => setForm((f) => ({ ...f, strategy: s }))}
                        className={
                          form.strategy === s
                            ? "bg-orange-500 hover:bg-orange-600 text-white h-7 text-xs"
                            : "border-slate-700 text-slate-400 hover:text-slate-200 hover:bg-slate-800 h-7 text-xs"
                        }
                      >
                        {s}
                      </Button>
                    ))}
                  </div>
                </div>

                <Separator className="bg-slate-800" />

                {/* Enabled */}
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-slate-400">Enabled</label>
                  <Switch
                    checked={form.enabled}
                    onCheckedChange={(checked) => setForm((f) => ({ ...f, enabled: checked }))}
                  />
                </div>
              </div>

              <DialogFooter>
                <Button
                  onClick={handleSave}
                  disabled={saving || !form.id.trim() || !form.targets.trim()}
                  className="bg-orange-500 hover:bg-orange-600 text-white text-xs disabled:opacity-50"
                >
                  {saving ? (
                    <>
                      <RefreshCw className="h-3 w-3 animate-spin" /> Đang lưu...
                    </>
                  ) : editingId ? (
                    "Cập nhật"
                  ) : (
                    "Tạo"
                  )}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Combos Table */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
            <Shuffle className="h-4 w-4 text-slate-500" />
            Combos ({filtered.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="border-slate-800 hover:bg-transparent">
                <TableHead className="text-slate-500 text-xs">ID</TableHead>
                <TableHead className="text-slate-500 text-xs">Targets</TableHead>
                <TableHead className="text-slate-500 text-xs">Strategy</TableHead>
                <TableHead className="text-slate-500 text-xs text-center">Enabled</TableHead>
                <TableHead className="text-slate-500 text-xs text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow className="border-slate-800">
                  <TableCell colSpan={5} className="text-center text-slate-600 text-xs py-8">
                    {search ? "Không tìm thấy combo" : "Chưa có combo nào"}
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((combo) => (
                  <TableRow key={combo.id} className="border-slate-800 hover:bg-slate-800/50">
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm text-slate-200 font-mono">{combo.id}</span>
                        <button
                          onClick={() => copyId(combo.id)}
                          className="text-slate-600 hover:text-slate-400 transition-colors"
                          title="Copy ID"
                        >
                          <Copy className="h-3 w-3" />
                        </button>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {combo.targets.map((t) => (
                          <Badge
                            key={t}
                            className="bg-slate-700 text-slate-300 border-none text-[10px] font-mono"
                          >
                            {t}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge className="bg-blue-500/15 text-blue-400 border-none text-[10px]">
                        {combo.strategy}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={combo.enabled}
                        onCheckedChange={() => handleToggle(combo)}
                        size="sm"
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleEdit(combo)}
                          className="border-slate-700 text-slate-400 hover:text-blue-400 h-7 w-7 p-0"
                          title="Sửa"
                        >
                          <Edit3 className="h-3 w-3" />
                        </Button>

                        {deleteConfirm === combo.id ? (
                          <div className="flex items-center gap-1">
                            <Button
                              size="sm"
                              onClick={() => handleDelete(combo.id)}
                              className="bg-red-600 hover:bg-red-700 text-white h-7 text-[10px] px-2"
                            >
                              Xoá
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setDeleteConfirm(null)}
                              className="border-slate-700 text-slate-400 h-7 text-[10px] px-2"
                            >
                              Huỷ
                            </Button>
                          </div>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setDeleteConfirm(combo.id)}
                            className="border-slate-700 text-slate-400 hover:text-red-400 h-7 w-7 p-0"
                            title="Xoá"
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        )}
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
