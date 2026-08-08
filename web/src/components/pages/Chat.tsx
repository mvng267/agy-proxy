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
}

interface ChatMessage {
  role: "user" | "assistant"
  content: string
  // Metadata for assistant messages
  meta?: {
    model?: string
    account?: string
    ms?: number
    tokens?: number
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
        className={`appearance-none h-8 px-2 pr-7 rounded-md bg-muted border border-border text-foreground text-xs focus:outline-none focus:ring-1 focus:ring-orange-500 disabled:opacity-50 ${className ?? ""}`}
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

  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

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

  // ── Send ───────────────────────────────────────────────────────────

  const handleSend = async () => {
    const trimmed = prompt.trim()
    if (!trimmed || !selectedModel || sending) return

    const userMsg: ChatMessage = { role: "user", content: trimmed }
    setMessages((prev) => [...prev, userMsg])
    setPrompt("")
    setSending(true)
    setError(null)

    try {
      const res = await fetch("/api/gateway/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: selectedModel,
          content: trimmed,
          account: selectedAccount !== "auto" ? selectedAccount : undefined,
          proxy: selectedProxy || undefined,
        }),
      })

      const data = (await res.json()) as ChatResponse

      if (data.ok) {
        const assistantMsg: ChatMessage = {
          role: "assistant",
          content: data.text ?? "(no text)",
          meta: {
            model: data.model,
            account: data.account,
            ms: data.ms,
            tokens: data.usage?.totalTokens,
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
      setError(err instanceof Error ? err.message : "Request failed")
      // Remove the user message on network error
      setMessages((prev) => prev.slice(0, -1))
      setPrompt(trimmed)
    } finally {
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

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-[calc(100dvh-8rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] gap-3">
      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 flex-shrink-0">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium text-foreground">Chat thử</h2>
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
              className="p-1.5 rounded text-muted-foreground hover:text-orange-400 hover:bg-muted transition-colors"
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
                className="border-border text-muted-foreground hover:text-red-400 h-8 text-xs gap-1"
              >
                <Trash2 className="h-3 w-3" />
                Xoá
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Messages area */}
      <Card className="bg-card border-border flex-1 min-h-0 flex flex-col">
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
                  <div className="flex-shrink-0 h-7 w-7 rounded-full bg-orange-500/15 flex items-center justify-center mt-0.5">
                    <Bot className="h-4 w-4 text-orange-400" />
                  </div>
                )}

                <div className="flex flex-col max-w-[80%]">
                  {/* Meta for assistant */}
                  {msg.role === "assistant" && msg.meta && (
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      {msg.meta.model && (
                        <Badge className="bg-muted text-muted-foreground border-none text-[10px] h-4">
                          {msg.meta.model.split("/").pop() ?? msg.meta.model}
                        </Badge>
                      )}
                      {msg.meta.account && (
                        <Badge className="bg-muted text-muted-foreground border-none text-[10px] h-4">
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

                  <div
                    className={`rounded-2xl px-4 py-2.5 text-sm ${
                      msg.role === "user"
                        ? "bg-orange-500 text-white rounded-tr-sm"
                        : msg.error
                        ? "bg-red-500/15 text-red-300 border border-red-500/20 rounded-tl-sm"
                        : "bg-muted text-foreground rounded-tl-sm"
                    }`}
                  >
                    <pre className="whitespace-pre-wrap font-sans leading-relaxed">{msg.content}</pre>
                  </div>
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
              <div className="flex-shrink-0 h-7 w-7 rounded-full bg-orange-500/15 flex items-center justify-center">
                <Bot className="h-4 w-4 text-orange-400" />
              </div>
              <div className="bg-muted rounded-2xl rounded-tl-sm px-4 py-2.5 flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 text-muted-foreground animate-spin" />
                <span className="text-xs text-muted-foreground">Đang gọi model…</span>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </CardContent>

        {/* Error */}
        {error && (
          <div className="mx-4 mb-2 flex items-start gap-2 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
            <AlertTriangle className="h-3.5 w-3.5 text-red-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-red-400">{error}</p>
          </div>
        )}

        {/* Input */}
        <div className="border-t border-border p-3 flex-shrink-0">
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
                className="w-full bg-muted border border-border rounded-xl px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:ring-1 focus:ring-orange-500 disabled:opacity-50"
              />
            </div>
            <Button
              onClick={handleSend}
              disabled={!prompt.trim() || !selectedModel || sending}
              className="bg-orange-500 hover:bg-orange-600 text-white h-[88px] px-4 flex flex-col items-center justify-center gap-1.5 rounded-xl disabled:opacity-50 shrink-0"
            >
              {sending ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Send className="h-5 w-5" />
              )}
              <span className="text-[10px]">Gửi</span>
            </Button>
          </div>
          <div className="flex items-center justify-between mt-1.5">
            <span className="text-[10px] text-muted-foreground">Ctrl+Enter để gửi</span>
            <div className="flex items-center gap-2">
              {selectedModel && (
                <Badge className="bg-muted text-muted-foreground border-none text-[10px]">
                  {selectedModel.split("/").pop() ?? selectedModel}
                </Badge>
              )}
              {selectedAccount !== "auto" && (
                <Badge className="bg-muted text-blue-500 border-none text-[10px]">
                  {selectedAccount.split("@")[0]}
                </Badge>
              )}
            </div>
          </div>
        </div>
      </Card>
    </div>
  )
}
