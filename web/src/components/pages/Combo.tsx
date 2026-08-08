import { useEffect, useState, useCallback } from "react"
import { KpiCard, PageHeader } from "@/components/common"
import { SegmentBar } from "@/components/common/charts"
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
import { DataTable } from "@/components/common/DataTable"
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

// ── Types ──────────────────────────────────────────────────────────────

interface ComboTarget {
  model: string
  weight?: number
}

interface Combo {
  id: string
  targets: ComboTarget[]
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

// Phải khớp ComboStrategy backend (src/gateway/combo.ts) — giá trị lạ bị backend
// âm thầm ép về "priority".
const STRATEGIES = ["priority", "round-robin", "weighted", "highest-quota"]

const emptyForm: ComboForm = {
  id: "",
  targets: "",
  strategy: "priority",
  enabled: true,
}

// Targets trong form là chuỗi "model" hoặc "model:weight" cách nhau dấu phẩy.
// Model id không chứa ":" (dạng agy/… kr/…) nên suffix số sau ":" luôn là weight.
function targetsToText(targets: ComboTarget[]): string {
  return targets.map((t) => (t.weight != null ? `${t.model}:${t.weight}` : t.model)).join(", ")
}

function parseTargets(text: string): ComboTarget[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^(.*):(\d+(?:\.\d+)?)$/.exec(s)
      if (m) return { model: m[1]!.trim(), weight: Number(m[2]) }
      return { model: s }
    })
    .filter((t) => t.model)
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
      targets: targetsToText(combo.targets),
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
        targets: parseTargets(form.targets),
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
      const res = await fetch(`/api/combos/${encodeURIComponent(id)}`, {
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
        <PageHeader title="Combo" desc="Nhóm nhiều model thành một tên gọi, có thứ tự ưu tiên" />
        <Skeleton className="h-10 w-full bg-muted" />
        <Skeleton className="h-64 w-full bg-muted" />
      </div>
    )
  }

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

  const filtered = combos.filter((c) => {
    if (!search) return true
    const q = search.toLowerCase()
    return (
      c.id.toLowerCase().includes(q) ||
      c.targets.some((t) => t.model.toLowerCase().includes(q)) ||
      c.strategy.toLowerCase().includes(q)
    )
  })

  const enabledCount = combos.filter((c) => c.enabled).length

  return (
    <div className="space-y-4">
      <PageHeader title="Combo" desc="Nhóm nhiều model thành một tên gọi, có thứ tự ưu tiên" />
      {/* Summary — KpiCard chung thay 3 Card tay (text-2xl/bold, thiếu dấu góc + nền lưới). */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard label="Tổng combo" value={combos.length} icon={Shuffle} loading={loading} />
        <KpiCard
          label="Đang bật"
          value={enabledCount}
          tone="success"
          sub={combos.length ? `${Math.round((enabledCount / combos.length) * 100)}% tổng` : undefined}
          icon={Shuffle}
          loading={loading}
        />
        <KpiCard label="Auto variants" value={autoVariants ? "On" : "Off"} icon={Shuffle} loading={loading} />
      </div>

      {/* Bật/tắt cộng lại đúng 100% → SegmentBar. */}
      {combos.length > 0 && (
        <SegmentBar
          segments={[
            { label: "Bật", value: enabledCount, tone: "success" },
            { label: "Tắt", value: combos.length - enabledCount, tone: "muted" },
          ]}
        />
      )}


      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Tìm combo..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 bg-card border-border text-foreground placeholder:text-muted-foreground h-9 text-sm"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={fetchData}
            className="border-border text-muted-foreground hover:text-primary h-9 text-xs gap-1"
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
                  className="bg-primary hover:bg-primary text-primary-foreground h-9 text-xs gap-1"
                />
              }
            >
              <Plus className="h-3 w-3" /> Tạo Combo
            </DialogTrigger>
            <DialogContent className="bg-card border-border text-foreground sm:max-w-md">
              <DialogHeader>
                <DialogTitle className="text-foreground">
                  {editingId ? "Sửa Combo" : "Tạo Combo mới"}
                </DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  {editingId ? `Đang sửa: ${editingId}` : "Nhập thông tin combo model routing"}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-2">
                {/* Combo ID */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Combo ID</label>
                  <Input
                    placeholder="vd: claude-fast"
                    value={form.id}
                    onChange={(e) => setForm((f) => ({ ...f, id: e.target.value }))}
                    disabled={editingId !== null}
                    className="bg-muted border-border text-foreground placeholder:text-muted-foreground h-9 text-sm disabled:opacity-50"
                  />
                </div>

                {/* Targets */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Targets (comma-separated)</label>
                  <Input
                    placeholder="vd: agy/gemini-3-pro, kr/claude-sonnet-4.5:2"
                    value={form.targets}
                    onChange={(e) => setForm((f) => ({ ...f, targets: e.target.value }))}
                    className="bg-muted border-border text-foreground placeholder:text-muted-foreground h-9 text-sm"
                  />
                  <p className="text-[10px] text-muted-foreground">Các model ID cách nhau bằng dấu phẩy — thêm :số để đặt trọng số (strategy weighted)</p>
                </div>

                {/* Strategy */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Strategy</label>
                  <div className="flex flex-wrap gap-1.5">
                    {STRATEGIES.map((s) => (
                      <Button
                        key={s}
                        variant={form.strategy === s ? "default" : "outline"}
                        size="sm"
                        onClick={() => setForm((f) => ({ ...f, strategy: s }))}
                        className={
                          form.strategy === s
                            ? "bg-primary hover:bg-primary text-primary-foreground h-7 text-xs"
                            : "border-border text-muted-foreground hover:text-foreground hover:bg-muted h-7 text-xs"
                        }
                      >
                        {s}
                      </Button>
                    ))}
                  </div>
                </div>

                <Separator className="bg-muted" />

                {/* Enabled */}
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-muted-foreground">Enabled</label>
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
                  className="bg-primary hover:bg-primary text-primary-foreground text-xs disabled:opacity-50"
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
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-foreground flex items-center gap-2">
            <Shuffle className="h-4 w-4 text-muted-foreground" />
            Combos ({filtered.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable
            rows={filtered}
            rowKey={(c) => c.id}
            pageSize={25}
            empty={search ? "Không tìm thấy combo" : "Chưa có combo nào"}
            initialSort={{ key: "id", dir: "asc" }}
            columns={[
              {
                key: "id",
                header: "ID",
                sort: (c) => c.id,
                render: (c) => (
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-sm text-foreground">{c.id}</span>
                    <button
                      onClick={() => copyId(c.id)}
                      className="text-muted-foreground transition-colors hover:text-foreground"
                      title="Copy ID"
                    >
                      <Copy className="h-3 w-3" />
                    </button>
                  </div>
                ),
              },
              {
                key: "targets",
                header: "Targets",
                render: (c) => (
                  <div className="flex flex-wrap gap-1">
                    {c.targets.map((t) => (
                      <Badge key={t.model} className="border-none bg-muted font-mono text-[10px] text-foreground">
                        {t.model}{t.weight != null ? ` ×${t.weight}` : ""}
                      </Badge>
                    ))}
                  </div>
                ),
              },
              {
                key: "strategy",
                header: "Strategy",
                sort: (c) => c.strategy,
                render: (c) => <Badge className="border-none bg-info/15 text-[10px] text-info">{c.strategy}</Badge>,
              },
              {
                key: "enabled",
                header: "Enabled",
                align: "center",
                sort: (c) => (c.enabled ? 1 : 0),
                render: (c) => <Switch checked={c.enabled} onCheckedChange={() => handleToggle(c)} size="sm" />,
              },
              {
                key: "actions",
                header: "",
                align: "right",
                render: (c) => (
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleEdit(c)}
                      className="h-7 w-7 border-border p-0 text-muted-foreground hover:text-info"
                      title="Sửa"
                    >
                      <Edit3 className="h-3 w-3" />
                    </Button>
                    {/* Xoá 2 bước — giữ nguyên: combo bị xoá không khôi phục được. */}
                    {deleteConfirm === c.id ? (
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          onClick={() => handleDelete(c.id)}
                          className="h-7 bg-destructive px-2 text-[10px] text-destructive-foreground hover:bg-destructive"
                        >
                          Xoá
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setDeleteConfirm(null)}
                          className="h-7 border-border px-2 text-[10px] text-muted-foreground"
                        >
                          Huỷ
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setDeleteConfirm(c.id)}
                        className="h-7 w-7 border-border p-0 text-muted-foreground hover:text-destructive"
                        title="Xoá"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                ),
              },
            ]}
          />
        </CardContent>
      </Card>
    </div>
  )
}
