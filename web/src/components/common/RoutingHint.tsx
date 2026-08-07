import { useQuery } from "@tanstack/react-query"
import { Lightbulb } from "lucide-react"
import { api } from "@/lib/api"
import { fmtAgo } from "@/lib/format"
import type { PoolAccount } from "@/lib/types"
import { POLL } from "@/lib/queryClient"
import { Card, CardContent } from "@/components/ui/card"

/**
 * Gợi ý định tuyến: bể quota nào còn nhiều nhất → nên ưu tiên model nào.
 *
 * Trả lời trực tiếp yêu cầu "nhìn vào pool sẽ lọc được và nên chọn model có nhiều
 * quota nhất" — thay vì bắt người dùng tự suy luận từ 700 dòng bảng.
 *
 * Hai bể ĐỘC LẬP (đo thật: cùng account Gemini 100% mà Claude 0%), nên phải tính
 * riêng từng bể chứ không gộp thành một con số "quota trung bình".
 */
export function RoutingHint() {
  const q = useQuery({
    queryKey: ["poolAccounts"],
    queryFn: () => api.get<{ accounts: PoolAccount[] }>("/api/gateway/accounts"),
    refetchInterval: POLL.live,
  })

  const accs = (q.data?.accounts ?? []).filter((a) => a.provider === "agy")
  if (!accs.length) return null

  const now = Date.now()
  /** Account dùng được cho MỘT bể cụ thể — cooldown riêng bể được tính vào đây. */
  const usableFor = (b: "gemini" | "claude") =>
    accs.filter(
      (a) =>
        a.enabled &&
        a.health !== "dead" &&
        (a.cooldownUntil ?? 0) <= now &&
        ((a.bucketCooldown?.[b] ?? 0) as number) <= now,
    )

  const stat = (b: "gemini" | "claude") => {
    const usable = usableFor(b)
    const pcts = usable
      .map((a) => (b === "gemini" ? a.geminiPct : a.claudePct))
      .filter((x): x is number => x != null)
    return {
      ready: usable.length,
      avg: pcts.length ? Math.round(pcts.reduce((s, x) => s + x, 0) / pcts.length) : null,
    }
  }

  const gem = stat("gemini")
  const cla = stat("claude")
  // Ưu tiên bể còn nhiều quota hơn; hoà thì chọn bể có nhiều account sẵn sàng hơn.
  const prefer =
    gem.avg == null || cla.avg == null
      ? gem.ready >= cla.ready ? "gemini" : "claude"
      : gem.avg >= cla.avg ? "gemini" : "claude"

  const freshest = Math.max(0, ...accs.map((a) => a.quotaFetchedAt ?? 0))

  const Row = ({ name, s, tone }: { name: string; s: ReturnType<typeof stat>; tone: string }) => (
    <div className="flex items-center gap-3">
      <span className="w-28 shrink-0 text-xs text-muted-foreground">{name}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-background">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${s.avg ?? 0}%` }} />
      </div>
      <span className="w-10 shrink-0 text-right text-xs tabular-nums">{s.avg == null ? "—" : `${s.avg}%`}</span>
      <span className="w-24 shrink-0 text-right text-xs text-muted-foreground">{s.ready} sẵn sàng</span>
    </div>
  )

  return (
    <Card className="border-border bg-card">
      <CardContent className="space-y-2.5 p-4">
        <div className="flex items-center gap-2">
          <Lightbulb className="h-4 w-4 text-[color:var(--warning)]" />
          <h3 className="text-sm font-medium text-foreground">Gợi ý định tuyến</h3>
          <span className="ml-auto text-xs text-muted-foreground">
            quota cập nhật {fmtAgo(freshest || undefined)} trước
          </span>
        </div>

        <Row name="Gemini" s={gem} tone="bg-primary" />
        <Row name="Claude + GPT" s={cla} tone="bg-[color:var(--success)]" />

        <p className="pt-1 text-xs text-muted-foreground">
          Nên ưu tiên model{" "}
          <span className="font-medium text-foreground">{prefer === "gemini" ? "Gemini" : "Claude / GPT"}</span> — bể này
          còn nhiều hạn mức hơn.
        </p>
      </CardContent>
    </Card>
  )
}
