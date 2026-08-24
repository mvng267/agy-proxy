import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { RefreshCw, Plug, TriangleAlert } from "lucide-react"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { KpiCard } from "@/components/common"

/**
 * Kết nối OmniRoute — gateway thứ hai chạy song song.
 *
 * agy-proxy là nơi đăng nhập và giữ credential; OmniRoute cần bản sao để tự phục vụ. Hai hệ
 * KHÔNG tự nối nhau, nên trang này trả lời đúng một câu hỏi: **OmniRoute đang có đủ
 * credential như agy-proxy chưa**, và cho đẩy sang khi lệch.
 *
 * Đồng bộ vốn đã tự chạy (sau mỗi lần đăng nhập + định kỳ theo `omnirouteSyncMin`); nút ở
 * đây chỉ để ép chạy ngay khi không muốn đợi.
 */

interface TrangThai {
  bat: boolean
  url: string
  ketNoi: boolean
  loi?: string
  omniroute: Record<string, number>
  agyproxy: Record<string, number>
}

interface KetQuaSync {
  ok: boolean
  boQua?: boolean
  chiTiet: string
  ketQua: Array<{ email: string; target: string; ok: boolean; loi?: string }>
}

/** `agy` ở agy-proxy tương ứng `antigravity` ở OmniRoute — cùng một thứ, khác tên. */
const CAP: Array<{ nhan: string; agy: string; omni: string }> = [
  { nhan: "Antigravity", agy: "agy", omni: "antigravity" },
  { nhan: "Kiro", agy: "kiro", omni: "kiro" },
]

export function Connections() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ["omniroute-status"],
    queryFn: () => api.get<TrangThai>("/api/omniroute/status"),
    refetchInterval: 30_000,
  })

  const sync = useMutation({
    mutationFn: () => api.post<KetQuaSync>("/api/omniroute/sync", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["omniroute-status"] }),
  })

  const d = q.data

  if (q.isLoading) {
    return <div className="py-8 text-sm text-muted-foreground">Đang tải…</div>
  }

  if (d && !d.bat) {
    return (
      <Card className="p-6">
        <div className="flex items-start gap-3">
          <Plug className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="space-y-1">
            <p className="text-sm font-medium">Chưa bật đồng bộ OmniRoute</p>
            <p className="text-sm text-muted-foreground">
              Đặt <b>Mật khẩu OmniRoute</b> ở tab Chung → nhóm OmniRoute. Để trống là tắt hẳn —
              agy-proxy không gọi sang và không ghi cảnh báo.
            </p>
          </div>
        </div>
      </Card>
    )
  }

  const tongAgy = Object.values(d?.agyproxy ?? {}).reduce((a, b) => a + b, 0)
  const tongOmni = Object.values(d?.omniroute ?? {}).reduce((a, b) => a + b, 0)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {d?.url}
          {d?.ketNoi ? "" : " · không kết nối được"}
        </p>
        <Button size="sm" onClick={() => sync.mutate()} disabled={sync.isPending}>
          <RefreshCw className={`h-3.5 w-3.5 ${sync.isPending ? "animate-spin" : ""}`} />
          {sync.isPending ? "Đang đồng bộ…" : "Đồng bộ ngay"}
        </Button>
      </div>

      {d && !d.ketNoi && d.loi ? (
        <Card className="p-4">
          <div className="flex items-start gap-2.5">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium">Không đọc được trạng thái OmniRoute</p>
              <p className="break-words text-xs text-muted-foreground">{d.loi}</p>
            </div>
          </div>
        </Card>
      ) : null}

      <div className="@container">
        <div className="grid gap-3 @2xl:grid-cols-2">
          <KpiCard label="Credential ở agy-proxy" value={String(tongAgy)} />
          <KpiCard label="Connection ở OmniRoute" value={String(tongOmni)} />
        </div>
      </div>

      <Card className="p-4">
        <div className="space-y-2.5">
          {CAP.map(({ nhan, agy, omni }) => {
            const ben = d?.agyproxy[agy] ?? 0
            const kia = d?.omniroute[omni] ?? 0
            const khop = ben === kia
            return (
              <div key={agy} className="flex items-center justify-between gap-3 text-sm">
                <span className="font-medium">{nhan}</span>
                <span className="flex items-center gap-2 tabular-nums">
                  <span className="text-muted-foreground">{ben} ở đây</span>
                  <span className="text-muted-foreground">→</span>
                  <span className={khop ? "text-[color:var(--success)]" : "text-warning"}>
                    {kia} ở OmniRoute
                  </span>
                </span>
              </div>
            )
          })}
        </div>
      </Card>

      {sync.data ? (
        <Card className="p-4">
          <p className="mb-2 text-sm font-medium">Lần đồng bộ vừa rồi: {sync.data.chiTiet}</p>
          {sync.data.ketQua.filter((r) => !r.ok).length ? (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {sync.data.ketQua
                .filter((r) => !r.ok)
                .slice(0, 10)
                .map((r) => (
                  <li key={`${r.email}-${r.target}`} className="truncate">
                    ✗ {r.email.split("@")[0]} · {r.target} → {r.loi}
                  </li>
                ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">Không có lỗi nào.</p>
          )}
        </Card>
      ) : null}

      {sync.error ? (
        <p className="text-sm text-destructive">
          {sync.error instanceof Error ? sync.error.message : String(sync.error)}
        </p>
      ) : null}
    </div>
  )
}
