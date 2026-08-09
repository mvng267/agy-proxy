import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { History, Image as ImageIcon, ListChecks, X, XCircle } from "lucide-react"
import { api } from "@/lib/api"
import { POLL } from "@/lib/queryClient"
import { DataTable, KpiCard, PageHeader, StatusBadge, ErrorState, type Column } from "@/components/common"
import { Card, CardContent } from "@/components/ui/card"

/**
 * Runs — lịch sử 80 lần chạy pipeline gần nhất. Click một dòng để xem log chi tiết
 * (kèm screenshot nếu flow có chụp).
 */

interface RunRow {
  id: number
  email: string
  flow: string
  status: string
  error: string | null
  started_at: string
  finished_at: string | null
}

interface LogRow {
  id: number
  run_id: number
  ts: string
  level: string
  msg: string
  screenshot: string | null
}

const STATUS_LABEL: Record<string, { badge: string; label: string }> = {
  ok: { badge: "ok", label: "OK" },
  failed: { badge: "error", label: "Failed" },
  running: { badge: "busy", label: "Đang chạy" },
  paused_needs_human: { badge: "cooldown", label: "Chờ duyệt" },
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—"
  return new Date(iso).toLocaleString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

function fmtDuration(r: RunRow): string {
  if (!r.finished_at) return "—"
  const ms = Date.parse(r.finished_at) - Date.parse(r.started_at)
  if (!Number.isFinite(ms) || ms < 0) return "—"
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

const LEVEL_CLS: Record<string, string> = {
  error: "text-destructive",
  warn: "text-[color:var(--warning)]",
  challenge: "text-[color:var(--warning)]",
  info: "text-muted-foreground",
}

export function Runs() {
  const [selected, setSelected] = useState<RunRow | null>(null)

  const runs = useQuery({
    queryKey: ["runs"],
    queryFn: () => api.get<{ runs: RunRow[] }>("/api/runs"),
    refetchInterval: POLL.live,
  })

  const logs = useQuery({
    queryKey: ["run-logs", selected?.id],
    queryFn: () => api.get<{ logs: LogRow[] }>(`/api/runs/${selected!.id}/logs`),
    enabled: selected != null,
  })

  if (runs.isError) return <ErrorState error={runs.error} onRetry={() => runs.refetch()} />

  const rows = runs.data?.runs ?? []
  const okCount = rows.filter((r) => r.status === "ok").length
  const failCount = rows.filter((r) => r.status === "failed").length

  const columns: Column<RunRow>[] = [
    {
      key: "id",
      header: "#",
      sort: (r) => r.id,
      render: (r) => <span className="tabular-nums text-muted-foreground">{r.id}</span>,
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
      key: "status",
      header: "Trạng thái",
      sort: (r) => r.status,
      render: (r) => {
        const m = STATUS_LABEL[r.status] ?? { badge: "unknown", label: r.status }
        return <StatusBadge status={m.badge} label={m.label} />
      },
    },
    {
      key: "error",
      header: "Lỗi",
      render: (r) =>
        r.error ? (
          <span className="block max-w-56 truncate text-xs text-destructive" title={r.error}>
            {r.error}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "started",
      header: "Bắt đầu",
      align: "right",
      sort: (r) => r.started_at,
      render: (r) => <span className="text-xs text-muted-foreground tabular-nums">{fmtTime(r.started_at)}</span>,
    },
    {
      key: "duration",
      header: "Thời lượng",
      align: "right",
      render: (r) => <span className="text-xs text-muted-foreground tabular-nums">{fmtDuration(r)}</span>,
    },
  ]

  return (
    <div>
      <PageHeader title="Runs" desc="Lịch sử 80 lần chạy flow gần nhất — click một dòng để xem log" />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <KpiCard label="Tổng run" value={rows.length} icon={History} loading={runs.isPending} />
        <KpiCard
          label="Thành công"
          value={okCount}
          icon={ListChecks}
          tone="success"
          loading={runs.isPending}
        />
        <KpiCard
          label="Thất bại"
          value={failCount}
          icon={XCircle}
          tone={failCount ? "danger" : "default"}
          loading={runs.isPending}
        />
      </div>

      <div className={`mt-4 grid gap-4 ${selected ? "xl:grid-cols-2" : ""}`}>
        <Card>
          <CardContent className="p-4">
            <DataTable
              rows={rows}
              columns={columns}
              rowKey={(r) => String(r.id)}
              loading={runs.isPending}
              empty="Chưa có run nào — chạy flow từ trang Tài khoản hoặc Scheduler"
              initialSort={{ key: "id", dir: "desc" }}
              pageSize={20}
              onRowClick={(r) => setSelected(r)}
            />
          </CardContent>
        </Card>

        {selected && (
          <Card className="self-start">
            <CardContent className="p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium text-foreground">
                  Log run #{selected.id} — {selected.email} ·{" "}
                  <code className="rounded bg-background px-1.5 py-0.5 text-xs">{selected.flow}</code>
                </h3>
                <button
                  onClick={() => setSelected(null)}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-background hover:text-foreground"
                  title="Đóng"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="max-h-[32rem] overflow-y-auto">
                {logs.isPending ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">Đang tải log…</p>
                ) : (logs.data?.logs ?? []).length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">Run này không có log</p>
                ) : (
                  <ol className="space-y-1.5 font-mono text-xs">
                    {(logs.data?.logs ?? []).map((l) => (
                      <li key={l.id} className="flex items-start gap-2">
                        <span className="shrink-0 tabular-nums text-muted-foreground/60">
                          {new Date(l.ts).toLocaleTimeString("vi-VN")}
                        </span>
                        <span className={`shrink-0 uppercase ${LEVEL_CLS[l.level] ?? "text-muted-foreground"}`}>
                          {l.level}
                        </span>
                        <span className="min-w-0 break-words text-foreground/90">
                          {l.msg}
                          {l.screenshot && (
                            <a
                              href={l.screenshot}
                              target="_blank"
                              rel="noreferrer"
                              className="ml-2 inline-flex items-center gap-1 text-primary hover:underline"
                            >
                              <ImageIcon className="h-3 w-3" />
                              ảnh
                            </a>
                          )}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
