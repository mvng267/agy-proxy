import { useEffect, useState, useRef, useCallback } from "react"
import {
  MessageSquare,
  Send,
  AlertTriangle,
  Loader2,
  Bot,
  User,
  Trash2,
  RefreshCw,
  ChevronDown,
  ImagePlus,
  SlidersHorizontal,
  Download,
  X,
} from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

// ── Types ──────────────────────────────────────────────────────────────

interface Model {
  id: string
  label?: string
  provider?: string
  providerLabel?: string
  bucket?: string
  /** Nhận được ảnh trong prompt. `image` cũ mang hai nghĩa nên không dùng nữa. */
  imageIn?: boolean
  /** Sinh ra được ảnh. */
  imageOut?: boolean
}

interface AccountEntry {
  email: string
  enabled?: boolean
  provider?: string
}

interface ProxyEntry {
  label: string
}

interface ChatResponse {
  ok: boolean
  model?: string
  account?: string
  ms?: number
  usage?: { totalTokens?: number; promptTokens?: number; completionTokens?: number }
  text?: string
  images?: string[]
  error?: string
  /** Combo: bước THẬT SỰ trả lời — combo có thể trượt vài bước trước đó. */
  resolvedModel?: string
  /** Vết từng bước combo: bước nào trượt và vì sao. */
  steps?: Array<{ model: string; ok: boolean; ms: number; error?: string }>
}

interface ChatMessage {
  role: "user" | "assistant"
  content: string
  /**
   * Ảnh của tin nhắn — data URI.
   *  - assistant: ảnh model SINH ra (backend trả sẵn ở `images`, bản trước bỏ qua)
   *  - user: ảnh người dùng đính kèm để model xem
   */
  images?: string[]
  // Metadata for assistant messages
  meta?: {
    model?: string
    account?: string
    ms?: number
    tokens?: number
    /** Combo: bước thật sự trả lời, khác `model` khi combo trượt bước đầu. */
    resolvedModel?: string
    steps?: Array<{ model: string; ok: boolean; ms: number; error?: string }>
  }
  error?: boolean
}

// ── Simple select ──────────────────────────────────────────────────────

function NativeSelect({
  value,
  onChange,
  children,
  disabled,
  className,
}: {
  value: string
  onChange: (v: string) => void
  children: React.ReactNode
  disabled?: boolean
  className?: string
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={`appearance-none h-8 px-2 pr-7 rounded-md bg-muted border border-border text-foreground text-xs focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 ${className ?? ""}`}
      >
        {children}
      </select>
      <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
    </div>
  )
}

// ── Chat Page ───────────────────────────────────────────────────────────

export function Chat() {
  const [models, setModels] = useState<Model[]>([])
  const [accounts, setAccounts] = useState<AccountEntry[]>([])
  const [proxies, setProxies] = useState<ProxyEntry[]>([])
  const [loadingData, setLoadingData] = useState(true)

  const [selectedModel, setSelectedModel] = useState("")
  const [selectedAccount, setSelectedAccount] = useState("auto")
  const [selectedProxy, setSelectedProxy] = useState("")

  const [prompt, setPrompt] = useState("")
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** Ảnh đính kèm cho lượt sắp gửi (data URI). */
  const [attached, setAttached] = useState<string[]>([])
  /**
   * max_tokens mặc định 2000, KHÔNG để trống.
   * Đo thật: với model reasoning, max_tokens thấp (vd 20) bị phần suy nghĩ tiêu hết,
   * client nhận `content` RỖNG kèm finish_reason "length" — trông y như model hỏng.
   */
  const [maxTokens, setMaxTokens] = useState(2000)
  const [temperature, setTemperature] = useState(1)
  const [showParams, setShowParams] = useState(false)
  /** Ảnh đang phóng to. */
  const [zoom, setZoom] = useState<string | null>(null)

  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  /** Cho phép huỷ giữa chừng: failover có thể thử 3 account × 180s ≈ 9 phút. */
  const abortRef = useRef<AbortController | null>(null)

  // ── Load selectors data ────────────────────────────────────────────

  const loadData = useCallback(async () => {
    try {
      const [modRes, accRes, pxRes] = await Promise.all([
        fetch("/api/gateway/models").then((r) => r.json()) as Promise<{ models: Model[] }>,
        fetch("/api/gateway/accounts").then((r) => r.json()) as Promise<{ accounts: AccountEntry[] }>,
        fetch("/api/proxies")
          .then((r) => (r.ok ? r.json() : { proxies: [] }))
          .catch(() => ({ proxies: [] })) as Promise<{ proxies: ProxyEntry[] }>,
      ])

      const mList = modRes.models ?? []
      const aList = accRes.accounts ?? []
      const pList = pxRes.proxies ?? []

      setModels(mList)
      setAccounts(aList)
      setProxies(pList)

      if (mList.length > 0 && !selectedModel) {
        setSelectedModel(mList[0].id)
      }
    } catch {
      // ignore
    } finally {
      setLoadingData(false)
    }
  }, [selectedModel])

  useEffect(() => {
    loadData()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-scroll ────────────────────────────────────────────────────

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, sending])

  // Esc đóng ảnh phóng to — modal không có đường thoát bằng bàn phím là bẫy quen thuộc.
  useEffect(() => {
    if (!zoom) return
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setZoom(null) }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [zoom])

  // ── Send ───────────────────────────────────────────────────────────

  /** Đọc file ảnh thành data URI — định dạng backend nhận (`dataUrlToInline`). */
  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return
    const anh = [...files].filter((f) => f.type.startsWith("image/"))
    const uris = await Promise.all(
      anh.map(
        (f) =>
          new Promise<string>((resolve, reject) => {
            const r = new FileReader()
            r.onload = () => resolve(String(r.result))
            r.onerror = () => reject(r.error)
            r.readAsDataURL(f) // KHÔNG readAsText: cần base64 data URI
          }),
      ),
    )
    setAttached((prev) => [...prev, ...uris])
  }

  const handleCancel = () => {
    abortRef.current?.abort()
    abortRef.current = null
  }

  const handleSend = async () => {
    const trimmed = prompt.trim()
    if ((!trimmed && attached.length === 0) || !selectedModel || sending) return

    const anhGui = attached
    const userMsg: ChatMessage = { role: "user", content: trimmed, images: anhGui }
    setMessages((prev) => [...prev, userMsg])
    setPrompt("")
    setAttached([])
    setSending(true)
    setError(null)

    const ctrl = new AbortController()
    abortRef.current = ctrl

    // Có ảnh thì phải gửi dạng mảng block multimodal; backend `toMessages` ưu tiên
    // `messages` nên không cần sửa gì phía server.
    const body = anhGui.length
      ? {
          messages: [
            {
              role: "user",
              content: [
                ...(trimmed ? [{ type: "text", text: trimmed }] : []),
                ...anhGui.map((url) => ({ type: "image_url", image_url: { url } })),
              ],
            },
          ],
        }
      : { content: trimmed }

    try {
      const res = await fetch("/api/gateway/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          model: selectedModel,
          ...body,
          account: selectedAccount !== "auto" ? selectedAccount : undefined,
          proxy: selectedProxy || undefined,
          maxTokens,
          temperature,
        }),
      })

      const data = (await res.json()) as ChatResponse

      if (data.ok) {
        const assistantMsg: ChatMessage = {
          role: "assistant",
          // Model ảnh trả `images` mà không có text — đừng hiện "(no text)" như lỗi.
          content: data.text ?? (data.images?.length ? "" : "(không có nội dung)"),
          images: data.images ?? [],
          meta: {
            model: data.model,
            account: data.account,
            ms: data.ms,
            tokens: data.usage?.totalTokens,
            resolvedModel: data.resolvedModel,
            steps: data.steps,
          },
        }
        setMessages((prev) => [...prev, assistantMsg])
      } else {
        const errMsg: ChatMessage = {
          role: "assistant",
          content: data.error ?? "Lỗi không xác định",
          error: true,
          meta: {
            account: data.account,
            ms: data.ms,
          },
        }
        setMessages((prev) => [...prev, errMsg])
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // Người dùng chủ động huỷ: giữ lại prompt để gửi lại, không coi là lỗi.
        setMessages((prev) => prev.slice(0, -1))
        setPrompt(trimmed)
        setAttached(anhGui)
      } else {
        setError(err instanceof Error ? err.message : "Request failed")
        // Remove the user message on network error
        setMessages((prev) => prev.slice(0, -1))
        setPrompt(trimmed)
        setAttached(anhGui)
      }
    } finally {
      abortRef.current = null
      setSending(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      handleSend()
    }
  }

  // ── Group models by provider ───────────────────────────────────────

  const modelGroups: Record<string, Model[]> = {}
  for (const m of models) {
    const grp = m.providerLabel ?? m.provider ?? "Other"
    if (!modelGroups[grp]) modelGroups[grp] = []
    modelGroups[grp].push(m)
  }

  const enabledAccounts = accounts.filter((a) => a.enabled !== false)
  const currentModel = models.find((m) => m.id === selectedModel)

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-[calc(100dvh-8rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] gap-3">
      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 flex-shrink-0">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold text-foreground">Chat thử</h2>
        </div>

        {/* Selectors */}
        {loadingData ? (
          <div className="flex gap-2">
            <Skeleton className="h-8 w-40 bg-muted" />
            <Skeleton className="h-8 w-32 bg-muted" />
          </div>
        ) : (
          <div className="flex items-center gap-2 flex-wrap sm:ml-auto">
            {/* Model */}
            <NativeSelect value={selectedModel} onChange={setSelectedModel} className="max-w-[200px]">
              {models.length === 0 ? (
                <option value="">No models</option>
              ) : Object.keys(modelGroups).length === 1 ? (
                models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label ?? m.id}
                  </option>
                ))
              ) : (
                Object.entries(modelGroups).map(([grp, list]) => (
                  <optgroup key={grp} label={grp}>
                    {list.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id}
                      </option>
                    ))}
                  </optgroup>
                ))
              )}
            </NativeSelect>

            {/* Account */}
            <NativeSelect value={selectedAccount} onChange={setSelectedAccount} className="max-w-[180px]">
              <option value="auto">auto (theo chiến lược)</option>
              {enabledAccounts.map((a) => (
                <option key={a.email} value={a.email}>
                  {a.email}
                </option>
              ))}
            </NativeSelect>

            {/* Proxy */}
            <NativeSelect value={selectedProxy} onChange={setSelectedProxy} className="max-w-[160px]">
              <option value="">(không dùng proxy)</option>
              {proxies.map((p) => (
                <option key={p.label} value={p.label}>
                  {p.label}
                </option>
              ))}
            </NativeSelect>

            {/* Reload */}
            <button
              onClick={() => { setLoadingData(true); loadData() }}
              className="p-1.5 rounded text-muted-foreground hover:text-primary hover:bg-muted transition-colors"
              title="Reload models/accounts"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>

            {/* Clear chat */}
            {messages.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setMessages([])}
                className="border-border text-muted-foreground hover:text-destructive h-8 text-xs gap-1"
              >
                <Trash2 className="h-3 w-3" />
                Xoá
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Messages area */}
      <Card className="flex-1 min-h-0 flex flex-col">
        <CardContent className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
              <div className="p-3 rounded-xl bg-muted/50">
                <MessageSquare className="h-8 w-8 text-muted-foreground" />
              </div>
              <p className="text-sm text-muted-foreground">
                Nhập prompt bên dưới để bắt đầu chat
              </p>
              <p className="text-xs text-muted-foreground">Ctrl+Enter để gửi</p>
            </div>
          ) : (
            messages.map((msg, i) => (
              <div
                key={i}
                className={`flex gap-2.5 ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                {msg.role === "assistant" && (
                  <div className="flex-shrink-0 h-7 w-7 rounded-full bg-primary/15 flex items-center justify-center mt-0.5">
                    <Bot className="h-4 w-4 text-primary" />
                  </div>
                )}

                <div className="flex flex-col max-w-[80%]">
                  {/* Meta for assistant */}
                  {msg.role === "assistant" && msg.meta && (
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      {msg.meta.model && (
                        <Badge className="bg-muted text-muted-foreground h-4">
                          {msg.meta.model.split("/").pop() ?? msg.meta.model}
                        </Badge>
                      )}
                      {/* Combo: model NÀO thật sự trả lời. Chỉ hiện tên combo thì không
                          biết nó rơi vào bước nào — mà đó chính là thứ cần biết khi thử. */}
                      {msg.meta.resolvedModel && msg.meta.resolvedModel !== msg.meta.model && (
                        <Badge
                          className="bg-info/15 text-info h-4"
                          title={
                            msg.meta.steps?.length
                              ? msg.meta.steps.map((s) => `${s.ok ? "✓" : "✗"} ${s.model}${s.error ? ` — ${s.error}` : ""}`).join("\n")
                              : undefined
                          }
                        >
                          → {msg.meta.resolvedModel}
                          {msg.meta.steps && msg.meta.steps.length > 1 ? ` (bước ${msg.meta.steps.length})` : ""}
                        </Badge>
                      )}
                      {msg.meta.account && (
                        <Badge className="bg-muted text-muted-foreground h-4">
                          {msg.meta.account.split("@")[0]}
                        </Badge>
                      )}
                      {msg.meta.ms && (
                        <span className="text-[10px] text-muted-foreground">{msg.meta.ms}ms</span>
                      )}
                      {msg.meta.tokens && (
                        <span className="text-[10px] text-muted-foreground">{msg.meta.tokens} tok</span>
                      )}
                    </div>
                  )}

                  {(msg.content || !msg.images?.length) && (
                    <div
                      className={`rounded-2xl px-4 py-2.5 text-sm ${
                        msg.role === "user"
                          ? "bg-primary text-primary-foreground rounded-tr-sm"
                          : msg.error
                          ? "bg-destructive/15 text-destructive border border-destructive/20 rounded-tl-sm"
                          : "bg-muted text-foreground rounded-tl-sm"
                      }`}
                    >
                      <pre className="whitespace-pre-wrap font-sans leading-relaxed">{msg.content}</pre>
                    </div>
                  )}

                  {/* Ảnh — render thẳng từ mảng images, KHÔNG nhét vào text.
                      Data URI của ảnh Gemini thường vài trăm KB. */}
                  {!!msg.images?.length && (
                    <div className="mt-1.5 flex flex-wrap gap-2">
                      {msg.images.map((src, k) => (
                        <div key={k} className="group relative">
                          <img
                            src={src}
                            alt={msg.role === "user" ? `Ảnh đính kèm ${k + 1}` : `Ảnh model sinh ${k + 1}`}
                            onClick={() => setZoom(src)}
                            className="max-h-64 max-w-full cursor-zoom-in rounded-xl border border-border object-contain"
                          />
                          <a
                            href={src}
                            download={`agyproxy-${Date.now()}-${k + 1}.png`}
                            onClick={(e) => e.stopPropagation()}
                            title="Tải ảnh về"
                            aria-label="Tải ảnh về"
                            className="absolute right-1.5 top-1.5 rounded-md bg-background/80 p-1.5 opacity-0 transition-opacity group-hover:opacity-100"
                          >
                            <Download className="h-3.5 w-3.5 text-foreground" />
                          </a>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {msg.role === "user" && (
                  <div className="flex-shrink-0 h-7 w-7 rounded-full bg-muted flex items-center justify-center mt-0.5">
                    <User className="h-4 w-4 text-muted-foreground" />
                  </div>
                )}
              </div>
            ))
          )}

          {/* Sending indicator */}
          {sending && (
            <div className="flex gap-2.5 justify-start">
              <div className="flex-shrink-0 h-7 w-7 rounded-full bg-primary/15 flex items-center justify-center">
                <Bot className="h-4 w-4 text-primary" />
              </div>
              <div className="bg-muted rounded-2xl rounded-tl-sm px-4 py-2.5 flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 text-muted-foreground animate-spin" />
                <span className="text-xs text-muted-foreground">Đang gọi model…</span>
                {/* Không có nút này thì lượt xấu nhất là 3 account × 180s ≈ 9 phút
                    ngồi nhìn spinner, không cách nào dừng. Model ảnh còn chậm hơn. */}
                <button
                  onClick={handleCancel}
                  className="ml-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-background hover:text-destructive"
                >
                  Huỷ
                </button>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </CardContent>

        {/* Error */}
        {error && (
          <div className="mx-4 mb-2 flex items-start gap-2 bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
            <AlertTriangle className="h-3.5 w-3.5 text-destructive flex-shrink-0 mt-0.5" />
            <p className="text-xs text-destructive">{error}</p>
          </div>
        )}

        {/* Input */}
        <div className="border-t border-border p-3 flex-shrink-0">
          {/* Ảnh đã đính kèm, chờ gửi */}
          {attached.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {attached.map((src, i) => (
                <div key={i} className="relative">
                  <img
                    src={src}
                    alt={`Ảnh đính kèm ${i + 1}`}
                    className="h-16 w-16 rounded-lg border border-border object-cover"
                  />
                  <button
                    onClick={() => setAttached((p) => p.filter((_, k) => k !== i))}
                    aria-label={`Bỏ ảnh đính kèm ${i + 1}`}
                    className="absolute -right-1.5 -top-1.5 rounded-full bg-destructive p-0.5 text-destructive-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Tham số sinh — mở ra khi cần, không chiếm chỗ thường trực */}
          {showParams && (
            <div className="mb-2 flex flex-wrap items-center gap-4 rounded-lg bg-muted/50 px-3 py-2">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                max_tokens
                <input
                  type="number"
                  min={1}
                  max={64000}
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(Math.max(1, Number(e.target.value) || 1))}
                  className="h-7 w-20 rounded-md border border-border bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </label>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                temperature
                <input
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={temperature}
                  onChange={(e) => setTemperature(Number(e.target.value))}
                  className="h-7 w-20 rounded-md border border-border bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </label>
              <span className="text-[10px] text-muted-foreground">
                max_tokens thấp làm model reasoning trả nội dung rỗng
              </span>
            </div>
          )}

          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Nhập prompt… (Ctrl+Enter để gửi)"
                rows={3}
                disabled={sending}
                className="w-full bg-muted border border-border rounded-xl px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
              />
            </div>
            <Button
              onClick={handleSend}
              disabled={(!prompt.trim() && attached.length === 0) || !selectedModel || sending}
              className="bg-primary hover:bg-primary text-primary-foreground h-[88px] px-4 flex flex-col items-center justify-center gap-1.5 rounded-xl disabled:opacity-50 shrink-0"
            >
              {sending ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Send className="h-5 w-5" />
              )}
              <span className="text-[10px]">Gửi</span>
            </Button>
          </div>

          <div className="flex items-center justify-between mt-1.5 gap-2 flex-wrap">
            <div className="flex items-center gap-1">
              {/* Chỉ mời đính kèm ảnh khi model THẬT SỰ nhận được — Kiro lọc bỏ mọi
                  part ảnh, bật nút ở đó là để người dùng gửi rồi bị vứt im lặng. */}
              {currentModel?.imageIn && (
                <>
                  <button
                    onClick={() => fileRef.current?.click()}
                    disabled={sending}
                    title="Đính kèm ảnh cho model xem"
                    aria-label="Đính kèm ảnh"
                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-primary disabled:opacity-50"
                  >
                    <ImagePlus className="h-3.5 w-3.5" />
                  </button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={(e) => { handleFiles(e.target.files); e.target.value = "" }}
                    className="hidden"
                  />
                </>
              )}
              <button
                onClick={() => setShowParams((v) => !v)}
                title="Tham số sinh"
                aria-label="Tham số sinh"
                className={`rounded p-1 transition-colors hover:bg-muted ${showParams ? "text-primary" : "text-muted-foreground hover:text-primary"}`}
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
              </button>
              <span className="text-[10px] text-muted-foreground ml-1">Ctrl+Enter để gửi</span>
            </div>
            <div className="flex items-center gap-2">
              {currentModel?.imageOut && (
                <Badge className="bg-muted text-info">sinh ảnh</Badge>
              )}
              {selectedModel && (
                <Badge className="bg-muted text-muted-foreground">
                  {selectedModel.split("/").pop() ?? selectedModel}
                </Badge>
              )}
              {selectedAccount !== "auto" && (
                <Badge className="bg-muted text-info">
                  {selectedAccount.split("@")[0]}
                </Badge>
              )}
            </div>
          </div>
        </div>
      </Card>

      {/* Xem ảnh phóng to */}
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
