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
  /** Bản vá dedupe Kiro — null khi OmniRoute ở máy khác. */
  va: { timThay: boolean; than: number; goi: number; daAp: boolean } | null
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
    // Backend nhận `target?: 'agy'|'kiro'` — đồng bộ riêng khi chỉ một bên lệch, khỏi chờ
    // cả hai (Kiro gọi lẻ từng credential nên mất vài phút).
    mutationFn: (target?: "agy" | "kiro") =>
      api.post<KetQuaSync>("/api/omniroute/sync", target ? { target } : {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["omniroute-status"] }),
  })

  const thu = useMutation({
    mutationFn: () => api.post<{ ok: boolean; url: string; connections?: number; loi?: string }>("/api/omniroute/test", {}),
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
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => thu.mutate()}
            disabled={thu.isPending}
            title="Thử kết nối và đếm lại connection (bỏ cookie đã cache)"
          >
            {thu.isPending ? "Đang thử…" : "Thử kết nối"}
          </Button>
          <Button size="sm" onClick={() => sync.mutate(undefined)} disabled={sync.isPending}>
            <RefreshCw className={`h-3.5 w-3.5 ${sync.isPending ? "animate-spin" : ""}`} />
            {sync.isPending ? "Đang đồng bộ…" : "Đồng bộ ngay"}
          </Button>
        </div>
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

      {/* Cảnh báo lệch đặt NGAY dưới hai KPI — đó là chỗ mắt nhìn đầu tiên. Trước đây chỉ
          đổi màu chữ ở dòng cuối card phía dưới, rất dễ lướt qua. */}
      {d?.ketNoi && tongAgy !== tongOmni ? (
        <Card className="border-warning/40 p-3">
          <div className="flex items-start gap-2.5">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <p className="text-sm">
              Lệch <span className="font-medium text-warning">{Math.abs(tongAgy - tongOmni)}</span>{" "}
              {tongAgy > tongOmni
                ? "credential chưa sang OmniRoute — bấm Đồng bộ ngay."
                : "connection thừa ở OmniRoute (credential cũ đã bị thay) — đồng bộ sẽ dọn."}
            </p>
          </div>
        </Card>
      ) : null}

      {/* Bản vá dedupe: thiếu nó thì hàng trăm account Kiro gộp thành 1 connection, mà API
          vẫn trả success từng cái — lỗi im lặng, chỉ lộ khi đếm. */}
      {d?.va && d.va.timThay && !d.va.daAp ? (
        <Card className="border-destructive/40 p-3">
          <div className="flex items-start gap-2.5">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium">Bản vá dedupe Kiro CHƯA áp</p>
              <p className="text-xs text-muted-foreground">
                Nhiều account Kiro sẽ gộp thành 1 connection. Chạy{" "}
                <code className="rounded bg-muted px-1">node tools/va-omniroute/va-dist.mjs "$(npm root -g)/omniroute"</code>{" "}
                rồi khởi động lại OmniRoute. (thân {d.va.than} · gọi {d.va.goi})
              </p>
            </div>
          </div>
        </Card>
      ) : null}

      <Card className="p-4">
        <div className="space-y-2.5">
          {CAP.map(({ nhan, agy, omni }) => {
            const ben = d?.agyproxy[agy] ?? 0
            const kia = d?.omniroute[omni] ?? 0
            const khop = ben === kia
            return (
              <div key={agy} className="flex items-center justify-between gap-3 text-sm">
                <span className="font-medium">
                  {nhan}
                  {!khop ? (
                    <button
                      type="button"
                      onClick={() => sync.mutate(agy === "agy" ? "agy" : "kiro")}
                      disabled={sync.isPending}
                      className="ml-2 text-xs text-muted-foreground underline hover:text-foreground disabled:opacity-50"
                    >
                      đồng bộ riêng
                    </button>
                  ) : null}
                </span>
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

          {/* Provider OmniRoute KHÔNG nằm trong CAP.
              Không render thì tổng lệch mà bảng chi tiết trông vẫn khớp hoàn toàn — gây
              hiểu nhầm chủ động, tệ hơn là không hiện gì. */}
          {Object.entries(d?.omniroute ?? {})
            .filter(([p]) => !CAP.some((c) => c.omni === p))
            .map(([p, n]) => (
              <div key={p} className="flex items-center justify-between gap-3 text-sm">
                <span className="font-medium text-muted-foreground">{p}</span>
                <span className="flex items-center gap-2 tabular-nums text-muted-foreground">
                  <span className="text-xs">(không do agy-proxy quản)</span>
                  <span>{n} ở OmniRoute</span>
                </span>
              </div>
            ))}
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
