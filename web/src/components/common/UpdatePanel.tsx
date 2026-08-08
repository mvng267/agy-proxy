import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { CheckCircle2, Download, RefreshCw, XCircle } from "lucide-react"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

/**
 * Kiểm tra + cài bản mới ngay trên dashboard.
 *
 * Trước đây chỉ có `agyproxy update` trên CLI, nghĩa là muốn cập nhật phải SSH vào máy
 * chủ. Backend dùng chung đúng luồng đó (src/updater.ts), không có bản thứ hai.
 */

interface UpdateInfo {
  current: string
  latest: string | null
  hasUpdate: boolean
  canSelfUpdate: boolean
  error?: string
}
interface Step {
  step: string
  ok: boolean
  detail?: string
}

export function UpdatePanel() {
  const [steps, setSteps] = useState<Step[]>([])
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState<string | null>(null)

  const q = useQuery({
    queryKey: ["systemUpdate"],
    queryFn: () => api.get<UpdateInfo>("/api/system/update"),
    // Không poll: mỗi lần hỏi là một request ra GitHub, và bản mới không xuất hiện
    // theo phút. Người dùng bấm "Kiểm tra lại" khi cần.
    refetchOnWindowFocus: false,
    staleTime: 5 * 60_000,
  })

  const d = q.data

  const doUpdate = async () => {
    if (!confirm("Cài bản mới rồi khởi động lại? Dashboard sẽ mất kết nối vài giây.")) return
    setRunning(true)
    setSteps([])
    setDone(null)
    try {
      const r = await api.post<{ ok: boolean; steps: Step[]; restarting?: boolean }>("/api/system/update", {})
      setSteps(r.steps ?? [])
      if (r.ok && r.restarting) {
        setDone("Đã cài xong — đang khởi động lại, trang sẽ tự tải lại…")
        // Server thoát sau 1.5s rồi service dựng lại; chờ dư rồi mới reload.
        setTimeout(() => window.location.reload(), 9000)
      } else if (r.ok) {
        setDone("Đã cài xong. Khởi động lại để áp dụng.")
      } else {
        setDone("Cập nhật không hoàn tất — xem chi tiết bên dưới.")
      }
    } catch (e) {
      setDone(`Lỗi: ${(e as Error).message}`)
    } finally {
      setRunning(false)
    }
  }

  return (
    <Card className="bg-slate-900 border-slate-800">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-300">
          <Download className="h-4 w-4 text-slate-500" /> Phiên bản
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-slate-300">
            Đang chạy <span className="font-mono text-slate-100">v{d?.current ?? "…"}</span>
          </span>

          {q.isLoading ? (
            <span className="text-xs text-slate-500">đang kiểm tra…</span>
          ) : d?.error ? (
            <span className="text-xs text-amber-400">không kiểm tra được: {d.error.slice(0, 60)}</span>
          ) : d?.hasUpdate ? (
            <span className="rounded-md bg-orange-500/15 px-2 py-0.5 text-xs font-medium text-orange-400">
              có bản mới v{d.latest}
            </span>
          ) : (
            <span className="text-xs text-emerald-400">đã là bản mới nhất</span>
          )}

          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => q.refetch()}
              disabled={q.isFetching || running}
              className="h-8 gap-1 text-xs"
            >
              <RefreshCw className={`h-3 w-3 ${q.isFetching ? "animate-spin" : ""}`} />
              Kiểm tra lại
            </Button>
            {d?.hasUpdate && d.canSelfUpdate ? (
              <Button size="sm" onClick={doUpdate} disabled={running} className="h-8 gap-1 text-xs">
                {running ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                {running ? "Đang cập nhật…" : `Cập nhật lên v${d.latest}`}
              </Button>
            ) : null}
          </div>
        </div>

        {/* Bản cài không phải git thì nút cập nhật vô dụng — nói rõ phải làm gì thay thế. */}
        {d?.hasUpdate && !d.canSelfUpdate ? (
          <p className="text-xs text-slate-500">
            Bản cài này không phải git checkout nên không tự cập nhật được. Chạy trên máy chủ:{" "}
            <code className="rounded bg-slate-800 px-1 text-slate-300">agyproxy update</code>
          </p>
        ) : null}

        {done ? <p className="text-xs text-slate-300">{done}</p> : null}

        {steps.length ? (
          <div className="space-y-1 rounded-md border border-slate-800 bg-slate-950/60 p-2">
            {steps.map((s, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                {s.ok ? (
                  <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" />
                ) : (
                  <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-red-500" />
                )}
                <span className="w-28 shrink-0 text-slate-400">{s.step}</span>
                <span className="min-w-0 flex-1 break-words text-slate-500">{s.detail}</span>
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
