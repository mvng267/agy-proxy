import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { Sparkline, TimeSeries } from "@/components/common/charts"
import { TrendingUp, TrendingDown } from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

/**
 * Biểu đồ xu hướng hạn mức.
 *
 * Tách khỏi `Quota.tsx` (970 dòng) vì nó tự đủ: chỉ cần biết đang xem account nào, còn
 * khoảng thời gian, dữ liệu, cách xoay bảng và bảng màu đều là chuyện riêng của nó. Ở
 * trang cha chúng nằm lẫn giữa bộ lọc bảng và phân trang, và mỗi lần sửa bảng lại phải
 * cuộn qua.
 */

interface HistoryData {
  series?: Array<{ bucket: string; provider?: string | null; gemini?: number; third?: number }>
  providers?: string[]
  points?: Array<{ ts: string; gemini_pct?: number; third_pct?: number }>
}

/** Nhãn trục X: giờ trong ngày, ngày/tháng, hoặc epoch ms — tuỳ độ mịn backend trả về. */
function fmtBucket(b: string | number): string {
  const s = String(b)
  const hour = s.match(/^\d{4}-\d{2}-\d{2}[ T](\d{2}):/)
  if (hour) return `${hour[1]}:00`
  const day = s.match(/^\d{4}-(\d{2})-(\d{2})$/)
  if (day) return `${day[2]}/${day[1]}`
  const n = Number(b)
  if (Number.isFinite(n) && n > 0) {
    const d = new Date(n)
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`
  }
  return s
}

/**
 * XOAY dữ liệu: mỗi (provider, bể) thành MỘT cột riêng.
 *
 * Bản trước vẽ đúng hai đường "Gemini" và "Claude/GPT" từ trung bình TOÀN pool — nhưng
 * trung bình đó cộng chung agy với kr, hai thứ có hạn mức và chu kỳ reset khác hẳn nhau.
 * Đo trên production 11/08/2026: biểu đồ hiện "Gemini 45%" trong khi thực tế agy còn 1%
 * và kr còn 91%. Nhìn vào tưởng quota thoải mái, thực ra một bể đã cạn.
 *
 * Giờ mỗi provider một đường. Backend trả `provider` trên từng điểm (migration v6).
 */
function xoay(d?: HistoryData): Array<Record<string, unknown>> {
  const rows = d?.series
  if (!rows?.length) {
    return d?.points?.map((p) => ({ t: fmtBucket(p.ts), "agy·gemini": p.gemini_pct ?? null, "agy·third": p.third_pct ?? null })) ?? []
  }
  const theoBucket = new Map<string, Record<string, unknown>>()
  for (const r of rows) {
    const t = fmtBucket(r.bucket)
    const hang = theoBucket.get(t) ?? { t }
    const p = r.provider ?? "?"
    // Dữ liệu trước migration v6 chưa có provider → gom vào nhóm "?" thay vì vứt đi.
    if (r.gemini != null) hang[`${p}·${p === "kr" ? "credits" : "gemini"}`] = r.gemini
    if (r.third != null) hang[`${p}·third`] = r.third
    theoBucket.set(t, hang)
  }
  return [...theoBucket.values()]
}

/** Định nghĩa đường vẽ — dựng theo DỮ LIỆU CÓ THẬT, không cứng tên provider. */
function duongVe(series: Array<Record<string, unknown>>) {
  const keys = new Set<string>()
  for (const h of series) for (const k of Object.keys(h)) if (k !== "t") keys.add(k)
  const MAU: Record<string, string> = {
    "agy·gemini": "var(--chart-success)",
    "agy·third": "var(--chart-info)",
    "kr·credits": "var(--chart-warning)",
    "no·gemini": "var(--chart-1)",
  }
  const NHAN: Record<string, string> = {
    "agy·gemini": "Antigravity · Gemini",
    "agy·third": "Antigravity · Claude/GPT",
    "kr·credits": "Kiro · Credits",
  }
  return [...keys].sort().map((k, i) => ({
    key: k,
    label: NHAN[k] ?? k.replace("·", " · "),
    color: MAU[k] ?? `var(--chart-${(i % 5) + 1})`,
  }))
}

const NHAN_KY: Record<string, string> = { "7d": "7 ngày", "30d": "30 ngày", "90d": "90 ngày" }

export interface QuotaHistoryProps {
  /** `null` = toàn pool. Bảng ở trang cha đặt giá trị này khi bấm vào một account. */
  email: string | null
  onClear: () => void
}

export function QuotaHistory({ email, onClear }: QuotaHistoryProps) {
  // Khoảng thời gian chỉ dùng ở đây nên giữ ở đây — trang cha không cần biết.
  const [range, setRange] = useState("7d")

  /** Lịch sử phụ thuộc (email, range) — đưa vào queryKey để đổi bộ lọc là tự nạp lại. */
  const q = useQuery({
    queryKey: ["quota-history", email, range],
    queryFn: () =>
      api.get<HistoryData>(
        "/api/gateway/quota/history" +
          (email ? `?email=${encodeURIComponent(email)}&range=${range}` : `?range=${range}`),
      ),
  })

  const data = q.data
  const series = xoay(data)
  const defs = duongVe(series)

  const provTomTat = data?.providers?.includes("agy") ? "agy" : data?.providers?.[0]
  const points: number[] = data?.series
    ? data.series.filter((x) => (x.provider ?? null) === (provTomTat ?? null)).map((x) => x.gemini ?? 0)
    : data?.points?.map((p) => p.gemini_pct ?? 0) ?? []

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium text-foreground flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
            {email ? `Xu hướng · ${email}` : "Xu hướng toàn pool"}
          </CardTitle>
          <div className="flex items-center gap-2">
            {email && (
              <Button size="sm" onClick={onClear} className="border border-border bg-transparent text-muted-foreground h-7 text-xs">
                Xem tất cả
              </Button>
            )}
            <Select value={range} onValueChange={(v) => setRange(v ?? "7d")}>
              <SelectTrigger className="h-7 w-24 text-xs">
                <span className="truncate">{NHAN_KY[range] ?? "7 ngày"}</span>
              </SelectTrigger>
              <SelectContent>
                {Object.entries(NHAN_KY).map(([v, n]) => (
                  <SelectItem key={v} value={v} className="text-xs">{n}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {series.length >= 2 ? (
          <TimeSeries data={series} xKey="t" height={200} series={defs} />
        ) : (
          <p className="py-8 text-center text-xs text-muted-foreground">
            {series.length === 1
              ? "Mới có 1 mốc thời gian — cần ít nhất 2 mốc mới vẽ được đường. Job nền nạp hạn mức mỗi 4 giờ."
              : "Chưa có dữ liệu. Bấm Refresh để nạp hạn mức — mỗi lần nạp ghi 1 điểm."}
          </p>
        )}
        {/*
          Xu hướng gần nhất + sparkline.

          Bản cũ có LOGIC NGƯỢC: `points` là phần trăm quota CÒN LẠI (pct cao là khoẻ),
          nhưng nó báo "Quota đang giảm" khi con số TĂNG. Người đọc thấy mũi tên đỏ đúng
          lúc hạn mức vừa hồi lại.

          Và mũi tên một mình không cho biết mức độ: giảm 1% với giảm 40% cùng một icon.
          Thêm sparkline để thấy hình dạng thật của xu hướng.
        */}
        {points.length >= 2 && (() => {
          const last = points[points.length - 1]!
          const prev = points[points.length - 2]!
          const up = last > prev
          const delta = Math.abs(Math.round(last - prev))
          return (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {up
                ? <TrendingUp className="h-3 w-3 text-success" />
                : <TrendingDown className="h-3 w-3 text-warning" />}
              <span>
                {provTomTat ? `${provTomTat}: ` : ""}
                {up ? "Hạn mức đang phục hồi" : "Hạn mức đang giảm"}
                {delta > 0 ? ` (${up ? "+" : "−"}${delta}%)` : " (không đổi)"}
              </span>
              <Sparkline data={points} tone={up ? "success" : "warning"} width={80} height={20} />
            </div>
          )
        })()}
      </CardContent>
    </Card>
  )
}
