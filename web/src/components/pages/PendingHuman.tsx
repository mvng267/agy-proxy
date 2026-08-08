import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Check, CheckCircle2, Clock, Loader2, UserCheck, X } from "lucide-react"
import { api } from "@/lib/api"
import { fmtAgo } from "@/lib/format"
import { POLL } from "@/lib/queryClient"
import { KpiCard, PageHeader, ErrorState } from "@/components/common"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/toast"

/**
 * Chờ duyệt — các run đang pause vì gặp challenge/captcha cần người xử lý tay.
 * Approve = đã xử lý xong trên cửa sổ browser, cho flow chạy tiếp.
 * Reject = bỏ qua, run chuyển failed (needs_human).
 */

interface PendingRun {
  runId: number
  reason: string
  since: number
}

interface RunRow {
  id: number
  email: string
  flow: string
  status: string
  error: string | null
  started_at: string
  finished_at: string | null
}

export function PendingHuman() {
  const qc = useQueryClient()
  const toast = useToast()

  const pending = useQuery({
    queryKey: ["pending-human"],
    queryFn: () => api.get<{ pending: PendingRun[] }>("/api/pending-human"),
    refetchInterval: POLL.live,
  })

  // Ghép email/flow từ danh sách run gần nhất — /api/pending-human chỉ trả runId + lý do.
  const runs = useQuery({
    queryKey: ["runs"],
    queryFn: () => api.get<{ runs: RunRow[] }>("/api/runs"),
    refetchInterval: POLL.live,
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["pending-human"] })
    qc.invalidateQueries({ queryKey: ["runs"] })
  }

  const approve = useMutation({
    mutationFn: (runId: number) => api.post<{ ok: boolean }>(`/api/runs/${runId}/continue`),
    onSuccess: (r, runId) => {
      if (r.ok) toast({ title: `Run #${runId} tiếp tục`, description: "Flow đang chạy tiếp", variant: "success" })
      else toast({ title: "Không duyệt được", description: "Run không còn chờ nữa", variant: "warning" })
      invalidate()
    },
    onError: (e) => toast({ title: "Lỗi", description: e.message, variant: "error" }),
  })

  const reject = useMutation({
    mutationFn: (runId: number) => api.post<{ ok: boolean }>(`/api/runs/${runId}/skip`),
    onSuccess: (r, runId) => {
      if (r.ok) toast({ title: `Run #${runId} đã bỏ qua`, variant: "info" })
      else toast({ title: "Không bỏ qua được", description: "Run không còn chờ nữa", variant: "warning" })
      invalidate()
    },
    onError: (e) => toast({ title: "Lỗi", description: e.message, variant: "error" }),
  })

  if (pending.isError) return <ErrorState error={pending.error} onRetry={() => pending.refetch()} />

  const items = pending.data?.pending ?? []
  const runById = new Map((runs.data?.runs ?? []).map((r) => [r.id, r]))
  const oldest = items.length ? Math.min(...items.map((p) => p.since)) : null

  return (
    <div>
      <PageHeader
        title="Chờ duyệt"
        desc="Run đang pause vì challenge/captcha — xử lý trên cửa sổ browser rồi bấm Duyệt"
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <KpiCard
          label="Đang chờ"
          value={items.length}
          sub={items.length ? "cần xử lý tay" : "không có gì cần duyệt"}
          icon={UserCheck}
          tone={items.length ? "warning" : "success"}
          loading={pending.isPending}
        />
        <KpiCard
          label="Chờ lâu nhất"
          value={fmtAgo(oldest)}
          sub="run sẽ timeout nếu chờ quá lâu"
          icon={Clock}
          loading={pending.isPending}
        />
      </div>

      {items.length === 0 && !pending.isPending ? (
        <div className="mt-10 flex flex-col items-center justify-center gap-2 py-10 text-muted-foreground">
          <CheckCircle2 className="h-10 w-10 text-[color:var(--success)] opacity-70" />
          <p className="text-sm">Không có task nào chờ duyệt</p>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {items.map((p) => {
            const run = runById.get(p.runId)
            const busy =
              (approve.isPending && approve.variables === p.runId) ||
              (reject.isPending && reject.variables === p.runId)
            return (
              <Card key={p.runId} className="bg-card border-border">
                <CardContent className="flex flex-wrap items-center gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground">Run #{p.runId}</span>
                      {run && (
                        <>
                          <span className="text-sm text-muted-foreground">{run.email}</span>
                          <code className="rounded bg-background px-1.5 py-0.5 text-xs">{run.flow}</code>
                        </>
                      )}
                      <span className="text-xs text-muted-foreground">· chờ {fmtAgo(p.since)}</span>
                    </div>
                    <p className="mt-1 text-sm text-[color:var(--warning)]">{p.reason}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => approve.mutate(p.runId)}
                      disabled={busy}
                      className="h-8 gap-1.5 text-xs"
                    >
                      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                      Duyệt — chạy tiếp
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => reject.mutate(p.runId)}
                      disabled={busy}
                      className="h-8 gap-1.5 text-xs"
                    >
                      <X className="h-3.5 w-3.5" />
                      Bỏ qua
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
