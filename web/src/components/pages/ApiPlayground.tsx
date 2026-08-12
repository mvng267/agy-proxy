import { useEffect, useMemo, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Play, Square, AlertTriangle, Terminal } from "lucide-react"
import { api } from "@/lib/api"
import { ModelSelect, useModels } from "@/components/common/ModelSelect"
import { CopyButton, CodeBlock } from "@/components/common/copy"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"

/**
 * Gọi thử CHUẨN KẾT NỐI thật, không đi qua đường tắt của dashboard.
 *
 * Khác màn "Chat thử": chỗ đó gọi `/api/gateway/chat` (session dashboard) — tiện để thử
 * model, nhưng KHÔNG chứng minh được client ngoài cắm vào có chạy không. Màn này gửi
 * request y hệt một client thật: đúng endpoint dialect, đúng header xác thực, bằng API
 * key. Nên khi Cursor/Claude Code/Hermes báo lỗi, đây là chỗ tái hiện.
 *
 * Hiển thị luôn request JSON, response thô và lệnh curl tương đương — để copy sang chỗ
 * khác chạy lại, hoặc gửi cho người khác xem.
 */

/** Bốn tiền tố vì mỗi loại client tự nối path một kiểu — xem chú thích ở src/auth.ts. */
const PREFIXES = ["/v1", "/proxy/v1", "/openai/v1", "/anthropic/v1"] as const

type DialectId = "openai" | "anthropic" | "responses"

interface Dialect {
  id: DialectId
  label: string
  path: string
  /** Tiền tố dùng được — Responses API chỉ đăng ký dưới /proxy/v1. */
  prefixes: readonly string[]
  /** Anthropic dùng x-api-key, OpenAI dùng Authorization: Bearer. */
  auth: "bearer" | "x-api-key"
  body: (model: string, prompt: string, maxTokens: number, stream: boolean) => unknown
  /** Rút câu trả lời ra khỏi response — mỗi chuẩn một hình dạng khác nhau. */
  pick: (j: any) => string
}

const DIALECTS: Dialect[] = [
  {
    id: "openai",
    label: "OpenAI · chat/completions",
    path: "/chat/completions",
    prefixes: ["/v1", "/proxy/v1", "/openai/v1"],
    auth: "bearer",
    body: (model, prompt, max_tokens, stream) => ({
      model,
      max_tokens,
      messages: [{ role: "user", content: prompt }],
      ...(stream ? { stream: true } : {}),
    }),
    pick: (j) => j?.choices?.[0]?.message?.content ?? "",
  },
  {
    id: "anthropic",
    label: "Anthropic · messages",
    path: "/messages",
    prefixes: ["/v1", "/proxy/v1", "/anthropic/v1"],
    auth: "x-api-key",
    body: (model, prompt, max_tokens, stream) => ({
      model,
      max_tokens,
      messages: [{ role: "user", content: prompt }],
      ...(stream ? { stream: true } : {}),
    }),
    pick: (j) => (j?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join(""),
  },
  {
    id: "responses",
    label: "OpenAI · responses",
    path: "/responses",
    // Chỉ có ở /proxy/v1 — dialect không đăng ký alias cho endpoint này.
    prefixes: ["/proxy/v1"],
    auth: "bearer",
    body: (model, prompt, max_output_tokens) => ({ model, input: prompt, max_output_tokens }),
    pick: (j) => j?.output_text ?? j?.output?.[0]?.content?.[0]?.text ?? "",
  },
]

export function ApiPlayground() {
  const [dialectId, setDialectId] = useState<DialectId>("openai")
  const [prefix, setPrefix] = useState<string>("/v1")
  const [model, setModel] = useState("")
  const [prompt, setPrompt] = useState("Trả lời đúng một từ: OK")
  const [maxTokens, setMaxTokens] = useState(2000)
  const [stream, setStream] = useState(false)

  const [running, setRunning] = useState(false)
  const [res, setRes] = useState<{ status: number; ms: number; body: string; text: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const dialect = DIALECTS.find((d) => d.id === dialectId)!


  /**
   * API key thật — request phải mang key như client ngoài, không dùng phiên dashboard.
   * `?reveal=1` chỉ gọi được khi đã đăng nhập, nên key không rò ra ngoài.
   */
  const cfg = useQuery({
    queryKey: ["gatewayKey"],
    queryFn: () => api.get<{ apiKey?: string }>("/api/gateway/config?reveal=1"),
  })
  const apiKey = cfg.data?.apiKey ?? ""
  // Cùng queryKey với ModelSelect → React Query dùng chung cache, không gọi API hai lần.
  const models = useModels()

  useEffect(() => {
    const list = models.data?.models ?? []
    if (list.length && !model) setModel(list[0].id)
  }, [models.data, model])

  // Đổi dialect có thể làm tiền tố đang chọn không còn hợp lệ (Responses chỉ có /proxy/v1).
  useEffect(() => {
    if (!dialect.prefixes.includes(prefix)) setPrefix(dialect.prefixes[0])
  }, [dialectId]) // eslint-disable-line react-hooks/exhaustive-deps

  const url = `${prefix}${dialect.path}`
  const body = useMemo(
    () => dialect.body(model, prompt, maxTokens, stream),
    [dialect, model, prompt, maxTokens, stream],
  )

  const headers = useMemo(() => {
    const h: Record<string, string> = { "content-type": "application/json" }
    if (dialect.auth === "bearer") h.authorization = `Bearer ${apiKey}`
    else {
      h["x-api-key"] = apiKey
      h["anthropic-version"] = "2023-06-01"
    }
    return h
  }, [dialect, apiKey])

  const curl = useMemo(() => {
    const base = typeof window !== "undefined" ? window.location.origin : ""
    const hs = Object.entries(headers)
      // Không in key thật ra lệnh copy: dán nhầm vào chat/issue là lộ.
      .map(([k, v]) => `  -H '${k}: ${k === "authorization" ? "Bearer $AGY_KEY" : k === "x-api-key" ? "$AGY_KEY" : v}'`)
      .join(" \\\n")
    return `curl -sN ${base}${url} \\\n${hs} \\\n  -d '${JSON.stringify(body)}'`
  }, [headers, url, body])

  const run = async () => {
    setRunning(true)
    setErr(null)
    setRes(null)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const t0 = Date.now()

    try {
      const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal })
      const raw = await r.text()
      const ms = Date.now() - t0

      if (stream) {
        // SSE: giữ nguyên khung để nhìn thấy đúng thứ client nhận được — `data:`/`event:`
        // và sentinel [DONE]. Ghép lại phần chữ chỉ để đọc cho nhanh.
        const chunks = raw.split("\n").filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
        let text = ""
        for (const c of chunks) {
          try {
            const j = JSON.parse(c.slice(6))
            text += j?.choices?.[0]?.delta?.content ?? j?.delta?.text ?? ""
          } catch { /* frame không phải JSON (ping) — bỏ qua */ }
        }
        setRes({ status: r.status, ms, body: raw, text })
      } else {
        let text = ""
        try { text = dialect.pick(JSON.parse(raw)) } catch { /* lỗi trả về không phải JSON */ }
        let pretty = raw
        try { pretty = JSON.stringify(JSON.parse(raw), null, 2) } catch { /* giữ thô */ }
        setRes({ status: r.status, ms, body: pretty, text })
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") setErr("Đã huỷ")
      else setErr(e instanceof Error ? e.message : String(e))
    } finally {
      abortRef.current = null
      setRunning(false)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Gửi request y hệt một client ngoài — đúng endpoint, đúng header, bằng API key. Dùng để
        tái hiện khi Cursor / Claude Code / Hermes báo lỗi kết nối.
      </p>

      {/* Thanh cấu hình */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-2 p-3">
          <label className="flex flex-col gap-1">
            <span className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">Chuẩn</span>
            <Select value={dialectId} onValueChange={(v) => setDialectId((v ?? "openai") as DialectId)}>
              <SelectTrigger className="h-8 w-56 text-xs">
                <span className="truncate">{dialect.label}</span>
              </SelectTrigger>
              <SelectContent>
                {DIALECTS.map((d) => (
                  <SelectItem key={d.id} value={d.id} className="text-xs">{d.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">Tiền tố</span>
            <Select value={prefix} onValueChange={(v) => setPrefix(v ?? "/v1")}>
              <SelectTrigger className="h-8 w-40 text-xs">
                <span className="truncate">{prefix}</span>
              </SelectTrigger>
              <SelectContent>
                {PREFIXES.filter((p) => dialect.prefixes.includes(p)).map((p) => (
                  <SelectItem key={p} value={p} className="text-xs">{p}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">Model</span>
            {/* Combo lên đầu: chúng nhiều bước nên dễ hỏng hơn model đơn, và đây là chỗ
                duy nhất thử được chúng qua chuẩn API thật. */}
            <ModelSelect value={model} onChange={setModel} comboFirst />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">max_tokens</span>
            <input
              type="number"
              min={1}
              value={maxTokens}
              onChange={(e) => setMaxTokens(Math.max(1, Number(e.target.value) || 1))}
              className="h-8 w-24 rounded-md border border-border bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </label>

          {dialect.id !== "responses" && (
            <label className="flex h-8 items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={stream} onChange={(e) => setStream(e.target.checked)} className="accent-[color:var(--primary)]" />
              stream
            </label>
          )}

          <div className="ml-auto flex items-center gap-2">
            {running ? (
              <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => abortRef.current?.abort()}>
                <Square className="h-3 w-3" /> Huỷ
              </Button>
            ) : (
              <Button size="sm" className="h-8 gap-1.5" disabled={!model || !apiKey} onClick={run}>
                <Play className="h-3 w-3" /> Gửi
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {!apiKey && !cfg.isLoading && (
        <div className="flex items-start gap-2 rounded-md border border-border bg-card/60 p-2.5 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>Chưa có API key gateway. Tạo ở Cấu hình → API Keys rồi quay lại.</span>
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        {/* Request */}
        <Card>
          <CardContent className="space-y-2 p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Request</span>
              <Badge className="bg-muted font-mono text-muted-foreground">POST {url}</Badge>
            </div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              className="w-full resize-none rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <CodeBlock code={JSON.stringify(body, null, 2)} className="max-h-52 overflow-auto" />
            <div className="flex items-center gap-2 pt-1">
              <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Lệnh curl tương đương</span>
              <CopyButton value={curl} className="ml-auto" />
            </div>
            <CodeBlock code={curl} className="max-h-44 overflow-auto" />
          </CardContent>
        </Card>

        {/* Response */}
        <Card>
          <CardContent className="space-y-2 p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Response</span>
              {res && (
                <div className="flex items-center gap-2">
                  <Badge
                    className={`font-mono ${
                      res.status < 300
                        ? "bg-success/15 text-[color:var(--success)]"
                        : res.status === 429
                        ? "bg-warning/15 text-[color:var(--warning)]"
                        : "bg-destructive/15 text-destructive"
                    }`}
                  >
                    {res.status}
                  </Badge>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {res.ms >= 1000 ? `${(res.ms / 1000).toFixed(1)}s` : `${res.ms}ms`}
                  </span>
                </div>
              )}
            </div>

            {err && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/10 p-2.5">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                <p className="text-xs text-destructive">{err}</p>
              </div>
            )}

            {res?.text ? (
              <div className="rounded-lg bg-muted px-3 py-2">
                <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{res.text}</pre>
              </div>
            ) : null}

            {res ? (
              <CodeBlock code={res.body} className="max-h-96 overflow-auto" />
            ) : (
              !err && (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  {running ? "Đang gọi…" : "Bấm Gửi để xem response thô"}
                </p>
              )
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
