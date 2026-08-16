import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"

/**
 * Chi tiết MỘT phiên: nội dung gửi/nhận + mọi bước đã đi qua.
 *
 * Vì sao cần: log đang PHẲNG. Một request client sinh N dòng `gateway_usage` (mỗi bước
 * combo một dòng, cùng `requestId`), nên một request thử 7 account hiện thành 7 dòng rời
 * rạc — không thấy chúng là cùng một việc.
 *
 * Đo trên production: **12% request phải thử nhiều account, nhiều nhất 7 lần cho một
 * request**. Toàn bộ quan hệ đó đang vô hình.
 *
 * Nội dung gửi/nhận chỉ có khi `sessionBodyMode` khác `off` VÀ phiên thoả điều kiện ghi
 * (mặc định `error` = chỉ ghi khi lỗi). Phiên cũ hơn lúc bật tính năng thì không có —
 * nói rõ điều đó thay vì hiện ô trống khó hiểu.
 */

interface BuocPhien {
  ts: number
  email: string
  model: string
  ok: number
  ms: number
  status?: number | null
  err?: string | null
}

interface ThanPhien {
  reqBody?: string | null
  resBody?: string | null
  truncated: boolean
  bytes: number
}

interface PhienResponse {
  requestId: string
  than: ThanPhien | null
  buoc: BuocPhien[]
  tongMs: number
}

/** JSON đọc được: thụt lề nếu parse được, giữ nguyên nếu không. */
function dep(s?: string | null): string {
  if (!s) return ""
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}

function fmtKb(b: number): string {
  return b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`
}

function Khoi({ nhan, noiDung }: { nhan: string; noiDung: string }) {
  if (!noiDung) return null
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1 text-[0.6875rem] uppercase tracking-wide text-muted-foreground">{nhan}</div>
      <pre className="max-h-72 overflow-auto rounded-md bg-muted/50 p-2.5 text-[11px] leading-relaxed">
        {noiDung}
      </pre>
    </div>
  )
}

export function ChiTietPhien({ requestId }: { requestId: string }) {
  const q = useQuery({
    queryKey: ["phien", requestId],
    queryFn: () => api.get<PhienResponse>(`/api/gateway/usage/session/${encodeURIComponent(requestId)}`),
    staleTime: 5 * 60_000,
  })

  if (q.isLoading) return <div className="px-2 py-3 text-xs text-muted-foreground">Đang tải…</div>
  if (q.error) {
    return (
      <div className="px-2 py-3 text-xs text-destructive">
        Không tải được phiên: {String(q.error instanceof Error ? q.error.message : q.error).slice(0, 120)}
      </div>
    )
  }

  const d = q.data
  if (!d) return null
  const nhieuBuoc = d.buoc.length > 1

  return (
    <div className="space-y-3 px-2 py-3">
      {/* Đường đi — thứ log phẳng đang giấu hoàn toàn */}
      <div>
        <div className="mb-1.5 text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
          {nhieuBuoc ? `Đã thử ${d.buoc.length} lần · tổng ${(d.tongMs / 1000).toFixed(1)}s` : "Một lần gọi"}
        </div>
        <div className="space-y-1">
          {d.buoc.map((b, i) => (
            <div key={`${b.ts}-${b.email}-${i}`} className="flex items-center gap-2 text-xs">
              <span className="w-5 shrink-0 text-right tabular-nums text-muted-foreground">{i + 1}.</span>
              <span
                className={`w-14 shrink-0 tabular-nums ${
                  b.ok ? "text-[color:var(--success)]" : "text-destructive"
                }`}
              >
                {b.ok ? "OK" : b.status ?? "lỗi"}
              </span>
              <span className="w-48 shrink-0 truncate">{b.model}</span>
              <span className="w-40 shrink-0 truncate text-muted-foreground">{b.email.split("@")[0]}</span>
              <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
                {b.ms >= 1000 ? `${(b.ms / 1000).toFixed(1)}s` : `${b.ms}ms`}
              </span>
              {b.err ? (
                <span className="min-w-0 flex-1 truncate text-muted-foreground" title={b.err}>
                  {b.err}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      {/* Nội dung — chỉ có khi đã bật ghi và phiên thoả điều kiện */}
      {d.than ? (
        <>
          <div className="flex flex-col gap-3 @2xl:flex-row">
            <Khoi nhan="Gửi đi" noiDung={dep(d.than.reqBody)} />
            <Khoi nhan="Nhận về" noiDung={dep(d.than.resBody)} />
          </div>
          <p className="text-[11px] text-muted-foreground">
            {fmtKb(d.than.bytes)} gốc
            {d.than.truncated ? " · đã cắt bớt phần giữa để vừa trần lưu trữ" : ""}
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          Không lưu nội dung phiên này. Mặc định chỉ ghi phiên <b>lỗi</b> — đổi ở
          Cấu hình → “Lưu nội dung phiên”.
        </p>
      )}
    </div>
  )
}
