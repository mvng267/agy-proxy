import { useState, useCallback } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { POLL } from "@/lib/queryClient"
import { KpiCard, PageHeader, writeClipboard } from "@/components/common"
import { useToast } from "@/components/ui/toast"
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
  X,
  ChevronUp,
  ChevronDown,
} from "lucide-react"
import { DataTable } from "@/components/common/DataTable"
import { ComboRuns } from "./ComboRuns"
import { ModelSelect } from "@/components/common/ModelSelect"
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
  /**
   * Backend TÍNH SẴN hai số này (7 ngày) và trả về từ lâu, nhưng interface cũ không khai
   * nên chúng bị vứt đi. Production: `translate-question` có 11.703 lần gọi / 6.828 lần
   * phải trượt bước (58%) mà giao diện không hiện ở đâu.
   */
  calls?: number
  fallbacks?: number
}

interface CombosResponse {
  combos: Combo[]
  /**
   * MẢNG id biến thể (`["auto","auto/fast","auto/quota","auto/stable"]`), không phải cờ.
   * Bản trước khai `boolean` rồi render `autoVariants ? "On" : "Off"` — mảng luôn truthy
   * nên thẻ KPI đó luôn hiện "On", không mang thông tin gì.
   */
  autoVariants?: string[]
}

interface ComboForm {
  id: string
  /** Mảng bước, không phải chuỗi — chọn từ danh sách nên không sai id được. */
  steps: ComboTarget[]
  strategy: string
  enabled: boolean
}

// Phải khớp ComboStrategy backend (src/gateway/combo.ts) — giá trị lạ bị backend
// âm thầm ép về "priority".
const STRATEGIES = ["priority", "round-robin", "weighted", "highest-quota"]

const emptyForm: ComboForm = {
  id: "",
  steps: [],
  strategy: "priority",
  enabled: true,
}

// Form giữ MẢNG bước, không phải chuỗi "model:weight, model:weight".
// Hai hàm chuyển đổi chuỗi ↔ mảng đã bỏ: chọn từ dropdown thì không có chuỗi để parse,
// và cũng không còn cách nào gõ sai id.

// ── Combo Page ─────────────────────────────────────────────────────────

export function Combo() {
  const toast = useToast()
  const qc = useQueryClient()

  /**
   * Tab tự viết tay, KHÔNG dùng TabShell — cả hai cùng ghi `?tab=` vào URL và sẽ giẫm lên
   * nhau. Reports.tsx đã gặp đúng chuyện này và cũng viết tay vì lý do đó.
   */
  const [tab, setTab] = useState<"combo" | "log" | "bao-cao">(
    () => (new URLSearchParams(location.search).get("ctab") as never) || "combo",
  )
  const doiTab = (t: "combo" | "log" | "bao-cao") => {
    setTab(t)
    const u = new URL(location.href)
    u.searchParams.set("ctab", t)
    history.replaceState(null, "", u)
  }
  const [search, setSearch] = useState("")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<ComboForm>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  /** Model gọi được — nguồn cho dropdown, để không ai gõ sai id. */

  /**
   * Chạy thử combo — TỐN QUOTA THẬT.
   *
   * `/api/gateway/chat` đã trả sẵn `steps[]` (model, ok, ms, error) nên không cần endpoint
   * mới: đúng thứ cần để thấy combo đi qua bước nào, trượt ở đâu, vì sao.
   *
   * Hai state này PHẢI khai ở đây, TRƯỚC mọi `return` sớm (loading/error). Đặt sau chúng
   * thì lượt render đang loading chạy ít hook hơn lượt sau → React error 310 "rendered
   * more hooks than during the previous render", và cả trang crash — đã xảy ra thật.
   */
  const [thuId, setThuId] = useState<string | null>(null)
  const [ketQua, setKetQua] = useState<{
    id: string
    ok: boolean
    text?: string
    error?: string
    steps: Array<{ model: string; ok: boolean; ms: number; error?: string }>
  } | null>(null)

  const steps = form.steps

  /**
   * Chỉ mời model THẬT, không mời combo.
   * Combo lồng combo không được engine đệ quy (`runComboRequest` bỏ qua bước non-provider),
   * nên cho chọn là tạo ra bước chết âm thầm.
   */

  const addStep = (id: string | null) => {
    if (!id) return
    setForm((f) => (f.steps.some((t) => t.model === id) ? f : { ...f, steps: [...f.steps, { model: id }] }))
  }
  const removeStep = (i: number) => setForm((f) => ({ ...f, steps: f.steps.filter((_, k) => k !== i) }))
  const moveStep = (i: number, d: -1 | 1) =>
    setForm((f) => {
      const j = i + d
      if (j < 0 || j >= f.steps.length) return f
      const next = [...f.steps]
      ;[next[i], next[j]] = [next[j]!, next[i]!]
      return { ...f, steps: next }
    })
  const setStepWeight = (i: number, w: number) =>
    setForm((f) => ({ ...f, steps: f.steps.map((t, k) => (k === i ? { ...t, weight: w } : t)) }))

  /**
   * React Query thay `fetch` trần + `setInterval`.
   *
   * `fetch` trần bỏ qua tầng xử lý 401 của `lib/api` — phiên hết hạn thì trang chỉ im lặng
   * thay vì quay về màn đăng nhập. Ngoài ra `setInterval` vẫn chạy khi tab ẩn, còn
   * `refetchInterval` thì dừng.
   */
  const q = useQuery({
    queryKey: ["combos"],
    queryFn: () => api.get<CombosResponse>("/api/combos"),
    refetchInterval: POLL.normal,
  })
  const combos = q.data?.combos ?? []
  const autoVariants = q.data?.autoVariants ?? []
  const loading = q.isLoading
  const error = q.error ? (q.error instanceof Error ? q.error.message : String(q.error)) : null
  const fetchData = useCallback(() => { void qc.invalidateQueries({ queryKey: ["combos"] }) }, [qc])

  const handleCreate = () => {
    setEditingId(null)
    setForm(emptyForm)
    setDialogOpen(true)
  }

  const handleEdit = (combo: Combo) => {
    setEditingId(combo.id)
    setForm({
      id: combo.id,
      steps: combo.targets ?? [],
      strategy: combo.strategy,
      enabled: combo.enabled,
    })
    setDialogOpen(true)
  }

  const handleSave = async () => {
    if (!form.id.trim() || form.steps.length === 0) return
    setSaving(true)
    try {
      const payload = {
        id: form.id.trim(),
        targets: form.steps,
        strategy: form.strategy,
        enabled: form.enabled,
      }

      await api.post("/api/combos", payload)
      setDialogOpen(false)
      setForm(emptyForm)
      setEditingId(null)
      fetchData()
    } catch (e) {
      // Giữ dialog mở, NHƯNG phải nói vì sao — `catch {}` rỗng làm người dùng bấm Lưu mà
      // không thấy gì xảy ra và không hiểu tại sao.
      toast({ title: "Lưu combo thất bại", description: String(e instanceof Error ? e.message : e).slice(0, 120), variant: "error" })
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await api.del(`/api/combos/${encodeURIComponent(id)}`)
      setDeleteConfirm(null)
      fetchData()
    } catch (e) {
      toast({ title: "Xoá combo thất bại", description: String(e instanceof Error ? e.message : e).slice(0, 120), variant: "error" })
    }
  }

  const handleToggle = async (combo: Combo) => {
    try {
      await api.post("/api/combos", { ...combo, enabled: !combo.enabled })
      fetchData()
    } catch (e) {
      toast({ title: "Bật/tắt combo thất bại", description: String(e instanceof Error ? e.message : e).slice(0, 120), variant: "error" })
    }
  }

  const copyId = async (id: string) => {
    if (!(await writeClipboard(id))) toast({ title: "Không sao chép được", description: "Hãy bôi đen rồi Ctrl+C", variant: "error" })
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

  const chayThu = async (id: string) => {
    setThuId(id)
    setKetQua(null)
    try {
      // CỐ Ý dùng `fetch` trần thay vì `api.post`: endpoint này trả HTTP 200 kèm
      // `{ok:false, error, steps}` khi combo trượt — đó là DỮ LIỆU cần hiển thị, không
      // phải lỗi tầng mạng. `api` sẽ ném và ta mất luôn `steps[]`.
      const r = await fetch("/api/gateway/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: `combo/${id}`,
          messages: [{ role: "user", content: "1+1? Trả lời đúng một từ." }],
        }),
      })
      const j = await r.json()
      setKetQua({ id, ok: !!j.ok, text: j.text, error: j.error, steps: j.steps ?? [] })
      if (!j.ok) toast({ title: `Combo "${id}" lỗi`, description: String(j.error ?? "").slice(0, 120), variant: "error" })
    } catch (e) {
      setKetQua({ id, ok: false, error: e instanceof Error ? e.message : String(e), steps: [] })
    } finally {
      setThuId(null)
    }
  }

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
        {/* SỐ biến thể, không phải "On/Off" — backend trả mảng nên cờ boolean luôn true. */}
        <KpiCard
          label="Auto variants"
          value={autoVariants.length}
          sub={autoVariants.length ? autoVariants.join(" · ") : undefined}
          icon={Shuffle}
          loading={loading}
        />
      </div>

      {/* Bật/tắt cộng lại đúng 100% → SegmentBar. */}
      {combos.length > 0 && tab === "combo" && (
        <SegmentBar
          segments={[
            { label: "Bật", value: enabledCount, tone: "success" },
            { label: "Tắt", value: combos.length - enabledCount, tone: "muted" },
          ]}
        />
      )}

      <div className="flex gap-1 border-b border-border">
        {([
          { k: "combo", label: "Combo" },
          { k: "log", label: "Log chạy" },
          { k: "bao-cao", label: "Báo cáo" },
        ] as const).map((t) => (
          <button
            key={t.k}
            onClick={() => doiTab(t.k)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
              tab === t.k
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab !== "combo" && <ComboRuns tab={tab} />}

      {tab === "combo" && (
      <>
      {/* Kết quả chạy thử — hiện ĐƯỜNG ĐI qua từng bước, thứ mà log lịch sử không cho
          thấy ngay lúc thử. */}
      {ketQua && (
        <Card>
          <CardContent className="space-y-2 p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-foreground">
                Chạy thử <span className="font-mono">{ketQua.id}</span>
              </span>
              <button
                onClick={() => setKetQua(null)}
                className="text-muted-foreground transition-colors hover:text-foreground"
                aria-label="Đóng kết quả"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {ketQua.steps.length > 0 && (
              <div className="space-y-1">
                {ketQua.steps.map((st, i) => (
                  <div key={`${st.model}-${i}`} className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2 py-1.5">
                    <span className="w-5 shrink-0 text-center text-[10px] tabular-nums text-muted-foreground">{i + 1}</span>
                    <Badge className={st.ok ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive"}>
                      {st.ok ? "OK" : "trượt"}
                    </Badge>
                    <span className="flex-1 truncate font-mono text-xs text-foreground" title={st.model}>{st.model}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {st.ms >= 1000 ? `${(st.ms / 1000).toFixed(1)}s` : `${st.ms}ms`}
                    </span>
                    {st.error && (
                      <span className="max-w-[18rem] shrink-0 truncate text-xs text-muted-foreground" title={st.error}>
                        {st.error}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}

            <p className={`text-xs ${ketQua.ok ? "text-foreground" : "text-destructive"}`}>
              {ketQua.ok
                ? `Trả lời: ${String(ketQua.text ?? "").slice(0, 160)}`
                : `Lỗi: ${String(ketQua.error ?? "").slice(0, 200)}`}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Toolbar */}
      <div className="flex flex-col flex-wrap gap-3 sm:flex-row sm:items-center">
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

                {/*
                  Bộ chọn model — thay ô gõ chuỗi "agy/x:2, kr/y:1".
                  Gõ tay đòi người dùng nhớ chính xác id trong 32 model; sai một ký tự là
                  combo hỏng và chỉ biết khi gọi thật. Chọn từ danh sách thì không sai được,
                  và thấy luôn thứ tự thử.
                */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    Model trong combo{steps.length ? ` (${steps.length})` : ""}
                  </label>

                  {steps.length > 0 && (
                    <div className="space-y-1">
                      {steps.map((t, i) => (
                        <div key={`${t.model}-${i}`} className="flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1.5">
                          {/* Số thứ tự = thứ tự THỬ, thứ quyết định hành vi combo */}
                          <span className="w-5 shrink-0 text-center text-[10px] tabular-nums text-muted-foreground">{i + 1}</span>
                          <span className="flex-1 truncate font-mono text-xs text-foreground" title={t.model}>{t.model}</span>

                          {/* Trọng số chỉ có nghĩa với strategy weighted — ẩn ở strategy khác
                              cho khỏi gây hiểu nhầm là nó luôn tác dụng. */}
                          {form.strategy === "weighted" && (
                            <input
                              type="number"
                              min={1}
                              value={t.weight ?? 1}
                              onChange={(e) => setStepWeight(i, Math.max(1, Number(e.target.value) || 1))}
                              title="Trọng số"
                              className="h-6 w-14 rounded border border-border bg-background px-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                            />
                          )}

                          <button
                            onClick={() => moveStep(i, -1)}
                            disabled={i === 0}
                            title="Lên trên"
                            aria-label={`Đưa ${t.model} lên trên`}
                            className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
                          >
                            <ChevronUp className="h-3 w-3" />
                          </button>
                          <button
                            onClick={() => moveStep(i, 1)}
                            disabled={i === steps.length - 1}
                            title="Xuống dưới"
                            aria-label={`Đưa ${t.model} xuống dưới`}
                            className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
                          >
                            <ChevronDown className="h-3 w-3" />
                          </button>
                          <button
                            onClick={() => removeStep(i)}
                            title="Bỏ khỏi combo"
                            aria-label={`Bỏ ${t.model}`}
                            className="rounded p-0.5 text-muted-foreground transition-colors hover:text-destructive"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* `excludeCombo` giữ luật riêng của trang này: không cho combo lồng
                      combo. `exclude` bỏ model đã chọn khỏi danh sách. */}
                  <ModelSelect
                    value=""
                    onChange={addStep}
                    excludeCombo
                    exclude={steps.map((t) => t.model)}
                    placeholder="+ Thêm model…"
                    className="h-9 w-full text-sm"
                  />

                  <p className="text-[10px] text-muted-foreground">
                    Thử theo thứ tự từ trên xuống; bước lỗi thì trượt sang bước kế.
                    {form.strategy === "weighted" ? " Trọng số càng cao càng hay được chọn." : ""}
                  </p>
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
                  disabled={saving || !form.id.trim() || form.steps.length === 0}
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
      <Card>
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
                /**
                 * Số backend TÍNH SẴN mà bản trước vứt đi.
                 *
                 * Tỉ lệ trượt là thứ đáng nhìn nhất: combo phải trượt bước nghĩa là bước
                 * đầu hỏng, mỗi lần như vậy tốn thêm cả chục giây chờ trước khi sang bước
                 * kế. Production: `translate-question` trượt 58% số lần gọi.
                 */
                key: "calls",
                header: "Gọi · Trượt",
                align: "right",
                sort: (c) => c.calls ?? 0,
                render: (c) => {
                  const g = c.calls ?? 0
                  const t = c.fallbacks ?? 0
                  if (!g) return <span className="text-xs text-muted-foreground">—</span>
                  const pct = Math.round((t / g) * 100)
                  return (
                    <div className="flex items-center justify-end gap-1.5 text-xs tabular-nums">
                      <span className="text-foreground">{g.toLocaleString("vi-VN")}</span>
                      <span className="text-muted-foreground">·</span>
                      <span className={pct >= 50 ? "text-destructive" : pct >= 20 ? "text-warning" : "text-muted-foreground"}>
                        {t.toLocaleString("vi-VN")}
                        {t > 0 ? ` (${pct}%)` : ""}
                      </span>
                    </div>
                  )
                },
              },
              {
                key: "targets",
                header: "Targets",
                render: (c) => (
                  <div className="flex flex-wrap gap-1">
                    {c.targets.map((t) => (
                      <Badge key={t.model} className=" bg-muted font-mono text-foreground">
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
                render: (c) => <Badge className="bg-info/15 text-info">{c.strategy}</Badge>,
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
                      disabled={thuId === c.id}
                      onClick={() => chayThu(c.id)}
                      title="Gọi thử combo này — TỐN QUOTA THẬT"
                      className="h-7 px-2 text-xs"
                    >
                      {thuId === c.id ? "Đang gọi…" : "Chạy thử"}
                    </Button>
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
      </>
      )}
    </div>
  )
}
