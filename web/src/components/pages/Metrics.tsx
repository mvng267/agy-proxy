import { useEffect, useMemo, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Activity, AlertTriangle, Clock, Cpu, Gauge, Zap } from "lucide-react"
import { api } from "@/lib/api"
import { fmtMs, fmtNum } from "@/lib/format"
import { KpiCard, PageHeader, ChartCard, ErrorState, StatusBadge } from "@/components/common"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

/**
 * Trang Metrics — sức khoẻ gateway, hai nguồn ghép lại:
 *
 *  1. `/api/metrics/history` (DB, job nền ghi mỗi 60s) — LỊCH SỬ, sống qua F5 và qua
 *     restart server. Đây là nguồn chính.
 *  2. `/api/metrics` (poll 5s) — ảnh chụp cửa sổ trượt 5 phút cho các thẻ KPI, đồng thời
 *     bồi thêm phần đuôi để đường vẫn nhúc nhích giữa hai lần ghi DB.
 *
 * Trước đây CHỈ có nguồn 2 và lịch sử tích luỹ trong RAM trang: F5 là trắng, phải chờ
 * ≥2 nhịp poll mới vẽ được gì — trên production ba khung chart chiếm hơn nửa màn hình
 * chỉ để hiện "Đang thu thập…".
 *
 * Trục x vẫn cách đều theo THỨ TỰ điểm chứ không theo thời gian thực; với dữ liệu DB
 * đều nhịp 1 phút thì hai thứ đó trùng nhau.
 */

interface MetricsResp {
  now: number
  uptimeSec: number
  rssMb: number
  window: {
    windowSec: number
    requests: number
    errors: number
    errorRate: number
    rps: number
    latency: { avgMs: number; p50: number; p95: number; p99: number } | null
    totals: { requests: number; errors: number }
  }
  accounts: Record<string, { total: number; available: number; inflight: number }>
  breaker: Record<string, { state: "closed" | "open" | "half-open"; consecutiveFails: number }>
}

interface HistoryResp {
  series: Array<{
    ts: number
    rps: number | null
    errorRate: number | null
    p50: number | null
    p95: number | null
    p99: number | null
    accTotal: number | null
    accAvailable: number | null
  }>
  groupBy: "raw" | "minute" | "hour"
  total: number
}

interface Point {
  t: number
  rps: number
  errPct: number
  p50: number | null
  p99: number | null
  /** Số account khả dụng — chỉ có từ DB (poll 5s không mang theo con số này). */
  avail?: number | null
}

const MAX_POINTS = 120 // 120 × 5s = 10 phút lịch sử trong RAM trang

// Màu series — cặp p50/p99 đã qua validator CVD trên nền slate-900 (xem commit).
/* Bốn series ĐỌC TOKEN nên đổi theo theme. Giữ 4 sắc phân biệt được: gộp về thang xám
   thì p50 và p99 chồng nhau không đọc nổi. */
const C_RPS = "var(--chart-1)"
const C_ERR = "var(--chart-danger)"
const C_P50 = "var(--chart-info)"
const C_P99 = "var(--chart-warning)"
const C_AVAIL = "var(--chart-success)"

const fmtClock = (t: number) =>
  new Date(t).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })

// ── Line chart SVG (crosshair + tooltip, grid chìm, nét 2px) ───────────

interface Series {
  name: string
  color: string
  /** null = chưa có mẫu tại điểm đó (vd latency khi cửa sổ trống) — ngắt nét, không vẽ 0 giả. */
  values: (number | null)[]
}

/**
 * Biểu đồ đường tự vẽ — CỐ Ý giữ, đã cân nhắc thay bằng Recharts và quyết định không.
 *
 * Recharts không thắng ở đây: bản này đã dùng token màu nên tự đổi theo theme, đã có
 * crosshair + tooltip đọc mọi series cùng lúc, và quan trọng nhất là NGẮT NÉT ở điểm
 * `null` thay vì vẽ 0 giả — cửa sổ không có mẫu nào (gateway rảnh) khác hẳn cửa sổ có
 * mẫu với độ trễ 0ms. Đổi sang Recharts sẽ phải dựng lại đúng ba thứ đó, đánh đổi lấy
 * ~100 KB thư viện. Không đổi vì đổi.
 */
function LineChart({
  points, series, fmt, height = 160,
}: {
  points: Point[]
  series: Series[]
  fmt: (v: number) => string
  height?: number
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number | null>(null)

  const W = 600
  const H = height
  const PAD_L = 44
  const PAD_R = 10
  const PAD_T = 8
  const PAD_B = 18

  const n = points.length
  const all = series.flatMap((s) => s.values).filter((v): v is number => v != null)
  const rawMax = all.length ? Math.max(...all) : 1
  const yMax = rawMax <= 0 ? 1 : rawMax * 1.15 // headroom để đỉnh không dính mép
  const x = (i: number) => PAD_L + (n <= 1 ? 0 : (i / (n - 1)) * (W - PAD_L - PAD_R))
  const y = (v: number) => PAD_T + (1 - v / yMax) * (H - PAD_T - PAD_B)

  const gridYs = [0.25, 0.5, 0.75, 1].map((f) => yMax * f)

  const pathOf = (vals: (number | null)[]) => {
    let d = ""
    let pen = false
    vals.forEach((v, i) => {
      if (v == null) { pen = false; return }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`
      pen = true
    })
    return d
  }

  const onMove = (e: React.MouseEvent) => {
    if (!wrapRef.current || n < 2) return
    const r = wrapRef.current.getBoundingClientRect()
    const px = ((e.clientX - r.left) / r.width) * W
    const i = Math.round(((px - PAD_L) / (W - PAD_L - PAD_R)) * (n - 1))
    setHover(Math.max(0, Math.min(n - 1, i)))
  }

  if (n < 2 || all.length === 0) {
    return (
      <div className="flex items-center justify-center text-sm text-muted-foreground" style={{ height }}>
        {n < 2 ? "Chưa đủ điểm để vẽ — job nền ghi mỗi 60s, chờ khoảng 2 phút" : "Chưa có mẫu nào trong cửa sổ — gateway chưa nhận request"}
      </div>
    )
  }

  const hp = hover != null ? points[hover] : null

  return (
    <div ref={wrapRef} className="relative" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" style={{ height }} preserveAspectRatio="none">
        {/* Grid chìm + nhãn trục y */}
        {gridYs.map((v) => (
          <g key={v}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth="1" />
            <text x={PAD_L - 6} y={y(v) + 3} textAnchor="end" fontSize="9" fill="var(--muted-foreground)">{fmt(v)}</text>
          </g>
        ))}
        <line x1={PAD_L} x2={W - PAD_R} y1={y(0)} y2={y(0)} stroke="var(--border)" strokeWidth="1" />
        {/* Nhãn thời gian đầu/cuối */}
        <text x={PAD_L} y={H - 4} fontSize="9" fill="var(--muted-foreground)">{fmtClock(points[0]!.t)}</text>
        <text x={W - PAD_R} y={H - 4} textAnchor="end" fontSize="9" fill="var(--muted-foreground)">{fmtClock(points[n - 1]!.t)}</text>

        {series.map((s) => (
          <path key={s.name} d={pathOf(s.values)} fill="none" stroke={s.color} strokeWidth="2"
            strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        ))}

        {/* Crosshair + marker tại điểm gần con trỏ */}
        {hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={H - PAD_B} stroke="var(--muted-foreground)" strokeWidth="1" strokeDasharray="3 3" />
            {series.map((s) => {
              const v = s.values[hover]
              return v == null ? null : (
                <circle key={s.name} cx={x(hover)} cy={y(v)} r="3.5" fill={s.color} stroke="var(--background)" strokeWidth="2" />
              )
            })}
          </g>
        )}
      </svg>

      {hp && hover != null && (
        <div
          className="pointer-events-none absolute top-1 z-10 rounded-md border border-border bg-background/95 px-2.5 py-1.5 text-xs shadow-lg"
          style={hover > n / 2 ? { right: `${100 - (x(hover) / W) * 100 + 2}%` } : { left: `${(x(hover) / W) * 100 + 2}%` }}
        >
          <p className="mb-1 font-mono text-[10px] text-muted-foreground">{fmtClock(hp.t)}</p>
          {series.map((s) => {
            const v = s.values[hover]
            return (
              <p key={s.name} className="flex items-center gap-1.5 tabular-nums text-foreground">
                <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                {s.name}: {v == null ? "—" : fmt(v)}
              </p>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Chú giải series (≥2 series bắt buộc có — màu không được là kênh duy nhất). */
function Legend({ series }: { series: { name: string; color: string }[] }) {
  return (
    <div className="flex items-center gap-3">
      {series.map((s) => (
        <span key={s.name} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
          {s.name}
        </span>
      ))}
    </div>
  )
}

const fmtUptime = (sec?: number) => {
  if (sec == null) return "—"
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`
}

const BREAKER_LABEL: Record<string, string> = {
  closed: "mạch đóng",
  open: "mạch MỞ",
  "half-open": "thăm dò",
}

// ── Trang ──────────────────────────────────────────────────────────────

export function Metrics() {
  const q = useQuery({
    queryKey: ["metrics"],
    queryFn: () => api.get<MetricsResp>("/api/metrics"),
    refetchInterval: 5_000,
  })

  // Cửa sổ lịch sử. 6h là mặc định vừa đủ nhìn một ca làm việc mà vẫn giữ độ mịn 1 phút
  // (backend trả `raw` khi ≤6h, gộp dần khi dài hơn).
  const [histHours, setHistHours] = useState(6)

  /**
   * Lịch sử NẠP TỪ DB, không còn dựng lại từ đầu mỗi lần mở trang.
   *
   * Trước đây trang tự tích luỹ điểm trong RAM trình duyệt, nên F5 là trắng và phải chờ
   * ≥2 nhịp poll (10s) mới vẽ được gì — trên production ba khung chart chiếm hơn nửa màn
   * hình chỉ để hiện chữ "Đang thu thập…". Job nền ghi mỗi 60s xuống `metrics_history`,
   * endpoint này đọc ra, nên mở trang là có ngay.
   */
  const hist = useQuery({
    queryKey: ["metrics-history", histHours],
    queryFn: () => api.get<HistoryResp>(`/api/metrics/history?hours=${histHours}`),
    refetchInterval: 60_000,
  })

  /**
   * Điểm bồi thêm từ nhịp poll 5s.
   *
   * DB chỉ có độ mịn 1 phút; giữ thêm phần đuôi này để đường vẫn nhúc nhích theo thời
   * gian thực giữa hai lần ghi. Chỉ là phần bổ sung — mất nó (F5) không còn làm trắng
   * chart nữa.
   */
  const [live, setLive] = useState<Point[]>([])
  useEffect(() => {
    const d = q.data
    if (!d) return
    setLive((h) => {
      // refetch thủ công/focus xen giữa nhịp poll → điểm dày đặc làm méo trục x
      // (x cách đều theo index); bỏ điểm đến sớm hơn 2s so với điểm trước.
      if (h.length && d.now - h[h.length - 1]!.t < 2_000) return h
      const next = [...h, {
        t: d.now,
        rps: d.window.rps,
        errPct: d.window.errorRate * 100,
        p50: d.window.latency?.p50 ?? null,
        p99: d.window.latency?.p99 ?? null,
      }]
      return next.length > MAX_POINTS ? next.slice(next.length - MAX_POINTS) : next
    })
  }, [q.data])

  /**
   * Ghép DB + đuôi thời gian thực. Bỏ điểm live trùng khoảng thời gian đã có trong DB
   * để đoạn nối không bị gấp khúc hay vẽ hai lần cùng một lúc.
   */
  const history = useMemo<Point[]>(() => {
    const fromDb: Point[] = (hist.data?.series ?? []).map((r) => ({
      t: r.ts,
      rps: r.rps ?? 0,
      errPct: (r.errorRate ?? 0) * 100,
      p50: r.p50 ?? null,
      p99: r.p99 ?? null,
      avail: r.accAvailable ?? null,
    }))
    if (!fromDb.length) return live
    const lastDb = fromDb[fromDb.length - 1]!.t
    return [...fromDb, ...live.filter((p) => p.t > lastDb)]
  }, [hist.data, live])

  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />

  const d = q.data
  const w = d?.window
  const errPct = w ? w.errorRate * 100 : null
  const inflight = d ? Object.values(d.accounts).reduce((s, a) => s + a.inflight, 0) : 0
  const openBreaker = d ? Object.entries(d.breaker).filter(([, b]) => b.state !== "closed") : []

  const latencySeries = [
    { name: "p50", color: C_P50 },
    { name: "p99", color: C_P99 },
  ]

  return (
    <div className="space-y-4">
      <PageHeader
        title="Metrics"
        desc={`Cửa sổ trượt ${w?.windowSec ?? 300}s · poll 5s · ${history.length} điểm lịch sử${hist.data?.groupBy && hist.data.groupBy !== "raw" ? ` (gộp theo ${hist.data.groupBy === "hour" ? "giờ" : "phút"})` : ""}`}
        actions={
          <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
            {([[1, "1h"], [6, "6h"], [24, "24h"], [168, "7d"]] as const).map(([h, lbl]) => (
              <button
                key={h}
                onClick={() => setHistHours(h)}
                className={`rounded-md px-2 py-1 text-xs transition-colors ${
                  histHours === h
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                {lbl}
              </button>
            ))}
          </div>
        }
      />

      {openBreaker.length > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Circuit breaker: {openBreaker.map(([pid, b]) => `${pid} ${BREAKER_LABEL[b.state]} (${b.consecutiveFails} lỗi liên tiếp)`).join(" · ")}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <KpiCard label="Requests / giây" value={w?.rps ?? "—"} sub={`${fmtNum(w?.requests)} req trong cửa sổ`} icon={Zap} loading={q.isPending} />
        <KpiCard
          label="Tỉ lệ lỗi" value={errPct == null ? "—" : `${errPct.toFixed(1)}%`}
          sub={`${w?.errors ?? 0} lỗi`} icon={AlertTriangle}
          tone={errPct != null && errPct > 5 ? "danger" : errPct ? "warning" : "success"}
          loading={q.isPending}
        />
        <KpiCard label="p99 latency" value={fmtMs(w?.latency?.p99)} sub={`p95 ${fmtMs(w?.latency?.p95)} · avg ${fmtMs(w?.latency?.avgMs)}`} icon={Gauge} loading={q.isPending} />
        <KpiCard label="Đang bay" value={inflight} sub="request inflight" icon={Activity} loading={q.isPending} />
        <KpiCard label="Uptime" value={fmtUptime(d?.uptimeSec)} sub={`${fmtNum(w?.totals.requests)} req luỹ kế`} icon={Clock} loading={q.isPending} />
        <KpiCard label="RAM server" value={d ? `${d.rssMb}MB` : "—"} sub="RSS của process" icon={Cpu} loading={q.isPending} />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <ChartCard title="Requests / giây">
          <LineChart
            points={history}
            series={[{ name: "req/s", color: C_RPS, values: history.map((p) => p.rps) }]}
            fmt={(v) => v >= 10 ? v.toFixed(0) : v.toFixed(2)}
          />
        </ChartCard>
        <ChartCard title="Tỉ lệ lỗi (%)">
          <LineChart
            points={history}
            series={[{ name: "lỗi", color: C_ERR, values: history.map((p) => p.errPct) }]}
            fmt={(v) => `${v.toFixed(1)}%`}
          />
        </ChartCard>
      </div>

      <ChartCard title="Độ trễ (ms)" actions={<Legend series={latencySeries} />}>
        <LineChart
          points={history}
          height={190}
          series={[
            { ...latencySeries[0]!, values: history.map((p) => p.p50) },
            { ...latencySeries[1]!, values: history.map((p) => p.p99) },
          ]}
          fmt={(v) => fmtMs(v)}
        />
      </ChartCard>

      {/* Pool khả dụng theo thời gian — chỉ vẽ được từ khi có bảng metrics_history.
          Đây là thứ cho biết pool đang cạn dần hay đã hồi, mà trước đây không nhìn được. */}
      {history.some((p) => p.avail != null) && (
        <ChartCard title="Account khả dụng theo thời gian">
          <LineChart
            points={history}
            height={150}
            series={[{ name: "khả dụng", color: C_AVAIL, values: history.map((p) => p.avail ?? null) }]}
            fmt={(v) => fmtNum(Math.round(v))}
          />
        </ChartCard>
      )}

      <ChartCard title="Pool theo provider">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Provider</TableHead>
              <TableHead>Khả dụng</TableHead>
              <TableHead>Inflight</TableHead>
              <TableHead>Circuit breaker</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {d ? Object.entries(d.accounts).map(([pid, a]) => {
              const br = d.breaker[pid]
              const st = !br || br.state === "closed" ? "ok" : br.state === "open" ? "error" : "cooldown"
              return (
                <TableRow key={pid}>
                  <TableCell className="font-mono">{pid}</TableCell>
                  {/* Thanh tỉ lệ thay vì chỉ hai con số: "348/350" và "12/350" đọc lướt
                      trông giống nhau, còn thanh gần đầy so với gần rỗng thì thấy ngay. */}
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{
                            width: `${a.total ? (a.available / a.total) * 100 : 0}%`,
                            background: `var(--chart-${a.available === 0 ? "danger" : a.available / Math.max(1, a.total) < 0.2 ? "warning" : "success"})`,
                          }}
                        />
                      </div>
                      <span className="tabular-nums">{a.available}/{a.total}</span>
                      {a.total > 0 && a.available === 0 && <span className="text-xs text-destructive">cạn pool</span>}
                    </div>
                  </TableCell>
                  <TableCell className="tabular-nums">{a.inflight}</TableCell>
                  <TableCell>
                    <StatusBadge status={st} label={br ? `${BREAKER_LABEL[br.state]}${br.consecutiveFails ? ` · ${br.consecutiveFails} lỗi` : ""}` : "mạch đóng"} />
                  </TableCell>
                </TableRow>
              )
            }) : (
              <TableRow><TableCell colSpan={4} className="py-6 text-center text-muted-foreground">Đang tải…</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </ChartCard>
    </div>
  )
}
