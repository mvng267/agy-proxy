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
  /** Cài kiểu gì: `git` → pull + build; `npm` → `npm i -g github:…`. */
  kieu?: "git" | "npm"
  /**
   * Bản mới được nhận ra bằng COMMIT, không phải version.
   *
   * Version là thứ hay quên bump: đo 12/08/2026, 8 commit gần nhất — kể cả bản vá vòng
   * quota tắc 28 giờ — đều giữ nguyên `2.18.1`, nên thẻ này báo "đã là bản mới nhất"
   * suốt trong khi thiếu 8 commit.
   */
  localSha: string | null
  remoteSha: string | null
  behind: number | null
  commits: string[]
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
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Download className="h-4 w-4 text-muted-foreground" /> Phiên bản
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-foreground">
            Đang chạy <span className="font-mono text-foreground">v{d?.current ?? "…"}</span>
          </span>

          {q.isLoading ? (
            <span className="text-xs text-muted-foreground">đang kiểm tra…</span>
          ) : d?.error ? (
            <span className="text-xs text-warning">không kiểm tra được: {d.error.slice(0, 60)}</span>
          ) : d?.hasUpdate ? (
            <span className="rounded-md bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">
              {d.behind ? `thiếu ${d.behind} commit` : "có bản mới"}
              {d.latest && d.latest !== d.current ? ` · v${d.latest}` : ""}
            </span>
          ) : (
            <span className="text-xs text-success">đã là bản mới nhất</span>
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
            {d?.hasUpdate ? (
              <Button size="sm" onClick={doUpdate} disabled={running} className="h-8 gap-1 text-xs">
                {running ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                {running ? "Đang cập nhật…" : "Cập nhật ngay"}
              </Button>
            ) : null}
          </div>
        </div>

        {/*
          CẢ HAI kiểu cài đều tự cập nhật được — chỉ khác cách làm, nên nói rõ sẽ chạy gì.

          Bản trước ẩn hẳn nút khi không phải git checkout (`canSelfUpdate` = có `.git`),
          nghĩa là mọi máy cài bằng `npm i -g` đều mất nút Cập nhật.
        */}
        {d?.hasUpdate && d.kieu === "npm" ? (
          <p className="text-xs text-muted-foreground">
            Bản cài từ npm — sẽ chạy{" "}
            <code className="rounded bg-muted px-1 text-foreground">npm i -g github:mvng267/agy-proxy</code>
          </p>
        ) : null}

        {/*
          Cho biết SẮP CÀI GÌ trước khi bấm. Bản trước chỉ hiện số version, mà version lại
          hay không đổi — người dùng không có cách nào biết mình đang thiếu những gì.
        */}
        {d?.hasUpdate && d.commits?.length && !steps.length ? (
          <ul className="space-y-0.5 rounded-md border border-border bg-background/60 p-2 text-xs text-muted-foreground">
            {d.commits.map((c) => (
              <li key={c} className="truncate font-mono">
                {c}
              </li>
            ))}
            {d.behind && d.behind > d.commits.length ? (
              <li className="text-muted-foreground">… và {d.behind - d.commits.length} commit nữa</li>
            ) : null}
          </ul>
        ) : null}

        {done ? <p className="text-xs text-foreground">{done}</p> : null}

        {steps.length ? (
          <div className="space-y-1 rounded-md border border-border bg-background/60 p-2">
            {steps.map((s, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                {s.ok ? (
                  <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-success" />
                ) : (
                  <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />
                )}
                <span className="w-28 shrink-0 text-muted-foreground">{s.step}</span>
                <span className="min-w-0 flex-1 break-words text-muted-foreground">{s.detail}</span>
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
