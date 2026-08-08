/**
 * Đường xu hướng nhỏ trong thẻ KPI (kiểu Atlas).
 *
 * File này TÁCH RIÊNG khỏi `charts.tsx` một cách CÓ CHỦ ĐÍCH: `charts.tsx` import Recharts,
 * còn `KpiCard` (trong `common/index.tsx`) thì được mọi trang import qua barrel. Nếu Sparkline
 * nằm chung với Recharts thì mỗi trang dùng KpiCard sẽ kéo cả thư viện chart vào chunk khởi
 * động — đúng thứ cần tránh. Sparkline chỉ là một `<path>`, không cần thư viện gì.
 */

export function Sparkline({
  data,
  tone = "current",
  width = 72,
  height = 24,
  className,
}: {
  data: number[]
  /** `current` kế thừa màu chữ của thẻ; các tông khác đọc token chart ngữ nghĩa. */
  tone?: "current" | "success" | "warning" | "danger" | "info" | "muted"
  width?: number
  height?: number
  className?: string
}) {
  if (!data?.length || data.length < 2) return null

  const min = Math.min(...data)
  const max = Math.max(...data)
  // Dữ liệu phẳng (mọi giá trị bằng nhau) sẽ chia cho 0 → vẽ đường giữa cho gọn.
  const span = max - min || 1
  const stepX = width / (data.length - 1)
  // Chừa 1px trên/dưới để nét vẽ không bị cắt ở mép viewBox.
  const y = (v: number) => height - 1 - ((v - min) / span) * (height - 2)

  const d = data.map((v, i) => `${i === 0 ? "M" : "L"}${(i * stepX).toFixed(1)},${y(v).toFixed(1)}`).join(" ")

  const stroke =
    tone === "current"
      ? "currentColor"
      : `var(--chart-${tone === "danger" ? "danger" : tone})`

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path d={d} stroke={stroke} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
