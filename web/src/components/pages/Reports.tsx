import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Activity, ArrowDownToLine, Coins, Info, Timer, X } from "lucide-react"
import { api } from "@/lib/api"
import { fmtNum } from "@/lib/format"
import type { ApiKey, UsageResponse, UsageAgg } from "@/lib/types"
import { POLL } from "@/lib/queryClient"
import { DataTable, KpiCard, PageHeader, ChartCard, ErrorState, type Column } from "@/components/common"
import { BarSeries } from "@/components/common/charts"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"

/**
 * Báo cáo — lọc được theo API key và combo (yêu cầu #2).
 * Bộ lọc ghi vào URL để chia sẻ được link.
 */

/**
 * `custom` = dùng from/to tự chọn. Backend `rangeOf()` đã đọc `q.from`/`q.to` từ lâu
 * (admin.ts) — chỉ thiếu widget, nên thêm ở đây không đụng gì phía server.
 */
type Range = "1d" | "7d" | "30d" | "90d" | "custom"

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
  /** Thông điệp lỗi nguyên văn từ upstream — chỉ có khi ok=0. */
  err?: string | null
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

/** Lỗi đã gom theo thông điệp (số biến thiên thay bằng `N` để gom được). */
interface NhomLoi {
  err: string
  n: number
  /** Một bản NGUYÊN VĂN — chuẩn hoá làm mất chi tiết (reset lúc nào, retry bao lâu). */
  viDu: string
  models: string[]
  statuses: number[]
  lanDau: number
  lanCuoi: number
}
interface ErrorsResponse {
  nhom: NhomLoi[]
  tong: number
}

/** Đọc/ghi bộ lọc trên URL — link chia sẻ được, F5 giữ nguyên trạng thái. */
function useUrlFilters() {
  const read = () => {
    const q = new URLSearchParams(window.location.search)
    return {
      range: (q.get("range") as Range) || "7d",
      from: q.get("from") || "",
      to: q.get("to") || "",
      apiKeyId: q.get("apiKeyId") || "",
      combo: q.get("combo") || "",
      // Bộ lọc chi tiết — dữ liệu đã có trong DB từ lâu, chỉ chưa phơi ra.
      email: q.get("email") || "",
      model: q.get("model") || "",
      endpoint: q.get("endpoint") || "",
      status: q.get("status") || "",
      ok: q.get("ok") || "",
      // Backend đã nhận ba tham số này từ lâu, chỉ chưa có nút trên giao diện.
      stream: q.get("stream") || "",
      provider: q.get("provider") || "",
      groupBy: q.get("groupBy") || "",
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
    for (const k of ["apiKeyId", "combo", "email", "model", "endpoint", "status", "ok", "stream", "provider", "groupBy", "from", "to"] as const) {
      if (next[k]) q.set(k, next[k])
    }
    if (next.tab !== "tong-quan") q.set("tab", next.tab)
    const url = window.location.pathname + (q.toString() ? `?${q}` : "")
    window.history.replaceState(null, "", url)
    setF(next)
  }
  return [f, update] as const
}

/**
 * Nhãn trục X — backend trả 3 dạng tuỳ mức gộp:
 *   `2026-08-10 14:00` (giờ) · `2026-08-10` (ngày) · `2026-W32` (tuần)
 * Bản trước cắt cứng `slice(5)`, đúng cho ngày nhưng ra `08-10 14:00` với mức giờ —
 * chồng chữ lên nhau trên trục hẹp.
 */
function fmtBucket(b: string): string {
  const h = /^\d{4}-(\d{2})-(\d{2}) (\d{2}):/.exec(b)
  if (h) return `${h[3]}h`
  const w = /^(\d{4})-W(\d+)$/.exec(b)
  if (w) return `T${w[2]}`
  const d = /^\d{4}-(\d{2})-(\d{2})$/.exec(b)
  return d ? `${d[2]}/${d[1]}` : b
}

/** Thời lượng đọc được: giây khi đã quá 1s. fmtNum rút gọn 13740 thành "13.7k" — vô nghĩa với ms. */
function fmtMs(ms?: number): string {
  if (!ms) return "—"
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

/**
 * "3 giờ trước" thay vì dấu thời gian tuyệt đối.
 *
 * Với bảng lỗi, câu hỏi là "còn đang xảy ra không" — `08-11T04:32` bắt người đọc tự trừ,
 * còn "5 ngày trước" thì trả lời ngay.
 */
function fmtLucNao(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return "vừa xong"
  if (s < 3600) return `${Math.round(s / 60)} phút trước`
  if (s < 86400) return `${Math.round(s / 3600)} giờ trước`
  return `${Math.round(s / 86400)} ngày trước`
}

/** Mã HTTP → vai trò màu. 429 là hết hạn mức (cảnh báo), không phải lỗi hệ thống. */
function statusTone(s?: number | null): string {
  if (!s) return "text-muted-foreground"
  if (s < 300) return "text-[color:var(--success)]"
  if (s === 429 || s === 402) return "text-[color:var(--warning)]"
  return "text-destructive"
}

/** Tên hiển thị của provider — khớp `PROVIDER_IDS` ở backend. */
const PROVIDER_TEN: Record<string, string> = {
  agy: "Antigravity",
  kr: "Kiro",
  or: "OpenRouter",
  no: "Nous Research",
}

/** Mức gộp trục thời gian. Rỗng = để backend tự chọn theo độ dài khoảng. */
const GOP_TEN: Record<string, string> = {
  "": "Gộp: tự động",
  hour: "Theo giờ",
  day: "Theo ngày",
  week: "Theo tuần",
}

export function Reports() {
  const [f, setF] = useUrlFilters()
  const [metric, setMetric] = useState<"requests" | "tokens">("requests")
  const [page, setPage] = useState(0)

  const qs = new URLSearchParams({ range: f.range })
  for (const k of ["apiKeyId", "combo", "email", "model", "endpoint", "status", "ok", "stream", "provider", "groupBy"] as const) {
    if (f[k]) qs.set(k, f[k])
  }
  // Khoảng tự chọn: gửi epoch ms. `to` lấy hết ngày cuối (23:59:59) — chọn "đến 10/08"
  // mà cắt ở 00:00 thì mất nguyên ngày đó.
  if (f.range === "custom" && f.from) qs.set("from", String(new Date(f.from + "T00:00:00").getTime()))
  if (f.range === "custom" && f.to) qs.set("to", String(new Date(f.to + "T23:59:59").getTime()))

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

  /**
   * Lỗi gom theo thông điệp — câu hỏi vận hành số một là "đang lỗi gì".
   *
   * Trước đây phải cuộn hàng nghìn dòng log thô. Đo trên production: 4.977 lỗi gom lại
   * chỉ còn 10 nhóm.
   */
  const errs = useQuery({
    queryKey: ["usageErrors", qs.toString()],
    queryFn: () => api.get<ErrorsResponse>(`/api/gateway/usage/errors?${qs}`),
    enabled: f.tab === "loi",
  })

  // Đổi bộ lọc thì về trang đầu — giữ nguyên trang 7 trên tập kết quả mới là bảng rỗng.
  useEffect(() => { setPage(0) }, [qs.toString()])

  const d = usage.data
  const series = d?.series ?? []
  const days = f.range === "90d" ? 90 : f.range === "30d" ? 30 : 7
  const facets = logs.data?.facets

  /**
   * Bảng lỗi đã gom.
   *
   * `Lần cuối` là cột quan trọng nhất, không phải `Số lần`: production có 4.310 lỗi 429
   * nhưng TOÀN BỘ từ 10–11/08, trước bản vá vòng quota. Không có mốc thời gian thì chúng
   * trông y hệt lỗi đang cháy — đúng cái bẫy đã mắc một lần.
   */
  const errCols: Column<NhomLoi>[] = [
    {
      key: "err", header: "Thông điệp", sort: (r) => r.err,
      render: (r) => (
        <button
          onClick={() => setF({ status: r.statuses.length === 1 ? String(r.statuses[0]) : "", ok: "false", tab: "chi-tiet" })}
          className="block max-w-[30rem] truncate text-left text-xs hover:text-primary hover:underline"
          title={r.viDu || r.err}
        >
          {r.err}
        </button>
      ),
    },
    {
      key: "n", header: "Số lần", align: "right", sort: (r) => r.n,
      render: (r) => {
        const tong = errs.data?.tong ?? 0
        const pct = tong ? Math.round((r.n / tong) * 100) : 0
        return (
          <span className="text-xs tabular-nums">
            {fmtNum(r.n)}
            <span className="ml-1 text-muted-foreground">{pct}%</span>
          </span>
        )
      },
    },
    {
      key: "models", header: "Model", sort: (r) => r.models.length,
      render: (r) => (
        <span className="block max-w-[16rem] truncate text-xs text-muted-foreground" title={r.models.join(", ")}>
          {r.models.length === 1 ? r.models[0] : `${r.models.length} model`}
        </span>
      ),
    },
    {
      key: "statuses", header: "Mã", align: "right", sort: (r) => r.statuses[0] ?? 0,
      render: (r) => (
        <span className="text-xs tabular-nums">
          {r.statuses.map((s) => (
            <span key={s} className={`ml-1 ${statusTone(s)}`}>{s}</span>
          ))}
        </span>
      ),
    },
    {
      key: "lanCuoi", header: "Lần cuối", align: "right", sort: (r) => r.lanCuoi,
      render: (r) => (
        <span className="text-xs tabular-nums text-muted-foreground" title={`lần đầu ${new Date(r.lanDau).toLocaleString("vi")}`}>
          {fmtLucNao(r.lanCuoi)}
        </span>
      ),
    },
  ]

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
      /**
       * Mã số không đủ để chẩn đoán: cùng là 429 nhưng "Individual quota reached,
       * resets in 83h" (chờ là xong) khác hẳn "capacity on this model" (đổi account vô
       * ích) và trần maxOutputTokens (lỗi ở chính request). Trước đây phải mò trong Live
       * Log — vốn chỉ giữ 500 dòng trong RAM và mất sạch khi F5.
       */
      key: "err", header: "Lỗi", sort: (r) => r.err ?? "",
      render: (r) =>
        r.err ? (
          <span className={`block max-w-[22rem] truncate text-xs ${statusTone(r.status)}`} title={r.err}>
            {r.err}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
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

  /**
   * Cột chung cho bảng tổng hợp (model / account).
   *
   * `errors` và `p95` là thứ quan trọng nhất mà bản trước KHÔNG hiện: dữ liệu có sẵn
   * trong mọi bản ghi nhưng hàm gộp không đụng tới. Đo thật trên production:
   * `claude-sonnet-4-6` có 2581/3338 request lỗi (77%) — nhìn bảng cũ chỉ thấy
   * "3338 request" và tưởng mọi thứ bình thường.
   */
  const aggCols = <T extends UsageAgg>(
    keyCol: Column<T>,
  ): Column<T>[] => [
    keyCol,
    { key: "requests", header: "Request", align: "right", sort: (r) => r.requests, render: (r) => <span className="tabular-nums">{fmtNum(r.requests)}</span> },
    {
      key: "errors", header: "Lỗi", align: "right", sort: (r) => (r.requests ? r.errors / r.requests : 0),
      render: (r) => {
        if (!r.requests) return <span className="text-xs text-muted-foreground">—</span>
        const pct = Math.round((r.errors / r.requests) * 100)
        // Sắp theo TỈ LỆ chứ không theo số tuyệt đối: model chạy nhiều tự nhiên nhiều
        // lỗi hơn, nhưng model 77% lỗi mới là cái cần sửa.
        return (
          <span className={`text-xs tabular-nums ${pct >= 50 ? "text-destructive" : pct >= 20 ? "text-[color:var(--warning)]" : "text-muted-foreground"}`}>
            {r.errors ? `${fmtNum(r.errors)} · ${pct}%` : "0"}
          </span>
        )
      },
    },
    {
      key: "p95", header: "p95", align: "right", sort: (r) => r.p95 ?? -1,
      render: (r) => (
        <span className="text-xs tabular-nums text-muted-foreground" title={`trung bình ${fmtMs(r.avgMs)} · p50 ${fmtMs(r.p50)}`}>
          {r.p95 ? fmtMs(r.p95) : "—"}
        </span>
      ),
    },
    { key: "tokIn", header: "Token vào", align: "right", sort: (r) => r.tokIn, render: (r) => <span className="tabular-nums text-muted-foreground">{fmtNum(r.tokIn)}</span> },
    { key: "tokOut", header: "Token ra", align: "right", sort: (r) => r.tokOut, render: (r) => <span className="tabular-nums text-muted-foreground">{fmtNum(r.tokOut)}</span> },
  ]

  const modelCols = aggCols<UsageAgg & { model: string }>({
    key: "model", header: "Model", sort: (r) => r.model,
    // Click để lọc + nhảy sang tab Chi tiết — bảng cũ chỉ render <code>, không bấm được,
    // nên thấy model lỗi nhiều mà không xuống được log của nó.
    render: (r) => (
      <button onClick={() => setF({ model: r.model, tab: "chi-tiet" })} className="text-xs hover:text-primary hover:underline">
        <code>{r.model}</code>
      </button>
    ),
  })

  const accountCols = aggCols<UsageAgg & { email: string }>({
    key: "email", header: "Account", sort: (r) => r.email,
    render: (r) => (
      <button onClick={() => setF({ email: r.email, tab: "chi-tiet" })} className="text-xs hover:text-primary hover:underline">
        {r.email.split("@")[0]}
      </button>
    ),
  })

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
            <span>
              {{ "1d": "24 giờ", "7d": "7 ngày", "30d": "30 ngày", "90d": "90 ngày", custom: "Tự chọn" }[f.range] ?? "7 ngày"}
            </span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1d" className="text-xs">24 giờ</SelectItem>
            <SelectItem value="7d" className="text-xs">7 ngày</SelectItem>
            <SelectItem value="30d" className="text-xs">30 ngày</SelectItem>
            <SelectItem value="90d" className="text-xs">90 ngày</SelectItem>
            <SelectItem value="custom" className="text-xs">Tự chọn…</SelectItem>
          </SelectContent>
        </Select>

        {/* Khoảng tự chọn — backend đã đọc from/to từ lâu, chỉ thiếu widget này. */}
        {f.range === "custom" && (
          <div className="flex items-center gap-1.5">
            <input
              type="date" value={f.from} max={f.to || undefined}
              onChange={(e) => setF({ from: e.target.value })}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <span className="text-xs text-muted-foreground">→</span>
            <input
              type="date" value={f.to} min={f.from || undefined}
              onChange={(e) => setF({ to: e.target.value })}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        )}

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

            {/* Backend nhận `stream` từ lâu; thiếu nút này nên không ai lọc được. */}
            <Select value={f.stream} onValueChange={(v) => setF({ stream: v ?? "" })}>
              <SelectTrigger className="h-8 w-36 text-xs">
                <span className="truncate">
                  {f.stream === "true" ? "Stream" : f.stream === "false" ? "Không stream" : "Mọi kiểu gửi"}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="" className="text-xs">Mọi kiểu gửi</SelectItem>
                <SelectItem value="true" className="text-xs">Stream</SelectItem>
                <SelectItem value="false" className="text-xs">Không stream</SelectItem>
              </SelectContent>
            </Select>
          </>
        )}

        {/* Provider — áp cho CẢ HAI tab: câu hỏi "Kiro hay Antigravity đang lỗi" là câu
            hỏi tổng quan, không phải chi tiết. */}
        <Select value={f.provider} onValueChange={(v) => setF({ provider: v ?? "" })}>
          <SelectTrigger className="h-8 w-40 text-xs">
            <span className="truncate">{f.provider ? PROVIDER_TEN[f.provider] ?? f.provider : "Mọi provider"}</span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="" className="text-xs">Mọi provider</SelectItem>
            {Object.entries(PROVIDER_TEN).map(([id, ten]) => (
              <SelectItem key={id} value={id} className="text-xs">{ten}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Mức gộp: backend tự chọn theo độ dài khoảng, nhưng đôi khi cần ép về giờ để
            soi một sự cố ngắn, hoặc về tuần để thấy xu hướng dài. */}
        <Select value={f.groupBy} onValueChange={(v) => setF({ groupBy: v ?? "" })}>
          <SelectTrigger className="h-8 w-32 text-xs">
            <span className="truncate">{GOP_TEN[f.groupBy] ?? "Gộp: tự động"}</span>
          </SelectTrigger>
          <SelectContent>
            {Object.entries(GOP_TEN).map(([v, ten]) => (
              <SelectItem key={v || "auto"} value={v} className="text-xs">{ten}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {(f.apiKeyId || f.combo || f.email || f.model || f.endpoint || f.status || f.ok || f.stream || f.provider || f.groupBy) && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setF({ apiKeyId: "", combo: "", email: "", model: "", endpoint: "", status: "", ok: "", stream: "", provider: "", groupBy: "" })}
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
          { k: "loi", label: "Lỗi" },
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

      {f.tab === "loi" ? (
        <ChartCard
          title="Lỗi gom theo thông điệp"
          actions={
            <span className="text-xs text-muted-foreground">
              {fmtNum(errs.data?.tong)} lỗi · {errs.data?.nhom.length ?? 0} nhóm
            </span>
          }
        >
          <DataTable
            rows={errs.data?.nhom ?? []}
            columns={errCols}
            rowKey={(r) => r.err}
            loading={errs.isLoading}
            pageSize={25}
          />
          {errs.data && errs.data.nhom.length === 0 && !errs.isLoading && (
            <p className="py-8 text-center text-sm text-[color:var(--success)]">
              Không có lỗi nào trong khoảng đã chọn.
            </p>
          )}
        </ChartCard>
      ) : f.tab === "chi-tiet" ? (
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
              bucket: fmtBucket(x.bucket),
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

      <div className="grid gap-3 xl:grid-cols-2">
        <ChartCard title="Theo model">
          <DataTable
            rows={d?.byModel ?? []}
            columns={modelCols}
            rowKey={(r) => r.model}
            loading={usage.isLoading}
            pageSize={10}
            initialSort={{ key: "requests", dir: "desc" }}
          />
        </ChartCard>

        {/* Account tiêu nhiều nhất — backend trả `byAccount` từ lâu nhưng UI chưa bao
            giờ vẽ. Với pool 700 account, đây là cách duy nhất thấy account nào đang
            gánh tải và account nào lỗi bất thường. */}
        <ChartCard title="Theo account">
          <DataTable
            rows={d?.byAccount ?? []}
            columns={accountCols}
            rowKey={(r) => r.email}
            loading={usage.isLoading}
            pageSize={10}
            initialSort={{ key: "requests", dir: "desc" }}
          />
        </ChartCard>
      </div>
      </>
      )}
    </div>
  )
}
