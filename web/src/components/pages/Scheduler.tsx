import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { CalendarClock, ListTodo, LogIn, Play, Square, Timer } from "lucide-react"
import { api } from "@/lib/api"
import { POLL } from "@/lib/queryClient"
import { DataTable, KpiCard, PageHeader, StatusBadge, ErrorState, type Column } from "@/components/common"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/toast"

/**
 * Scheduler — hàng đợi flow tuần tự (1 browser một thời điểm).
 * Xem job đang chạy / đang chờ, tiến độ đợt hiện tại, và dừng toàn bộ hàng đợi.
 */

interface SchedJob {
  email: string
  flow: string
  noProxy?: boolean
}

interface SchedStatus {
  running: boolean
  current: SchedJob | null
  queued: number
  queue: SchedJob[]
  loginsLast24h: number
  dailyCap: number
  batchTotal: number
  done: number
  etaSec: number
}

function fmtEta(sec: number): string {
  if (!sec) return "—"
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m}m ${sec % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function Scheduler() {
  const qc = useQueryClient()
  const toast = useToast()

  const sched = useQuery({
    queryKey: ["scheduler"],
    queryFn: () => api.get<SchedStatus>("/api/scheduler"),
    refetchInterval: POLL.live,
  })

  const stop = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>("/api/stop"),
    onSuccess: () => {
      toast({ title: "Đã dừng", description: "Hàng đợi đã được xoá", variant: "success" })
      qc.invalidateQueries({ queryKey: ["scheduler"] })
    },
    onError: (e) => toast({ title: "Lỗi", description: e.message, variant: "error" }),
  })

  const autoRun = useMutation({
    mutationFn: () => api.post<{ queued: number }>("/api/auto-run", {}),
    onSuccess: (r) => {
      toast({ title: "Auto Run", description: `Đã xếp ${r.queued} job vào hàng đợi`, variant: "success" })
      qc.invalidateQueries({ queryKey: ["scheduler"] })
    },
    onError: (e) => toast({ title: "Lỗi", description: e.message, variant: "error" }),
  })

  if (sched.isError) return <ErrorState error={sched.error} onRetry={() => sched.refetch()} />

  const s = sched.data
  // Job đang chạy đứng đầu danh sách để nhìn một mạch "đang chạy → sắp chạy".
  const rows = [
    ...(s?.current ? [{ ...s.current, i: -1, active: true }] : []),
    ...(s?.queue ?? []).map((j, i) => ({ ...j, i, active: false })),
  ]

  const columns: Column<(typeof rows)[number]>[] = [
    {
      key: "pos",
      header: "#",
      render: (r) => (
        <span className="tabular-nums text-muted-foreground">{r.active ? "▶" : r.i + 1}</span>
      ),
    },
    {
      key: "email",
      header: "Email",
      sort: (r) => r.email,
      render: (r) => <span className="font-medium text-foreground">{r.email}</span>,
    },
    {
      key: "flow",
      header: "Flow",
      sort: (r) => r.flow,
      render: (r) => <code className="rounded bg-background px-1.5 py-0.5 text-xs">{r.flow}</code>,
    },
    {
      key: "proxy",
      header: "Proxy",
      render: (r) => (
        <span className="text-xs text-muted-foreground">{r.noProxy ? "trực tiếp" : "theo account"}</span>
      ),
    },
    {
      key: "status",
      header: "Trạng thái",
      render: (r) =>
        r.active ? <StatusBadge status="busy" label="đang chạy" /> : <StatusBadge status="off" label="chờ" />,
    },
  ]

  const pct = s && s.batchTotal > 0 ? Math.round((s.done / s.batchTotal) * 100) : 0

  return (
    <div>
      <PageHeader
        title="Scheduler"
        desc="Hàng đợi flow tuần tự — mỗi thời điểm chỉ 1 browser chạy"
        actions={
          <>
            <Button
              size="sm"
              onClick={() => autoRun.mutate()}
              disabled={autoRun.isPending}
              className="h-8 gap-1.5 text-xs"
            >
              <Play className="h-3.5 w-3.5" />
              Auto Run
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => stop.mutate()}
              disabled={stop.isPending || (!s?.running && !s?.queued)}
              className="h-8 gap-1.5 text-xs"
            >
              <Square className="h-3.5 w-3.5" />
              Dừng hàng đợi
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label="Trạng thái"
          value={s?.running ? "Đang chạy" : "Rảnh"}
          sub={s?.current ? `${s.current.email} · ${s.current.flow}` : "không có job nào"}
          icon={CalendarClock}
          tone={s?.running ? "success" : "default"}
          loading={sched.isPending}
        />
        <KpiCard
          label="Hàng đợi"
          value={s?.queued ?? "—"}
          sub={s?.batchTotal ? `đợt hiện tại: ${s.done}/${s.batchTotal}` : undefined}
          icon={ListTodo}
          loading={sched.isPending}
        />
        <KpiCard
          label="ETA còn lại"
          value={fmtEta(s?.etaSec ?? 0)}
          sub="ước tính từ 20 job gần nhất"
          icon={Timer}
          loading={sched.isPending}
        />
        <KpiCard
          label="Login 24h"
          value={s ? `${s.loginsLast24h}/${s.dailyCap}` : "—"}
          sub="cap login mỗi IP mỗi ngày"
          icon={LogIn}
          tone={s && s.loginsLast24h >= s.dailyCap ? "warning" : "default"}
          loading={sched.isPending}
        />
      </div>

      {s && s.batchTotal > 0 && (
        <Card className="mt-4">
          <CardContent className="p-4">
            <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
              <span>Tiến độ đợt hiện tại</span>
              <span className="tabular-nums">
                {s.done}/{s.batchTotal} ({pct}%)
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-background">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="mt-4">
        <CardContent className="p-4">
          <h3 className="mb-3 text-sm font-medium text-foreground">
            Job trong hàng đợi {s && s.queued > s.queue.length ? `(hiện 50/${s.queued})` : ""}
          </h3>
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(r) => `${r.i}:${r.email}:${r.flow}`}
            loading={sched.isPending}
            empty="Hàng đợi trống — bấm Auto Run để xếp các flow còn thiếu"
          />
        </CardContent>
      </Card>
    </div>
  )
}
