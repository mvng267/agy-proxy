import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Activity, ArrowDownToLine, Coins, Info, Timer, X } from "lucide-react"
import { api } from "@/lib/api"
import { fmtNum } from "@/lib/format"
import type { ApiKey, UsageResponse } from "@/lib/types"
import { POLL } from "@/lib/queryClient"
import { DataTable, KpiCard, PageHeader, ChartCard, ErrorState, type Column } from "@/components/common"
import { BarSeries } from "@/components/common/charts"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"

/**
 * Báo cáo — lọc được theo API key và combo (yêu cầu #2).
 * Bộ lọc ghi vào URL để chia sẻ được link.
 */

type Range = "7d" | "30d" | "90d"

/** Một dòng log — mỗi bản ghi là MỘT request đã đi qua gateway. */
interface LogRow {
  ts: number
  email: string
  model: string
  promptTokens: number
  completionTokens: number
  ok: number
  ms: number
  apiKeyId?: string | null
  keyName?: string
  combo?: string | null
  endpoint?: string | null
  status?: number | null
  requestId?: string | null
  stream?: number | null
}

interface LogsResponse {
  rows: LogRow[]
  total: number
  limit: number
  offset: number
  facets: {
    endpoints: { value: string; n: number }[]
    statuses: { value: number; n: number }[]
    models: { value: string; n: number }[]
  }
  attributionSince?: number | null
}

interface CompareResponse {
  current: { requests: number; tokIn: number; tokOut: number; accounts: number }
  previous: { requests: number; tokIn: number; tokOut: number; accounts: number }
  changePct: { requests: number; tokIn: number; tokOut: number; accounts: number }
}

/** Đọc/ghi bộ lọc trên URL — link chia sẻ được, F5 giữ nguyên trạng thái. */
function useUrlFilters() {
  const read = () => {
    const q = new URLSearchParams(window.location.search)
    return {
      range: (q.get("range") as Range) || "7d",
      apiKeyId: q.get("apiKeyId") || "",
      combo: q.get("combo") || "",
      // Bộ lọc chi tiết — dữ liệu đã có trong DB từ lâu, chỉ chưa phơi ra.
      email: q.get("email") || "",
      model: q.get("model") || "",
      endpoint: q.get("endpoint") || "",
      status: q.get("status") || "",
      ok: q.get("ok") || "",
      tab: q.get("tab") || "tong-quan",
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
    for (const k of ["apiKeyId", "combo", "email", "model", "endpoint", "status", "ok"] as const) {
      if (next[k]) q.set(k, next[k])
    }
    if (next.tab !== "tong-quan") q.set("tab", next.tab)
    const url = window.location.pathname + (q.toString() ? `?${q}` : "")
    window.history.replaceState(null, "", url)
    setF(next)
  }
  return [f, update] as const
}

/** Mã HTTP → vai trò màu. 429 là hết hạn mức (cảnh báo), không phải lỗi hệ thống. */
function statusTone(s?: number | null): string {
  if (!s) return "text-muted-foreground"
  if (s < 300) return "text-[color:var(--success)]"
  if (s === 429 || s === 402) return "text-[color:var(--warning)]"
  return "text-destructive"
}

export function Reports() {
  const [f, setF] = useUrlFilters()
  const [metric, setMetric] = useState<"requests" | "tokens">("requests")
  const [page, setPage] = useState(0)

  const qs = new URLSearchParams({ range: f.range })
  for (const k of ["apiKeyId", "combo", "email", "model", "endpoint", "status", "ok"] as const) {
    if (f[k]) qs.set(k, f[k])
  }

  const usage = useQuery({
    queryKey: ["usage", qs.toString()],
    queryFn: () => api.get<UsageResponse & { attributionSince?: number | null }>(`/api/gateway/usage?${qs}`),
    refetchInterval: POLL.slow,
  })

  const keys = useQuery({
    queryKey: ["apiKeys"],
    queryFn: () => api.get<{ keys: ApiKey[] }>("/api/gateway/keys"),
  })

  const PAGE = 50
  const logsQs = new URLSearchParams(qs)
  logsQs.set("limit", String(PAGE))
  logsQs.set("offset", String(page * PAGE))

  // Chỉ tải log khi đang mở tab Chi tiết — bảng này quét cả chục nghìn dòng.
  const logs = useQuery({
    queryKey: ["usageLogs", logsQs.toString()],
    queryFn: () => api.get<LogsResponse>(`/api/gateway/usage/logs?${logsQs}`),
    enabled: f.tab === "chi-tiet",
  })

  const compare = useQuery({
    queryKey: ["usageCompare", qs.toString()],
    queryFn: () => api.get<CompareResponse>(`/api/gateway/usage/compare?${qs}`),
    refetchInterval: POLL.slow,
  })

  // Đổi bộ lọc thì về trang đầu — giữ nguyên trang 7 trên tập kết quả mới là bảng rỗng.
  useEffect(() => { setPage(0) }, [qs.toString()])

  const d = usage.data
  const series = d?.series ?? []
  const days = f.range === "90d" ? 90 : f.range === "30d" ? 30 : 7
  const facets = logs.data?.facets

  const logCols: Column<LogRow>[] = [
    {
      key: "ts", header: "Thời gian", sort: (r) => r.ts,
      render: (r) => (
        <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
          {new Date(r.ts).toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </span>
      ),
    },
    {
      key: "status", header: "Mã", align: "right", sort: (r) => r.status ?? 0,
      render: (r) => <span className={`text-xs font-medium tabular-nums ${statusTone(r.status)}`}>{r.status ?? (r.ok ? 200 : "—")}</span>,
    },
    {
      key: "model", header: "Model", sort: (r) => r.model,
      render: (r) => (
        <button onClick={() => setF({ model: r.model, tab: "chi-tiet" })} className="text-xs hover:text-primary hover:underline">
          {r.model}
        </button>
      ),
    },
    {
      key: "email", header: "Account", sort: (r) => r.email,
      render: (r) => (
        <button onClick={() => setF({ email: r.email, tab: "chi-tiet" })} className="text-xs hover:text-primary hover:underline">
          {r.email.split("@")[0]}
        </button>
      ),
    },
    {
      key: "endpoint", header: "Đường vào", sort: (r) => r.endpoint ?? "",
      render: (r) =>
        r.endpoint ? (
          <button onClick={() => setF({ endpoint: r.endpoint!, tab: "chi-tiet" })} className="text-xs text-muted-foreground hover:text-primary hover:underline">
            {r.endpoint}
          </button>
        ) : (
          // Bản ghi trước khi cột này tồn tại (schema v3). Ghi rõ thay vì để trống —
          // dấu gạch trơn dễ bị hiểu là request không có đường vào.
          <span className="text-xs text-muted-foreground/60" title="Request cũ, ghi trước khi hệ thống lưu đường vào">
            chưa ghi
          </span>
        ),
    },
    { key: "tokIn", header: "Vào", align: "right", sort: (r) => r.promptTokens, render: (r) => <span className="text-xs tabular-nums text-muted-foreground">{fmtNum(r.promptTokens)}</span> },
    { key: "tokOut", header: "Ra", align: "right", sort: (r) => r.completionTokens, render: (r) => <span className="text-xs tabular-nums text-muted-foreground">{fmtNum(r.completionTokens)}</span> },
    {
      key: "ms", header: "Thời lượng", align: "right", sort: (r) => r.ms,
      // KHÔNG dùng fmtNum ở đây: nó rút gọn 13740 thành "13.7k", nối thêm "ms" ra
      // "13.7kms" — vô nghĩa. Thời lượng đọc theo giây khi đã quá 1 giây.
      render: (r) => (
        <span className="text-xs tabular-nums text-muted-foreground">
          {r.ms >= 1000 ? `${(r.ms / 1000).toFixed(1)}s` : `${r.ms}ms`}
        </span>
      ),
    },
    {
      key: "meta", header: "Khác",
      render: (r) => (
        <div className="flex items-center gap-1.5">
          {r.stream ? <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">stream</span> : null}
          {r.combo ? <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{r.combo}</span> : null}
          {r.keyName ? <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{r.keyName}</span> : null}
        </div>
      ),
    },
  ]

  const modelCols: Column<{ model: string; requests: number; tokIn: number; tokOut: number }>[] = [
    { key: "model", header: "Model", sort: (r) => r.model, render: (r) => <code className="text-xs">{r.model}</code> },
    { key: "requests", header: "Request", align: "right", sort: (r) => r.requests, render: (r) => <span className="tabular-nums">{fmtNum(r.requests)}</span> },
    { key: "tokIn", header: "Token vào", align: "right", sort: (r) => r.tokIn, render: (r) => <span className="tabular-nums text-muted-foreground">{fmtNum(r.tokIn)}</span> },
    { key: "tokOut", header: "Token ra", align: "right", sort: (r) => r.tokOut, render: (r) => <span className="tabular-nums text-muted-foreground">{fmtNum(r.tokOut)}</span> },
  ]

  if (usage.error) return <ErrorState error={usage.error} onRetry={() => usage.refetch()} />

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
        <Select value={f.range} onValueChange={(v) => setF({ range: (v ?? "7d") as Range })}>
          <SelectTrigger className="h-8 w-28 text-xs">
            {/* SelectValue hiện value thô ("7d"); render nhãn tiếng Việt cho khớp danh sách. */}
            <span>{f.range === "90d" ? "90 ngày" : f.range === "30d" ? "30 ngày" : "7 ngày"}</span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7d" className="text-xs">7 ngày</SelectItem>
            <SelectItem value="30d" className="text-xs">30 ngày</SelectItem>
            <SelectItem value="90d" className="text-xs">90 ngày</SelectItem>
          </SelectContent>
        </Select>

        <Select value={f.apiKeyId} onValueChange={(v) => setF({ apiKeyId: v ?? "" })}>
          <SelectTrigger className="h-8 w-44 text-xs">
            <span className="truncate">
              {!f.apiKeyId ? "Mọi API key"
                : f.apiKeyId === "legacy" ? "Key mặc định"
                : (keys.data?.keys ?? []).find((k) => k.id === f.apiKeyId)?.name ?? "Mọi API key"}
            </span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="" className="text-xs">Mọi API key</SelectItem>
            <SelectItem value="legacy" className="text-xs">Key mặc định</SelectItem>
            {(keys.data?.keys ?? []).map((k) => (
              <SelectItem key={k.id} value={k.id} className="text-xs">{k.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={f.combo} onValueChange={(v) => setF({ combo: v ?? "" })}>
          <SelectTrigger className="h-8 w-44 text-xs">
            <span className="truncate">{f.combo || "Mọi combo"}</span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="" className="text-xs">Mọi combo</SelectItem>
            {(d?.byCombo ?? []).map((c) => (
              <SelectItem key={c.combo} value={c.combo} className="text-xs">{c.combo}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Bộ lọc chi tiết — chỉ liệt kê giá trị CÓ THẬT trong khoảng (facets),
            để không ai lọc theo mã lỗi không tồn tại rồi nhận bảng rỗng. */}
        {f.tab === "chi-tiet" && (
          <>
            <Select value={f.endpoint} onValueChange={(v) => setF({ endpoint: v ?? "" })}>
              <SelectTrigger className="h-8 w-48 text-xs">
                <span className="truncate">{f.endpoint || "Mọi đường vào"}</span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="" className="text-xs">Mọi đường vào</SelectItem>
                {(facets?.endpoints ?? []).map((e) => (
                  <SelectItem key={e.value} value={e.value} className="text-xs">{e.value} ({fmtNum(e.n)})</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={f.status} onValueChange={(v) => setF({ status: v ?? "" })}>
              <SelectTrigger className="h-8 w-36 text-xs">
                <span className="truncate">{f.status ? `Mã ${f.status}` : "Mọi mã"}</span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="" className="text-xs">Mọi mã</SelectItem>
                {(facets?.statuses ?? []).map((s) => (
                  <SelectItem key={s.value} value={String(s.value)} className="text-xs">{s.value} ({fmtNum(s.n)})</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={f.ok} onValueChange={(v) => setF({ ok: v ?? "" })}>
              <SelectTrigger className="h-8 w-32 text-xs">
                <span className="truncate">{f.ok === "true" ? "Thành công" : f.ok === "false" ? "Lỗi" : "Mọi kết quả"}</span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="" className="text-xs">Mọi kết quả</SelectItem>
                <SelectItem value="true" className="text-xs">Thành công</SelectItem>
                <SelectItem value="false" className="text-xs">Lỗi</SelectItem>
              </SelectContent>
            </Select>
          </>
        )}

        {(f.apiKeyId || f.combo || f.email || f.model || f.endpoint || f.status || f.ok) && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setF({ apiKeyId: "", combo: "", email: "", model: "", endpoint: "", status: "", ok: "" })}
            className="h-8"
          >
            Xoá lọc
          </Button>
        )}
      </div>

      {/* Lọc đang bật — hiện thành chip để không ai quên mình đang xem tập con */}
      {(f.email || f.model) && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {f.email && (
            <button onClick={() => setF({ email: "" })} className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 hover:bg-border">
              account: {f.email.split("@")[0]} <X className="h-3 w-3" />
            </button>
          )}
          {f.model && (
            <button onClick={() => setF({ model: "" })} className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 hover:bg-border">
              model: {f.model} <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

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

      {/* Tab tự quản qua useUrlFilters — KHÔNG dùng TabShell vì nó cũng ghi `?tab=`,
          hai bên cùng viết một key sẽ giẫm lên nhau. */}
      <div className="flex gap-1 border-b border-border">
        {([
          { k: "tong-quan", label: "Tổng quan" },
          { k: "chi-tiet", label: "Chi tiết từng request" },
        ] as const).map((t) => (
          <button
            key={t.k}
            onClick={() => setF({ tab: t.k })}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
              f.tab === t.k
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Request" value={fmtNum(d?.totals.requests)} icon={Activity} loading={usage.isLoading}
          delta={compare.data ? { value: Math.abs(compare.data.changePct.requests), dir: compare.data.changePct.requests >= 0 ? "up" : "down" } : undefined}
        />
        <KpiCard label="Trung bình / ngày" value={fmtNum(Math.round((d?.totals.requests ?? 0) / days))} icon={Timer} loading={usage.isLoading} />
        <KpiCard
          label="Token vào" value={fmtNum(d?.totals.tokIn)} icon={Coins} loading={usage.isLoading}
          delta={compare.data ? { value: Math.abs(compare.data.changePct.tokIn), dir: compare.data.changePct.tokIn >= 0 ? "up" : "down" } : undefined}
        />
        <KpiCard
          label="Token ra" value={fmtNum(d?.totals.tokOut)} icon={Coins} loading={usage.isLoading}
          delta={compare.data ? { value: Math.abs(compare.data.changePct.tokOut), dir: compare.data.changePct.tokOut >= 0 ? "up" : "down" } : undefined}
        />
      </div>

      {f.tab === "chi-tiet" ? (
        <ChartCard
          title="Từng request"
          actions={
            <span className="text-xs text-muted-foreground">
              {fmtNum(logs.data?.total)} bản ghi
              {logs.data && logs.data.total > PAGE ? ` · trang ${page + 1}/${Math.ceil(logs.data.total / PAGE)}` : ""}
            </span>
          }
        >
          <DataTable
            rows={logs.data?.rows ?? []}
            columns={logCols}
            rowKey={(r) => `${r.ts}-${r.email}-${r.requestId ?? ""}`}
            loading={logs.isLoading}
            pageSize={PAGE}
            initialSort={{ key: "ts", dir: "desc" }}
          />
          {/* Phân trang phía SERVER: DataTable chỉ phân trang trong tập đã tải về,
              mà tập đó chỉ là 50 dòng của trang hiện tại. */}
          {logs.data && logs.data.total > PAGE && (
            <div className="mt-3 flex items-center justify-center gap-2">
              <Button variant="outline" size="sm" className="h-8" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                Trước
              </Button>
              <span className="text-xs text-muted-foreground">
                {page * PAGE + 1}–{Math.min((page + 1) * PAGE, logs.data.total)} / {fmtNum(logs.data.total)}
              </span>
              <Button
                variant="outline" size="sm" className="h-8"
                disabled={(page + 1) * PAGE >= logs.data.total}
                onClick={() => setPage((p) => p + 1)}
              >
                Sau
              </Button>
            </div>
          )}
        </ChartCard>
      ) : (
      <>
      {/* ── Tổng quan ─────────────────────────────────────────────── */}

      <ChartCard
        title="Lưu lượng theo ngày"
        actions={
          <div className="flex gap-1">
            {(["requests", "tokens"] as const).map((m) => (
              <Button
                key={m}
                size="sm"
                variant={metric === m ? "default" : "outline"}
                onClick={() => setMetric(m)}
                className="h-8 text-xs"
              >
                {m === "requests" ? "Request" : "Token"}
              </Button>
            ))}
          </div>
        }
      >
        {series.length ? (
          <BarSeries
            data={series.map((x) => ({
              bucket: x.bucket.slice(5),
              value: metric === "requests" ? x.requests : x.tokIn + x.tokOut,
            }))}
            xKey="bucket"
            height={200}
            series={[{ key: "value", label: metric === "requests" ? "Requests" : "Tokens" }]}
          />
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
      </>
      )}
    </div>
  )
}
