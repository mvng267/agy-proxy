import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { KeyRound, Plus, Copy, Check, Trash2, BarChart3, Power } from "lucide-react"
import { api } from "@/lib/api"
import { fmtAgo } from "@/lib/format"
import type { ApiKey } from "@/lib/types"
import { POLL } from "@/lib/queryClient"
import { DataTable, KpiCard, PageHeader, StatusBadge, ConfirmDialog, ErrorState, type Column } from "@/components/common"
import { Card, CardContent } from "@/components/ui/card"

/**
 * Quản lý API key — mỗi key cho một user, chỉ để định danh trong báo cáo.
 * Key thô CHỈ hiện đúng một lần lúc tạo; server lưu sha256 nên không lấy lại được.
 */
export function ApiKeys() {
  const qc = useQueryClient()
  const [newKey, setNewKey] = useState<{ name: string; key: string } | null>(null)
  const [revoke, setRevoke] = useState<ApiKey | null>(null)
  const [copied, setCopied] = useState(false)
  const [form, setForm] = useState({ name: "", note: "" })
  const [showForm, setShowForm] = useState(false)

  const keys = useQuery({
    queryKey: ["apiKeys"],
    queryFn: () => api.get<{ keys: ApiKey[] }>("/api/gateway/keys"),
    refetchInterval: POLL.normal,
  })

  const usage = useQuery({
    queryKey: ["usage", "30d", "byKey"],
    queryFn: () => api.get<{ byApiKey?: Array<{ apiKeyId: string; requests: number }> }>("/api/gateway/usage?range=30d"),
    refetchInterval: POLL.slow,
  })

  const reqByKey = new Map((usage.data?.byApiKey ?? []).map((r) => [r.apiKeyId, r.requests]))

  const create = useMutation({
    mutationFn: (b: { name: string; note?: string }) =>
      api.post<{ id: string; name: string; key: string }>("/api/gateway/keys", b),
    onSuccess: (r) => {
      setNewKey({ name: r.name, key: r.key })
      setShowForm(false)
      setForm({ name: "", note: "" })
      qc.invalidateQueries({ queryKey: ["apiKeys"] })
    },
  })

  const toggle = useMutation({
    mutationFn: (k: ApiKey) => api.patch(`/api/gateway/keys/${k.id}`, { enabled: !k.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["apiKeys"] }),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/gateway/keys/${id}`),
    onSuccess: () => {
      setRevoke(null)
      qc.invalidateQueries({ queryKey: ["apiKeys"] })
    },
  })

  const rows = keys.data?.keys ?? []
  const active = rows.filter((k) => k.enabled).length

  const columns: Column<ApiKey>[] = [
    {
      key: "name",
      header: "Tên",
      sort: (r) => r.name.toLowerCase(),
      render: (r) => (
        <div>
          <div className="font-medium text-foreground">{r.name}</div>
          {r.note ? <div className="text-xs text-muted-foreground">{r.note}</div> : null}
        </div>
      ),
    },
    {
      key: "prefix",
      header: "Prefix",
      render: (r) => <code className="rounded bg-background px-1.5 py-0.5 text-xs">{r.prefix}…</code>,
    },
    {
      key: "requests",
      header: "Request 30 ngày",
      align: "right",
      sort: (r) => reqByKey.get(r.id) ?? 0,
      render: (r) => <span className="tabular-nums">{reqByKey.get(r.id) ?? 0}</span>,
    },
    {
      key: "lastUsed",
      header: "Dùng cuối",
      align: "right",
      sort: (r) => r.lastUsed ?? 0,
      render: (r) => <span className="text-muted-foreground">{fmtAgo(r.lastUsed)}</span>,
    },
    {
      key: "createdAt",
      header: "Tạo lúc",
      align: "right",
      sort: (r) => r.createdAt,
      render: (r) => <span className="text-muted-foreground">{fmtAgo(r.createdAt)}</span>,
    },
    {
      key: "status",
      header: "Trạng thái",
      sort: (r) => (r.enabled ? 1 : 0),
      render: (r) => <StatusBadge status={r.enabled ? "ok" : "off"} label={r.enabled ? "Hoạt động" : "Đã tắt"} />,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (r) => (
        <div className="flex items-center justify-end gap-1">
          <button
            onClick={() => toggle.mutate(r)}
            title={r.enabled ? "Tắt key" : "Bật key"}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-background hover:text-foreground"
          >
            <Power className="h-3.5 w-3.5" />
          </button>
          <a
            href={`/usage?apiKeyId=${encodeURIComponent(r.id)}`}
            title="Xem báo cáo của key này"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-background hover:text-foreground"
          >
            <BarChart3 className="h-3.5 w-3.5" />
          </a>
          <button
            onClick={() => setRevoke(r)}
            title="Thu hồi"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ),
    },
  ]

  if (keys.error) return <ErrorState error={keys.error} onRetry={() => keys.refetch()} />

  return (
    <div className="space-y-4">
      <PageHeader
        title="API Keys"
        desc="Mỗi key dành cho một người dùng. Dùng để lọc báo cáo — mọi key dùng chung model và pool."
        actions={
          <button
            onClick={() => setShowForm((v) => !v)}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-white hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" />
            Tạo key mới
          </button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <KpiCard label="Tổng số key" value={rows.length} icon={KeyRound} loading={keys.isLoading} />
        <KpiCard label="Đang hoạt động" value={active} tone="success" loading={keys.isLoading} />
        <KpiCard label="Đã tắt" value={rows.length - active} tone={rows.length - active ? "warning" : "default"} loading={keys.isLoading} />
      </div>

      {showForm && (
        <Card className="bg-card border-border">
          <CardContent className="flex flex-wrap items-end gap-3 p-4">
            <div className="min-w-48 flex-1">
              <label className="text-xs text-muted-foreground">Tên (thường là tên người dùng)</label>
              <input
                autoFocus
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="vd: Hermes của Minh"
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
              />
            </div>
            <div className="min-w-48 flex-1">
              <label className="text-xs text-muted-foreground">Ghi chú (tuỳ chọn)</label>
              <input
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
              />
            </div>
            <button
              onClick={() => create.mutate({ name: form.name.trim(), note: form.note.trim() || undefined })}
              disabled={!form.name.trim() || create.isPending}
              className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-white disabled:opacity-40 hover:opacity-90"
            >
              Tạo
            </button>
            {create.error ? <p className="w-full text-sm text-destructive">{String((create.error as Error).message)}</p> : null}
          </CardContent>
        </Card>
      )}

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        loading={keys.isLoading}
        initialSort={{ key: "createdAt", dir: "desc" }}
        empty="Chưa có key nào. Client vẫn dùng được key mặc định trong .env."
      />

      {/* Key thô chỉ hiện MỘT LẦN — server lưu sha256, không lấy lại được. */}
      {newKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-lg rounded-lg border border-border bg-card p-5 shadow-xl">
            <h3 className="text-base font-semibold text-foreground">Đã tạo key "{newKey.name}"</h3>
            <div className="mt-3 flex items-center gap-2 rounded-md border border-border bg-background p-2">
              <code className="flex-1 break-all font-mono text-xs text-foreground">{newKey.key}</code>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(newKey.key)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                }}
                className="shrink-0 rounded-md border border-border p-1.5 hover:bg-card"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-[color:var(--success)]" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
            <p className="mt-2 text-sm text-[color:var(--warning)]">
              Key chỉ hiện lần này. Lưu lại ngay — hệ thống chỉ giữ bản băm, không khôi phục được.
            </p>
            <div className="mt-4 flex justify-end">
              <button
                onClick={() => setNewKey(null)}
                className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-white hover:opacity-90"
              >
                Đã lưu
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!revoke}
        title={`Thu hồi key "${revoke?.name}"?`}
        desc="Client dùng key này sẽ bị từ chối ngay lập tức. Dữ liệu báo cáo cũ vẫn được giữ."
        confirmText={revoke?.name}
        busy={remove.isPending}
        onCancel={() => setRevoke(null)}
        onConfirm={() => revoke && remove.mutate(revoke.id)}
      />
    </div>
  )
}
