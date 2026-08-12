import { useEffect, useState, useCallback } from "react"
import { api } from "@/lib/api"
import { RefreshCw } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { useToast } from "@/components/ui/toast"

/**
 * Tự tắt account cạn hạn mức, tự bật lại khi Google reset.
 *
 * Vì sao cần: đo thật trên pool 351 account — 66 cái quota 0% nằm lẫn với 203 cái còn
 * 100%. Chiến lược xoay vẫn chọn phải chúng, mỗi lần ~6 giây rồi 429; có request thử
 * 20 account liên tiếp mất hơn 2 phút rồi vẫn hỏng. Tắt chúng là bỏ khỏi vòng xoay.
 */
export function AutoDisablePanel({ onDone }: { onDone: () => void }) {
  const toast = useToast()
  const [cfg, setCfg] = useState<{ enabled: boolean; hour: number; offAtPct: number; onAtPct: number } | null>(null)
  const [saving, setSaving] = useState(false)
  const [sweeping, setSweeping] = useState(false)

  const load = useCallback(async () => {
    try {
      const j = await api.get<{ autoDisable?: NonNullable<typeof cfg> }>("/api/gateway/config")
      if (j.autoDisable) setCfg(j.autoDisable)
    } catch { /* panel tự ẩn khi không đọc được cấu hình */ }
  }, [])

  useEffect(() => { load() }, [load])

  const patch = async (v: Partial<NonNullable<typeof cfg>>) => {
    if (!cfg) return
    const next = { ...cfg, ...v }
    setCfg(next)
    setSaving(true)
    try {
      await api.patch("/api/gateway/config", {
        autoDisableEnabled: next.enabled,
        autoDisableHour: next.hour,
        autoDisableOffPct: next.offAtPct,
        autoDisableOnPct: next.onAtPct,
      })
    } catch (e) {
      // Bản cũ chỉ có `finally` — lưu hỏng thì giao diện vẫn hiện giá trị mới như đã lưu.
      toast({ title: "Lưu cấu hình thất bại", description: String(e instanceof Error ? e.message : e).slice(0, 120), variant: "error" })
      load()
    } finally { setSaving(false) }
  }

  const sweep = async () => {
    setSweeping(true)
    try {
      // Vòng quét đụng cả pool nên có thể mất vài phút — báo trước để không ai tưởng treo.
      toast({ title: "Đang quét cả pool…", description: "Có thể mất vài phút với pool lớn" })
      // CỐ Ý `fetch` trần: cần đọc CẢ `!r.ok` lẫn `j.ok` — endpoint trả 200 kèm
      // `{ok:false, error}` khi vòng quét không chạy được. `api` sẽ ném và mất `j.error`.
      const r = await fetch("/api/gateway/quota/sweep", { method: "POST" })
      const j = await r.json()
      if (!r.ok || !j.ok) {
        toast({ title: "Quét không chạy", description: j.error ?? `HTTP ${r.status}`, variant: "error" })
      } else {
        toast({
          title: "Quét xong",
          description: `${j.checked} account · tắt ${j.disabled} · bật lại ${j.enabled} · bỏ qua ${j.skipped}`,
          variant: "success",
        })
        onDone()
      }
    } catch (e) {
      toast({ title: "Lỗi", description: e instanceof Error ? e.message : String(e), variant: "error" })
    } finally { setSweeping(false) }
  }

  if (!cfg) return null

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-3 p-3">
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={cfg.enabled} onCheckedChange={(v) => patch({ enabled: !!v })} disabled={saving} />
          <span className="font-medium text-foreground">Tự tắt account cạn hạn mức</span>
        </label>

        {cfg.enabled && (
          <>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              tắt khi ≤
              <input
                type="number" min={0} max={99} value={cfg.offAtPct}
                onChange={(e) => patch({ offAtPct: Math.max(0, Number(e.target.value) || 0) })}
                className="h-7 w-16 rounded-md border border-border bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />%
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              bật lại khi ≥
              <input
                type="number" min={1} max={100} value={cfg.onAtPct}
                onChange={(e) => patch({ onAtPct: Math.max(1, Number(e.target.value) || 1) })}
                className="h-7 w-16 rounded-md border border-border bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />%
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              chạy lúc
              <input
                type="number" min={0} max={23} value={cfg.hour}
                onChange={(e) => patch({ hour: Math.min(23, Math.max(0, Number(e.target.value) || 0)) })}
                className="h-7 w-14 rounded-md border border-border bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />h
            </label>
          </>
        )}

        <Button
          size="sm" onClick={sweep} disabled={sweeping}
          className="ml-auto h-8 gap-1.5 border border-border bg-transparent text-xs text-muted-foreground hover:text-foreground"
          title="Chạy ngay, không đợi tới giờ hẹn"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${sweeping ? "animate-spin" : ""}`} />
          {sweeping ? "Đang quét…" : "Quét ngay"}
        </Button>

        <p className="w-full text-[11px] text-muted-foreground">
          {cfg.enabled
            ? `Quét cả pool lúc ${cfg.hour}h hằng ngày. Ngưỡng bật (${cfg.onAtPct}%) cao hơn ngưỡng tắt (${cfg.offAtPct}%) để account dao động quanh mốc không bật/tắt liên tục.`
            : "Đang tắt — account cạn hạn mức vẫn nằm trong vòng xoay và sẽ bị chọn rồi trả 429."}
        </p>
      </CardContent>
    </Card>
  )
}
