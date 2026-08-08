import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { cn } from "@/lib/utils"

/**
 * Biểu đồ dùng chung cho dashboard.
 *
 * ⚠ KHÔNG re-export file này qua `common/index.tsx`. Barrel đó được mọi trang import, nên
 * chỉ cần một dòng `export * from './charts'` là Recharts lọt vào chunk khởi động và bundle
 * phình thêm ~100 KB cho cả những trang không có biểu đồ nào. Import trực tiếp:
 *   import { TimeSeries } from "@/components/common/charts"
 *
 * Vì sao có file này: trước đây mỗi trang tự vẽ SVG, và các hàm bị NHÂN ĐÔI —
 * `DonutChart` giống hệt nhau ở `Overview.tsx:252` và `Pool.tsx:91`, `SvgBars`+`HBar` lặp
 * giữa `Overview.tsx` và `Usage.tsx`. Tệ hơn: mọi màu là hex cứng (cam thương hiệu, slate-tối…) nên
 * biểu đồ KHÔNG đổi theo theme — trên nền sáng thì lưới và chữ màu slate-tối biến mất.
 *
 * Phân định công cụ, tránh dùng búa tạ đập ruồi:
 *  - Recharts cho thứ cần trục/lưới/tooltip/gradient: `TimeSeries`, `BarSeries`
 *  - SVG hoặc <div> tay cho thứ đơn giản: `PoolDonut` (1 vòng 3 cung), `RankBar`,
 *    `SegmentBar` (thực chất chỉ là div có width %), `Sparkline` (một <path>)
 */

// ── Recharts ───────────────────────────────────────────────────────────

/**
 * `aspect-auto w-full` là BẮT BUỘC khi đặt `height` cố định.
 *
 * `ChartContainer` của registry mặc định `aspect-video justify-center`; giữ nguyên thì
 * chiều cao mình đặt bị tỉ lệ 16:9 ép ngược lại bề rộng, và `justify-center` căn khối
 * hẹp đó vào giữa — kết quả là biểu đồ chỉ chiếm nửa card, phần còn lại bỏ trống.
 * Sửa ở chỗ DÙNG chứ không sửa `ui/chart.tsx` để lần sau lấy lại từ registry không mất.
 */

/** Trục/lưới/tooltip dùng chung — đọc token nên tự đổi theo theme. */
const AXIS = {
  stroke: "var(--muted-foreground)",
  fontSize: 11,
  tickLine: false,
  axisLine: false,
} as const

export interface SeriesDef {
  key: string
  label: string
  /** Token màu; mặc định đi theo thứ tự chart-1..5. */
  color?: string
}

function toConfig(series: SeriesDef[]): ChartConfig {
  const cfg: ChartConfig = {}
  series.forEach((s, i) => {
    cfg[s.key] = { label: s.label, color: s.color ?? `var(--chart-${(i % 5) + 1})` }
  })
  return cfg
}

/**
 * Chuỗi thời gian dạng vùng có gradient (kiểu Atlas "Network Flow").
 * Dùng cho lưu lượng theo ngày, RPS, độ trễ.
 */
export function TimeSeries({
  data,
  xKey,
  series,
  height = 220,
  className,
}: {
  data: Array<Record<string, unknown>>
  xKey: string
  series: SeriesDef[]
  height?: number
  className?: string
}) {
  const cfg = toConfig(series)
  return (
    <ChartContainer config={cfg} className={cn("aspect-auto w-full", className)} style={{ height }}>
      <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`fill-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={`var(--color-${s.key})`} stopOpacity={0.28} />
              <stop offset="95%" stopColor={`var(--color-${s.key})`} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        {/* Lưới nét đứt chìm — Atlas dùng đúng kiểu này. */}
        <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis dataKey={xKey} {...AXIS} tickMargin={8} minTickGap={24} />
        <YAxis {...AXIS} width={40} />
        <ChartTooltip content={<ChartTooltipContent />} />
        {series.map((s) => (
          <Area
            key={s.key}
            type="monotone"
            dataKey={s.key}
            stroke={`var(--color-${s.key})`}
            strokeWidth={2}
            fill={`url(#fill-${s.key})`}
          />
        ))}
      </AreaChart>
    </ChartContainer>
  )
}

/** Cột nhiều series (kiểu Atlas "Threat Vectors"). */
export function BarSeries({
  data,
  xKey,
  series,
  height = 220,
  className,
}: {
  data: Array<Record<string, unknown>>
  xKey: string
  series: SeriesDef[]
  height?: number
  className?: string
}) {
  const cfg = toConfig(series)
  return (
    <ChartContainer config={cfg} className={cn("aspect-auto w-full", className)} style={{ height }}>
      <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis dataKey={xKey} {...AXIS} tickMargin={8} minTickGap={16} />
        <YAxis {...AXIS} width={40} />
        <ChartTooltip content={<ChartTooltipContent />} />
        {series.map((s) => (
          <Bar key={s.key} dataKey={s.key} fill={`var(--color-${s.key})`} radius={[3, 3, 0, 0]} />
        ))}
      </BarChart>
    </ChartContainer>
  )
}

// ── SVG / div tay (không cần thư viện) ─────────────────────────────────

export interface Segment {
  label: string
  value: number
  /** Token ngữ nghĩa: success | warning | danger | info | muted. */
  tone: "success" | "warning" | "danger" | "info" | "muted"
}

/**
 * Vòng tròn MỘT cung + phần trăm ở giữa + nhãn dưới (hạn mức Gemini/Claude).
 *
 * Gộp hai bản từng trùng nhau: `QuotaDonut` (Quota.tsx) và `Donut` (Overview.tsx) —
 * cùng vẽ một vòng, cùng đặt % ở giữa, chỉ khác vài con số.
 *
 * Giữ lại hai điểm mạnh của bản Overview mà bản Quota không có:
 *  - màu TỰ chọn theo ngưỡng (nhiều → khoẻ, ít → cảnh báo, cạn → nguy hiểm), nên người
 *    xem biết ngay tình trạng mà không phải đọc số;
 *  - `pct == null` (chưa nạp hạn mức) vẽ "—" và tô xám, khác hẳn 0% (đã nạp và đã cạn).
 *    Nhập nhèm hai trạng thái này từng khiến pool còn nguyên quota trông như đã hết.
 */
export function DonutStat({
  pct,
  label,
  size = 96,
  strokeWidth = 9,
  tone,
}: {
  pct?: number | null
  label?: string
  size?: number
  strokeWidth?: number
  /** Ép màu; bỏ trống thì tự chọn theo ngưỡng. */
  tone?: "success" | "warning" | "danger" | "info" | "muted"
}) {
  const r = (size - strokeWidth) / 2
  const c = 2 * Math.PI * r
  const p = Math.max(0, Math.min(100, pct ?? 0))
  const filled = c * (p / 100)
  const auto = p >= 50 ? "success" : p >= 20 ? "warning" : "danger"
  const stroke = `var(--chart-${pct == null ? "muted" : tone ?? auto})`

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--muted)" strokeWidth={strokeWidth} />
          {pct != null && p > 0 ? (
            <circle
              cx={size / 2} cy={size / 2} r={r} fill="none"
              stroke={stroke} strokeWidth={strokeWidth}
              strokeDasharray={`${filled} ${c - filled}`}
              strokeLinecap="round"
              className="transition-all duration-700"
            />
          ) : null}
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-base font-semibold tabular-nums text-foreground">
            {pct == null ? "—" : `${Math.round(p)}%`}
          </span>
        </div>
      </div>
      {label ? <span className="text-xs text-muted-foreground">{label}</span> : null}
    </div>
  )
}

/**
 * Vòng tròn nhiều cung + số ở giữa (sức khoẻ pool).
 *
 * Dùng NHÓM TOKEN NGỮ NGHĨA chứ không phải thang xám `--chart-1..5`: ba cung
 * active/cooldown/chết mà cùng sắc xám thì không ai đọc được đâu là đâu.
 */
export function PoolDonut({
  segments,
  center,
  sub,
  size = 132,
  strokeWidth = 12,
}: {
  segments: Segment[]
  center: string | number
  sub?: string
  size?: number
  strokeWidth?: number
}) {
  const r = (size - strokeWidth) / 2
  const c = 2 * Math.PI * r
  const total = segments.reduce((s, x) => s + x.value, 0) || 1
  let offset = 0

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--chart-muted)" strokeWidth={strokeWidth} opacity={0.25} />
        {segments.map((s) => {
          const len = (s.value / total) * c
          const el = (
            <circle
              key={s.label}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={`var(--chart-${s.tone})`}
              strokeWidth={strokeWidth}
              strokeDasharray={`${len} ${c - len}`}
              strokeDashoffset={-offset}
              strokeLinecap={len > 0 ? "round" : "butt"}
              className="transition-all duration-500"
            />
          )
          offset += len
          return el
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-semibold tabular-nums text-foreground">{center}</span>
        {sub ? <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{sub}</span> : null}
      </div>
    </div>
  )
}

/** Một dòng xếp hạng: nhãn · thanh · số (top model, top account). */
export function RankBar({
  label,
  value,
  max,
  tone = "chart-1",
  format,
}: {
  label: string
  value: number
  max: number
  /** Tên token không kèm `var()` — vd `chart-1`, `chart-success`. */
  tone?: string
  format?: (n: number) => string
}) {
  const pct = max > 0 ? Math.max(2, (value / max) * 100) : 0
  return (
    <div className="flex items-center gap-2">
      <span className="w-36 shrink-0 truncate text-xs text-muted-foreground" title={label}>
        {label}
      </span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, background: `var(--${tone})` }}
        />
      </div>
      <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {format ? format(value) : value}
      </span>
    </div>
  )
}

/**
 * Thanh ngang chia đoạn theo tỉ lệ (phân bổ pool), kèm chú thích.
 *
 * `legend` mặc định BẬT: thanh màu không có nhãn thì người xem phải đoán đâu là
 * cooldown đâu là chết — nhất là khi các đoạn quá nhỏ để phân biệt.
 */
export function SegmentBar({
  segments,
  height = 8,
  legend = true,
}: {
  segments: Segment[]
  height?: number
  legend?: boolean
}) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1
  return (
    <div className="space-y-2">
      <div className="flex w-full overflow-hidden rounded-full bg-muted" style={{ height }}>
        {segments.map((s) =>
          s.value > 0 ? (
            <div
              key={s.label}
              className="h-full transition-all duration-500"
              style={{ width: `${(s.value / total) * 100}%`, background: `var(--chart-${s.tone})` }}
              title={`${s.label}: ${s.value}`}
            />
          ) : null,
        )}
      </div>
      {legend ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {segments.map((s) => (
            <span key={s.label} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="size-2 rounded-full" style={{ background: `var(--chart-${s.tone})` }} />
              {s.label} <span className="tabular-nums text-foreground">{s.value}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export { Sparkline } from "./Sparkline"
