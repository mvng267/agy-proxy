import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Activity, ArrowDownToLine, Coins, Info, Timer } from "lucide-react"
import { api } from "@/lib/api"
import { fmtNum } from "@/lib/format"
import type { ApiKey, UsageResponse } from "@/lib/types"
import { POLL } from "@/lib/queryClient"
import { DataTable, KpiCard, PageHeader, ChartCard, ErrorState, type Column } from "@/components/common"

/**
 * Báo cáo — lọc được theo API key và combo (yêu cầu #2).
 * Bộ lọc ghi vào URL để chia sẻ được link.
 */

type Range = "7d" | "30d" | "90d"

/** Đọc/ghi bộ lọc trên URL — link chia sẻ được, F5 giữ nguyên trạng thái. */
function useUrlFilters() {
  const read = () => {
    const q = new URLSearchParams(window.location.search)
    return {
      range: (q.get("range") as Range) || "7d",
      apiKeyId: q.get("apiKeyId") || "",
      combo: q.get("combo") || "",
    }
  }
  const [f, setF] = useState(read)

  useEffect(() => {
    const onPop = () => setF(read())
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

  const update = (patch: Partial<typeof f>) => {
    const next = { ...f, ...patch }
    const q = new URLSearchParams()
    if (next.range !== "7d") q.set("range", next.range)
    if (next.apiKeyId) q.set("apiKeyId", next.apiKeyId)
    if (next.combo) q.set("combo", next.combo)
    const url = window.location.pathname + (q.toString() ? `?${q}` : "")
    window.history.replaceState(null, "", url)
    setF(next)
  }
  return [f, update] as const
}

export function Reports() {
  const [f, setF] = useUrlFilters()
  const [metric, setMetric] = useState<"requests" | "tokens">("requests")

  const qs = new URLSearchParams({ range: f.range })
  if (f.apiKeyId) qs.set("apiKeyId", f.apiKeyId)
  if (f.combo) qs.set("combo", f.combo)

  const usage = useQuery({
    queryKey: ["usage", f.range, f.apiKeyId, f.combo],
    queryFn: () => api.get<UsageResponse & { attributionSince?: number | null }>(`/api/gateway/usage?${qs}`),
    refetchInterval: POLL.slow,
  })

  const keys = useQuery({
    queryKey: ["apiKeys"],
    queryFn: () => api.get<{ keys: ApiKey[] }>("/api/gateway/keys"),
  })

  const d = usage.data
  const series = d?.series ?? []
  const max = Math.max(1, ...series.map((s) => (metric === "requests" ? s.requests : s.tokIn + s.tokOut)))
  const days = f.range === "90d" ? 90 : f.range === "30d" ? 30 : 7

  const modelCols: Column<{ model: string; requests: number; tokIn: number; tokOut: number }>[] = [
    { key: "model", header: "Model", sort: (r) => r.model, render: (r) => <code className="text-xs">{r.model}</code> },
    { key: "requests", header: "Request", align: "right", sort: (r) => r.requests, render: (r) => <span className="tabular-nums">{fmtNum(r.requests)}</span> },
    { key: "tokIn", header: "Token vào", align: "right", sort: (r) => r.tokIn, render: (r) => <span className="tabular-nums text-muted-foreground">{fmtNum(r.tokIn)}</span> },
    { key: "tokOut", header: "Token ra", align: "right", sort: (r) => r.tokOut, render: (r) => <span className="tabular-nums text-muted-foreground">{fmtNum(r.tokOut)}</span> },
  ]

  if (usage.error) return <ErrorState error={usage.error} onRetry={() => usage.refetch()} />

  const sel = "h-8 rounded-md border border-border bg-background px-2 text-sm"

  return (
    <div className="space-y-4">
      <PageHeader
        title="Báo cáo"
        desc="Đã tiêu bao nhiêu, ai tiêu, tiêu vào đâu."
        actions={
          <a
            href={`/api/gateway/usage/export.csv?${qs}`}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-sm hover:bg-card"
          >
            <ArrowDownToLine className="h-3.5 w-3.5" />
            Xuất CSV
          </a>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <select value={f.range} onChange={(e) => setF({ range: e.target.value as Range })} className={sel}>
          <option value="7d">7 ngày</option>
          <option value="30d">30 ngày</option>
          <option value="90d">90 ngày</option>
        </select>

        <select value={f.apiKeyId} onChange={(e) => setF({ apiKeyId: e.target.value })} className={sel}>
          <option value="">Mọi API key</option>
          <option value="legacy">Key mặc định</option>
          {(keys.data?.keys ?? []).map((k) => (
            <option key={k.id} value={k.id}>{k.name}</option>
          ))}
        </select>

        <select value={f.combo} onChange={(e) => setF({ combo: e.target.value })} className={sel}>
          <option value="">Mọi combo</option>
          {(d?.byCombo ?? []).map((c) => (
            <option key={c.combo} value={c.combo}>{c.combo}</option>
          ))}
        </select>

        {(f.apiKeyId || f.combo) && (
          <button onClick={() => setF({ apiKeyId: "", combo: "" })} className="h-8 rounded-md border border-border px-2 text-sm hover:bg-card">
            Xoá lọc
          </button>
        )}
      </div>

      {/* Dữ liệu cũ không có api_key_id/combo — nói rõ để không bị hiểu là báo cáo hỏng. */}
      {d?.attributionSince ? (
        <div className="flex items-start gap-2 rounded-md border border-border bg-card/60 p-2.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Thông tin API key và combo chỉ có từ {new Date(d.attributionSince).toLocaleString("vi-VN")}. Request cũ hơn
            hiển thị là "(không key)".
          </span>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Request" value={fmtNum(d?.totals.requests)} icon={Activity} loading={usage.isLoading} />
        <KpiCard label="Trung bình / ngày" value={fmtNum(Math.round((d?.totals.requests ?? 0) / days))} icon={Timer} loading={usage.isLoading} />
        <KpiCard label="Token vào" value={fmtNum(d?.totals.tokIn)} icon={Coins} loading={usage.isLoading} />
        <KpiCard label="Token ra" value={fmtNum(d?.totals.tokOut)} icon={Coins} loading={usage.isLoading} />
      </div>

      <ChartCard
        title="Lưu lượng theo ngày"
        actions={
          <div className="flex gap-1">
            {(["requests", "tokens"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMetric(m)}
                className={`h-7 rounded-md px-2 text-xs ${metric === m ? "bg-primary text-white" : "border border-border hover:bg-background"}`}
              >
                {m === "requests" ? "Request" : "Token"}
              </button>
            ))}
          </div>
        }
      >
        {series.length ? (
          <div className="flex h-40 items-end gap-1">
            {series.map((s) => {
              const v = metric === "requests" ? s.requests : s.tokIn + s.tokOut
              return (
                <div key={s.bucket} className="group relative flex-1" title={`${s.bucket}: ${fmtNum(v)}`}>
                  <div className="w-full rounded-t bg-primary/70 transition-all group-hover:bg-primary" style={{ height: `${Math.max(2, (v / max) * 150)}px` }} />
                </div>
              )
            })}
          </div>
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">Chưa có dữ liệu trong khoảng này</p>
        )}
      </ChartCard>

      <div className="grid gap-3 lg:grid-cols-2">
        <ChartCard title="Theo API key">
          <div className="space-y-1.5">
            {(d?.byApiKey ?? []).slice(0, 8).map((r) => {
              const top = Math.max(1, ...(d?.byApiKey ?? []).map((x) => x.requests))
              return (
                <button
                  key={r.apiKeyId || "none"}
                  onClick={() => setF({ apiKeyId: r.apiKeyId })}
                  className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-background"
                >
                  <span className="w-36 shrink-0 truncate text-xs">{(r as any).name ?? r.apiKeyId}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-background">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${(r.requests / top) * 100}%` }} />
                  </div>
                  <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{fmtNum(r.requests)}</span>
                </button>
              )
            })}
            {!(d?.byApiKey ?? []).length && <p className="py-4 text-center text-sm text-muted-foreground">Chưa có dữ liệu</p>}
          </div>
        </ChartCard>

        <ChartCard title="Theo combo">
          <div className="space-y-1.5">
            {(d?.byCombo ?? []).slice(0, 8).map((r) => {
              const top = Math.max(1, ...(d?.byCombo ?? []).map((x) => x.requests))
              return (
                <button
                  key={r.combo}
                  onClick={() => setF({ combo: r.combo })}
                  className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-background"
                >
                  <span className="w-36 shrink-0 truncate text-xs">{r.combo}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-background">
                    <div className="h-full rounded-full bg-[color:var(--success)]" style={{ width: `${(r.requests / top) * 100}%` }} />
                  </div>
                  <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{fmtNum(r.requests)}</span>
                </button>
              )
            })}
            {!(d?.byCombo ?? []).length && (
              <p className="py-4 text-center text-sm text-muted-foreground">Chưa có request nào qua combo</p>
            )}
          </div>
        </ChartCard>
      </div>

      <ChartCard title="Chi tiết theo model">
        <DataTable
          rows={d?.byModel ?? []}
          columns={modelCols}
          rowKey={(r) => r.model}
          loading={usage.isLoading}
          pageSize={15}
          initialSort={{ key: "requests", dir: "desc" }}
        />
      </ChartCard>
    </div>
  )
}
