import { useEffect, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Activity, AlertTriangle, Clock, Cpu, Gauge, Zap } from "lucide-react"
import { api } from "@/lib/api"
import { fmtMs, fmtNum } from "@/lib/format"
import { KpiCard, PageHeader, ChartCard, ErrorState, StatusBadge } from "@/components/common"

/**
 * Trang Metrics — sức khoẻ gateway THỜI GIAN THỰC (poll /api/metrics mỗi 5s).
 *
 * Backend chỉ trả ảnh chụp cửa sổ trượt 5 phút (không lưu chuỗi thời gian —
 * /api/metrics cố ý không đụng DB), nên LỊCH SỬ được tích luỹ phía client:
 * mỗi lần poll đẩy 1 điểm vào bộ nhớ trang, giữ tối đa 120 điểm (~10 phút).
 * F5 là mất lịch sử — chấp nhận được cho màn hình "đang khoẻ không";
 * xu hướng dài hạn đã có trang Báo cáo (đọc DB).
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

interface Point {
  t: number
  rps: number
  errPct: number
  p50: number | null
  p99: number | null
}

const MAX_POINTS = 120 // 120 × 5s = 10 phút lịch sử trong RAM trang

// Màu series — cặp p50/p99 đã qua validator CVD trên nền slate-900 (xem commit).
const C_RPS = "#f97316" // primary của app — 1 series, tiêu đề tự định danh
const C_ERR = "#ef4444"
const C_P50 = "#2563eb"
const C_P99 = "#d97706"

const fmtClock = (t: number) =>
  new Date(t).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })

// ── Line chart SVG (crosshair + tooltip, grid chìm, nét 2px) ───────────

interface Series {
  name: string
  color: string
  /** null = chưa có mẫu tại điểm đó (vd latency khi cửa sổ trống) — ngắt nét, không vẽ 0 giả. */
  values: (number | null)[]
}

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
        {n < 2 ? "Đang thu thập… cần ≥ 2 lần poll (10s) để vẽ" : "Chưa có mẫu nào trong cửa sổ — gateway chưa nhận request"}
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
            <line x1={PAD_L} x2={W - PAD_R} y1={y(v)} y2={y(v)} stroke="#1e293b" strokeWidth="1" />
            <text x={PAD_L - 6} y={y(v) + 3} textAnchor="end" fontSize="9" fill="#64748b">{fmt(v)}</text>
          </g>
        ))}
        <line x1={PAD_L} x2={W - PAD_R} y1={y(0)} y2={y(0)} stroke="#334155" strokeWidth="1" />
        {/* Nhãn thời gian đầu/cuối */}
        <text x={PAD_L} y={H - 4} fontSize="9" fill="#64748b">{fmtClock(points[0]!.t)}</text>
        <text x={W - PAD_R} y={H - 4} textAnchor="end" fontSize="9" fill="#64748b">{fmtClock(points[n - 1]!.t)}</text>

        {series.map((s) => (
          <path key={s.name} d={pathOf(s.values)} fill="none" stroke={s.color} strokeWidth="2"
            strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        ))}

        {/* Crosshair + marker tại điểm gần con trỏ */}
        {hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={H - PAD_B} stroke="#475569" strokeWidth="1" strokeDasharray="3 3" />
            {series.map((s) => {
              const v = s.values[hover]
              return v == null ? null : (
                <circle key={s.name} cx={x(hover)} cy={y(v)} r="3.5" fill={s.color} stroke="#0f172a" strokeWidth="2" />
              )
            })}
          </g>
        )}
      </svg>

      {hp && hover != null && (
        <div
          className="pointer-events-none absolute top-1 z-10 rounded-md border border-border bg-slate-950/95 px-2.5 py-1.5 text-xs shadow-lg"
          style={hover > n / 2 ? { right: `${100 - (x(hover) / W) * 100 + 2}%` } : { left: `${(x(hover) / W) * 100 + 2}%` }}
        >
          <p className="mb-1 font-mono text-[10px] text-muted-foreground">{fmtClock(hp.t)}</p>
          {series.map((s) => {
            const v = s.values[hover]
            return (
              <p key={s.name} className="flex items-center gap-1.5 tabular-nums text-slate-200">
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

  const [history, setHistory] = useState<Point[]>([])
  useEffect(() => {
    const d = q.data
    if (!d) return
    setHistory((h) => {
      // refetch thủ công/focus có thể trả cùng snapshot — không đẩy điểm trùng
      if (h.length && h[h.length - 1]!.t === d.now) return h
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
        desc={`Cửa sổ trượt ${w?.windowSec ?? 300}s trong RAM server · poll 5s · lịch sử ${history.length}/${MAX_POINTS} điểm phía trình duyệt`}
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

      <ChartCard title="Pool theo provider">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="pb-2 font-medium">Provider</th>
              <th className="pb-2 font-medium">Khả dụng</th>
              <th className="pb-2 font-medium">Inflight</th>
              <th className="pb-2 font-medium">Circuit breaker</th>
            </tr>
          </thead>
          <tbody>
            {d ? Object.entries(d.accounts).map(([pid, a]) => {
              const b = d.breaker[pid]
              const st = !b || b.state === "closed" ? "ok" : b.state === "open" ? "error" : "cooldown"
              return (
                <tr key={pid} className="border-b border-border/50 last:border-0">
                  <td className="py-2 font-mono">{pid}</td>
                  <td className="py-2 tabular-nums">
                    {a.available}/{a.total}
                    {a.total > 0 && a.available === 0 && <span className="ml-1.5 text-xs text-destructive">cạn pool</span>}
                  </td>
                  <td className="py-2 tabular-nums">{a.inflight}</td>
                  <td className="py-2">
                    <StatusBadge status={st} label={b ? `${BREAKER_LABEL[b.state]}${b.consecutiveFails ? ` · ${b.consecutiveFails} lỗi` : ""}` : "mạch đóng"} />
                  </td>
                </tr>
              )
            }) : (
              <tr><td colSpan={4} className="py-6 text-center text-muted-foreground">Đang tải…</td></tr>
            )}
          </tbody>
        </table>
      </ChartCard>
    </div>
  )
}
