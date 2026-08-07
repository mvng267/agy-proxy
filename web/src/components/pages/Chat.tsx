import { useEffect, useState, useRef } from "react"
import {
  MessageSquare,
  Send,
  AlertTriangle,
  Loader2,
  Bot,
  User,
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
  name?: string
}

interface ModelsResponse {
  models: Model[]
}

interface ChatMessage {
  role: "user" | "assistant"
  content: string
}

// ── Chat Page ───────────────────────────────────────────────────────────

export function Chat() {
  const [models, setModels] = useState<Model[]>([])
  const [modelsLoading, setModelsLoading] = useState(true)
  const [selectedModel, setSelectedModel] = useState("")
  const [prompt, setPrompt] = useState("")
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Fetch models
  useEffect(() => {
    fetch("/api/gateway/models")
      .then((r) => r.json())
      .then((json: ModelsResponse) => {
        const list = json.models ?? []
        setModels(list)
        if (list.length > 0) {
          setSelectedModel(list[0].id)
        }
      })
      .catch(() => {
        // ignore
      })
      .finally(() => setModelsLoading(false))
  }, [])

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  const handleSend = async () => {
    const trimmed = prompt.trim()
    if (!trimmed || !selectedModel || sending) return

    const userMsg: ChatMessage = { role: "user", content: trimmed }
    setMessages((prev) => [...prev, userMsg])
    setPrompt("")
    setSending(true)
    setError(null)

    try {
      const res = await fetch("/proxy/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: selectedModel,
          messages: [...messages, userMsg].map((m) => ({
            role: m.role,
            content: m.content,
          })),
          stream: false,
        }),
      })

      if (!res.ok) {
        const txt = await res.text()
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 120)}`)
      }

      const data = await res.json() as {
        choices?: { message?: { content?: string } }[]
        content?: { text?: string }[]
        error?: { message?: string }
      }

      let reply = ""
      // OpenAI format
      if (data.choices?.[0]?.message?.content) {
        reply = data.choices[0].message.content
      }
      // Anthropic format
      else if (data.content?.[0]?.text) {
        reply = data.content[0].text
      }
      // Error in body
      else if (data.error?.message) {
        throw new Error(data.error.message)
      }
      else {
        reply = JSON.stringify(data, null, 2)
      }

      setMessages((prev) => [...prev, { role: "assistant", content: reply }])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send")
      // Remove the user message that failed
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

  return (
    <div className="flex flex-col h-[calc(100vh-10rem)] gap-4">
      {/* Header + model selector */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 flex-shrink-0">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-slate-500" />
          <h2 className="text-sm font-medium text-slate-300">Chat thử</h2>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">Model:</span>
          {modelsLoading ? (
            <Skeleton className="h-8 w-48 bg-slate-800" />
          ) : (
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="h-8 px-2 rounded-md bg-slate-800 border border-slate-700 text-slate-200 text-xs focus:outline-none focus:ring-1 focus:ring-orange-500"
            >
              {models.length === 0 ? (
                <option value="">No models</option>
              ) : (
                models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label ?? m.name ?? m.id}
                  </option>
                ))
              )}
            </select>
          )}
          {messages.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setMessages([])}
              className="border-slate-700 text-slate-500 hover:text-red-400 h-8 text-xs"
            >
              Clear
            </Button>
          )}
        </div>
      </div>

      {/* Messages */}
      <Card className="bg-slate-900 border-slate-800 flex-1 min-h-0 flex flex-col">
        <CardContent className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
              <div className="p-3 rounded-xl bg-slate-800/50">
                <MessageSquare className="h-8 w-8 text-slate-600" />
              </div>
              <p className="text-sm text-slate-500">
                Nhập prompt bên dưới để bắt đầu chat
              </p>
              <p className="text-xs text-slate-600">Ctrl+Enter để gửi</p>
            </div>
          ) : (
            messages.map((msg, i) => (
              <div
                key={i}
                className={`flex gap-3 ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                {msg.role === "assistant" && (
                  <div className="flex-shrink-0 h-7 w-7 rounded-full bg-orange-500/15 flex items-center justify-center">
                    <Bot className="h-4 w-4 text-orange-400" />
                  </div>
                )}
                <div
                  className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm ${
                    msg.role === "user"
                      ? "bg-orange-500 text-white rounded-tr-sm"
                      : "bg-slate-800 text-slate-200 rounded-tl-sm"
                  }`}
                >
                  <pre className="whitespace-pre-wrap font-sans leading-relaxed">
                    {msg.content}
                  </pre>
                </div>
                {msg.role === "user" && (
                  <div className="flex-shrink-0 h-7 w-7 rounded-full bg-slate-700 flex items-center justify-center">
                    <User className="h-4 w-4 text-slate-400" />
                  </div>
                )}
              </div>
            ))
          )}
          {sending && (
            <div className="flex gap-3 justify-start">
              <div className="flex-shrink-0 h-7 w-7 rounded-full bg-orange-500/15 flex items-center justify-center">
                <Bot className="h-4 w-4 text-orange-400" />
              </div>
              <div className="bg-slate-800 rounded-2xl rounded-tl-sm px-4 py-2.5 flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 text-slate-500 animate-spin" />
                <span className="text-xs text-slate-500">Thinking...</span>
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
        <div className="border-t border-slate-800 p-4 flex-shrink-0">
          <div className="flex gap-2 items-end">
            <div className="flex-1 relative">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Nhập prompt... (Ctrl+Enter để gửi)"
                rows={3}
                disabled={sending}
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-sm text-slate-200 placeholder:text-slate-600 resize-none focus:outline-none focus:ring-1 focus:ring-orange-500 disabled:opacity-50"
              />
            </div>
            <Button
              onClick={handleSend}
              disabled={!prompt.trim() || !selectedModel || sending}
              className="bg-orange-500 hover:bg-orange-600 text-white h-[88px] px-4 flex flex-col items-center justify-center gap-1.5 rounded-xl disabled:opacity-50"
            >
              {sending ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Send className="h-5 w-5" />
              )}
              <span className="text-[10px]">Send</span>
            </Button>
          </div>
          <div className="flex items-center justify-between mt-2">
            <span className="text-xs text-slate-600">Ctrl+Enter to send</span>
            {selectedModel && (
              <Badge className="bg-slate-800 text-slate-500 border-none text-[10px]">
                {selectedModel.split("/").pop() ?? selectedModel}
              </Badge>
            )}
          </div>
        </div>
      </Card>
    </div>
  )
}
