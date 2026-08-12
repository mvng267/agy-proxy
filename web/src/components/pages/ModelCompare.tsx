import { useEffect, useMemo, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Play, Square, X, Download, Trophy, Timer } from "lucide-react"
import { api } from "@/lib/api"
import { ModelSelect } from "@/components/common/ModelSelect"
import { fmtNum } from "@/lib/format"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

/**
 * Cùng một prompt, nhiều model, chạy SONG SONG.
 *
 * Chọn model nào cho việc gì là câu hỏi phải trả lời bằng cách thử — nhưng thử tuần tự
 * ở màn Chat rồi nhớ trong đầu thì không so được: mỗi lượt một ngữ cảnh, và độ trễ đo
 * được lẫn với thời gian mình gõ. Ở đây gửi đồng thời rồi bày cạnh nhau, kèm thời gian
 * và token để thấy đánh đổi giữa chất lượng và chi phí.
 */

interface Model {
  id: string
  label?: string
  providerLabel?: string
  imageOut?: boolean
}

interface Ket {
  model: string
  ok: boolean
  text?: string
  images?: string[]
  account?: string
  ms: number
  tokens?: number
  error?: string
  /** Combo: bước thật sự trả lời — so combo với model đơn thì cần biết nó rơi vào đâu. */
  resolvedModel?: string
  steps?: Array<{ model: string; ok: boolean; ms: number; error?: string }>
}

/** Bao nhiêu model một lượt. Trần thấp có chủ đích: mỗi model là một request thật tốn quota. */
const MAX_CHON = 6

export function ModelCompare() {
  const [chon, setChon] = useState<string[]>([])
  const [prompt, setPrompt] = useState("")
  const [maxTokens, setMaxTokens] = useState(2000)
  const [dangChay, setDangChay] = useState(false)
  const [ket, setKet] = useState<Ket[]>([])
  const [zoom, setZoom] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const models = useQuery({
    queryKey: ["models"],
    queryFn: () => api.get<{ models: Model[] }>("/api/gateway/models"),
  })
  const list = models.data?.models ?? []

  useEffect(() => {
    // Mồi sẵn hai model để bấm Gửi là chạy được ngay, không phải cấu hình trước.
    if (list.length >= 2 && chon.length === 0) setChon([list[0].id, list[1].id])
  }, [list]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!zoom) return
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setZoom(null) }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [zoom])

  const them = (id: string | null) => {
    if (!id || chon.includes(id) || chon.length >= MAX_CHON) return
    setChon((p) => [...p, id])
  }

  const chay = async () => {
    const p = prompt.trim()
    if (!p || chon.length === 0 || dangChay) return
    setDangChay(true)
    setKet([])
    const ctrl = new AbortController()
    abortRef.current = ctrl

    /**
     * Song song thật, KHÔNG tuần tự: so độ trễ mà chạy lần lượt thì model sau bị tính
     * cả thời gian chờ model trước. Mỗi lượt tự bắt lỗi để một model hỏng không kéo
     * đổ cả bảng — Promise.all sẽ reject toàn bộ ngay ở lỗi đầu tiên.
     */
    const jobs = chon.map(async (m): Promise<Ket> => {
      const t0 = Date.now()
      try {
        const r = await fetch("/api/gateway/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({ model: m, content: p, maxTokens }),
        })
        const j = await r.json()
        if (!r.ok || j.ok === false) {
          return { model: m, ok: false, ms: Date.now() - t0, error: j.error ?? `HTTP ${r.status}` }
        }
        return {
          model: m,
          ok: true,
          text: j.text ?? "",
          images: j.images ?? [],
          account: j.account,
          ms: j.ms ?? Date.now() - t0,
          tokens: j.usage?.totalTokens,
          resolvedModel: j.resolvedModel,
          steps: j.steps,
        }
      } catch (e) {
        const huy = e instanceof DOMException && e.name === "AbortError"
        return { model: m, ok: false, ms: Date.now() - t0, error: huy ? "Đã huỷ" : String(e) }
      }
    })

    // Hiện dần từng kết quả thay vì chờ model chậm nhất — model nhanh xem được ngay.
    for (const job of jobs) job.then((k) => setKet((prev) => [...prev, k]))
    await Promise.allSettled(jobs)
    abortRef.current = null
    setDangChay(false)
  }

  // Nhanh nhất trong số THÀNH CÔNG. Model lỗi thường trả rất nhanh — trao giải cho nó
  // là kết luận ngược hẳn với sự thật.
  const nhanhNhat = useMemo(() => {
    const ok = ket.filter((k) => k.ok)
    return ok.length > 1 ? ok.reduce((a, b) => (a.ms <= b.ms ? a : b)).model : null
  }, [ket])

  const conLai = list.filter((m) => !chon.includes(m.id))

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Cùng một prompt gửi tới nhiều model cùng lúc, kết quả bày cạnh nhau kèm thời gian và
        token — để chọn model theo số đo, không theo cảm giác.
      </p>

      <Card>
        <CardContent className="space-y-3 p-3">
          {/* Model đã chọn */}
          <div className="flex flex-wrap items-center gap-1.5">
            {chon.map((m) => (
              <button
                key={m}
                onClick={() => setChon((p) => p.filter((x) => x !== m))}
                className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs transition-colors hover:bg-border"
              >
                {m} <X className="h-3 w-3" />
              </button>
            ))}

            {chon.length < MAX_CHON && conLai.length > 0 && (
              <ModelSelect
                value=""
                onChange={them}
                exclude={chon}
                placeholder="+ Thêm model"
                className="h-7 w-44 text-xs"
              />
            )}

            <span className="ml-1 text-xs text-muted-foreground">
              {chon.length}/{MAX_CHON}
            </span>
          </div>

          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); chay() } }}
            placeholder="Nhập prompt gửi cho tất cả model đã chọn… (Ctrl+Enter để gửi)"
            rows={3}
            className="w-full resize-none rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />

          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              max_tokens
              <input
                type="number"
                min={1}
                value={maxTokens}
                onChange={(e) => setMaxTokens(Math.max(1, Number(e.target.value) || 1))}
                className="h-7 w-20 rounded-md border border-border bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </label>
            <span className="text-xs text-muted-foreground">Ctrl+Enter để gửi</span>

            <div className="ml-auto">
              {dangChay ? (
                <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => abortRef.current?.abort()}>
                  <Square className="h-3 w-3" /> Huỷ
                </Button>
              ) : (
                <Button size="sm" className="h-8 gap-1.5" disabled={!prompt.trim() || chon.length === 0} onClick={chay}>
                  <Play className="h-3 w-3" /> Gửi {chon.length} model
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Kết quả */}
      {(ket.length > 0 || dangChay) && (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {chon.map((m) => {
            const k = ket.find((x) => x.model === m)
            return (
              <Card key={m} className="flex flex-col">
                <CardContent className="flex flex-1 flex-col gap-2 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-medium" title={m}>
                      {m.split("/").pop()}
                    </span>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {nhanhNhat === m && (
                        <Badge className="bg-success/15 text-[color:var(--success)]" title="Nhanh nhất trong các model trả về thành công">
                          <Trophy className="mr-0.5 h-2.5 w-2.5" /> nhanh nhất
                        </Badge>
                      )}
                      {k && (
                        <span className="flex items-center gap-1 text-[10px] tabular-nums text-muted-foreground">
                          <Timer className="h-3 w-3" />
                          {k.ms >= 1000 ? `${(k.ms / 1000).toFixed(1)}s` : `${k.ms}ms`}
                        </span>
                      )}
                    </div>
                  </div>

                  {!k ? (
                    <div className="flex flex-1 items-center justify-center py-8">
                      <span className="text-xs text-muted-foreground">Đang gọi…</span>
                    </div>
                  ) : k.ok ? (
                    <>
                      {k.text ? (
                        <pre className="max-h-72 flex-1 overflow-auto whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 font-sans text-sm leading-relaxed">
                          {k.text}
                        </pre>
                      ) : null}

                      {!!k.images?.length && (
                        <div className="flex flex-wrap gap-2">
                          {k.images.map((src, i) => (
                            <div key={i} className="group relative">
                              <img
                                src={src}
                                alt={`${m} — ảnh ${i + 1}`}
                                onClick={() => setZoom(src)}
                                className="max-h-48 cursor-zoom-in rounded-lg border border-border object-contain"
                              />
                              <a
                                href={src}
                                download={`${m.split("/").pop()}-${i + 1}.png`}
                                aria-label="Tải ảnh về"
                                className="absolute right-1.5 top-1.5 rounded-md bg-background/80 p-1.5 opacity-0 transition-opacity group-hover:opacity-100"
                              >
                                <Download className="h-3.5 w-3.5" />
                              </a>
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-2 text-[10px] text-muted-foreground">
                        {/* Combo trả lời bằng model NÀO — so combo với model đơn mà không
                            biết nó rơi vào bước nào thì phép so vô nghĩa. */}
                        {k.resolvedModel && k.resolvedModel !== k.model && (
                          <span
                            className="rounded bg-info/15 px-1.5 py-0.5 text-info"
                            title={k.steps?.map((s) => `${s.ok ? "✓" : "✗"} ${s.model}${s.error ? ` — ${s.error}` : ""}`).join("\n")}
                          >
                            → {k.resolvedModel.split("/").pop()}
                            {k.steps && k.steps.length > 1 ? ` (bước ${k.steps.length})` : ""}
                          </span>
                        )}
                        {k.account && <span>{k.account.split("@")[0]}</span>}
                        {k.tokens ? <span>· {fmtNum(k.tokens)} token</span> : null}
                      </div>
                    </>
                  ) : (
                    <div className="flex-1 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2">
                      <p className="text-xs text-destructive">{k.error}</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {zoom && (
        <div
          onClick={() => setZoom(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Xem ảnh phóng to"
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 p-6"
        >
          <img src={zoom} alt="Ảnh phóng to" className="max-h-full max-w-full rounded-xl object-contain" />
          <button
            onClick={() => setZoom(null)}
            aria-label="Đóng"
            className="absolute right-4 top-4 rounded-lg bg-muted p-2 text-foreground transition-colors hover:bg-border"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  )
}
