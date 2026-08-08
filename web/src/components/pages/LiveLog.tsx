import { useEffect, useMemo, useRef, useState, useCallback } from "react"
import {
  ArrowDownToLine,
  Clock,
  Cpu,
  Filter,
  KeyRound,
  Pause,
  Play,
  ScrollText,
  Search,
  Shuffle,
  Trash2,
  User,
  X,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import { LogTag, statusTone, type TagTone } from "@/components/common/LogTag"

/**
 * Live Log — mỗi dòng gồm HAI hàng:
 *   hàng trên : thẻ (giờ · loại · model · account · api key · combo · status · ms · tok)
 *   hàng dưới : mô tả nguyên văn từ gateway
 *
 * Trước đây tất cả nhồi vào một hàng monospace nên message dài đẩy các thông tin quan
 * trọng ra khỏi màn hình, và model/account/api key KHÔNG hiển thị dù backend đã gửi.
 *
 * Bộ lọc phải NÓI RÕ nó đang lọc gì: bản cũ không có lọc, chỉ đếm tổng — nhìn 200 dòng
 * trôi qua không cách nào tách được request của một user.
 */

const MAX_ENTRIES = 500

type Kind = "req" | "res" | "err" | "check" | "info"

interface Entry {
  id: number
  ts: number
  kind: Kind
  level: string
  msg: string
  model?: string
  account?: string
  apiKey?: string
  combo?: string
  status?: number
  ms?: number
  tokens?: number
  endpoint?: string
  proxy?: string
  attempt?: number
}

/** Chuẩn hoá 1 dòng SSE → Entry. Dòng không phải JSON vẫn hiển thị được (fallback). */
function toEntry(raw: string, id: number): Entry {
  try {
    const j = JSON.parse(raw) as Record<string, any>
    const kind: Kind =
      j.kind === "req" || j.kind === "res" || j.kind === "err" || j.kind === "check"
        ? j.kind
        : j.level === "error"
          ? "err"
          : "info"
    return {
      id,
      ts: j.ts ? Date.parse(j.ts) : Date.now(),
      kind,
      level: String(j.level ?? "info"),
      msg: String(j.msg ?? raw),
      model: j.model || undefined,
      account: j.account || j.email || undefined,
      apiKey: j.apiKey || undefined,
      combo: j.combo || undefined,
      status: typeof j.status === "number" ? j.status : undefined,
      ms: typeof j.ms === "number" ? j.ms : undefined,
      tokens: typeof j.tokens === "number" ? j.tokens : undefined,
      endpoint: j.endpoint || undefined,
      proxy: j.proxy || undefined,
      attempt: typeof j.attempt === "number" ? j.attempt : undefined,
    }
  } catch {
    return { id, ts: Date.now(), kind: "info", level: "info", msg: raw }
  }
}

const KIND_LABEL: Record<Kind, string> = {
  req: "REQ",
  res: "RES",
  err: "ERR",
  check: "CHECK",
  info: "INFO",
}
const KIND_TONE: Record<Kind, TagTone> = {
  req: "req",
  res: "ok",
  err: "err",
  check: "warn",
  info: "muted",
}

const hhmmss = (ts: number) =>
  new Date(ts).toLocaleTimeString("vi-VN", { hour12: false })

export function LiveLog() {
  const [entries, setEntries] = useState<Entry[]>([])
  const [paused, setPaused] = useState(false)
  const [connected, setConnected] = useState(false)
  const [follow, setFollow] = useState(true)

  // Bộ lọc
  const [kinds, setKinds] = useState<Set<Kind>>(new Set())
  const [model, setModel] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [q, setQ] = useState("")

  const pausedRef = useRef(false)
  const idRef = useRef(0)
  const bottomRef = useRef<HTMLDivElement>(null)

  const add = useCallback((raw: string) => {
    if (pausedRef.current) return
    idRef.current += 1
    const e = toEntry(raw.trim(), idRef.current)
    setEntries((prev) => {
      const next = prev.length >= MAX_ENTRIES ? prev.slice(prev.length - MAX_ENTRIES + 1) : prev
      return [...next, e]
    })
  }, [])

  useEffect(() => {
    const es = new EventSource("/events")
    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)
    es.onmessage = (ev: MessageEvent<string>) => ev.data && add(ev.data)
    return () => {
      es.close()
      setConnected(false)
    }
  }, [add])

  // Tự cuộn xuống dòng mới, TẮT ĐƯỢC bằng nút "Bám đáy": đang kéo lên đọc dòng cũ mà
  // bị giật xuống là lỗi khó chịu nhất của khung log realtime.
  useEffect(() => {
    if (follow && !paused) bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [entries, follow, paused])

  const models = useMemo(
    () => [...new Set(entries.map((e) => e.model).filter(Boolean) as string[])].sort(),
    [entries],
  )
  const apiKeys = useMemo(
    () => [...new Set(entries.map((e) => e.apiKey).filter(Boolean) as string[])].sort(),
    [entries],
  )

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return entries.filter((e) => {
      if (kinds.size && !kinds.has(e.kind)) return false
      if (model && e.model !== model) return false
      if (apiKey && e.apiKey !== apiKey) return false
      if (needle) {
        const hay = `${e.msg} ${e.model ?? ""} ${e.account ?? ""} ${e.apiKey ?? ""} ${e.combo ?? ""}`
        if (!hay.toLowerCase().includes(needle)) return false
      }
      return true
    })
  }, [entries, kinds, model, apiKey, q])

  const counts = useMemo(() => {
    const c: Record<Kind, number> = { req: 0, res: 0, err: 0, check: 0, info: 0 }
    for (const e of entries) c[e.kind]++
    return c
  }, [entries])

  const filtering = kinds.size > 0 || !!model || !!apiKey || !!q.trim()

  const toggleKind = (k: Kind) =>
    setKinds((prev) => {
      const n = new Set(prev)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })

  const clearFilters = () => {
    setKinds(new Set())
    setModel("")
    setApiKey("")
    setQ("")
  }

  return (
    <div className="flex h-[calc(100dvh-9rem)] flex-col gap-3">
      {/* ── Thanh trạng thái + hành động ─────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <ScrollText className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-medium text-foreground">Live Log</h2>
        <span
          className={`ml-1 h-2 w-2 rounded-full ${
            connected ? "bg-success ring-2 ring-success/25" : "bg-muted-foreground/40"
          }`}
        />
        <span className="text-xs text-muted-foreground">
          {connected ? "đang kết nối" : "mất kết nối"}
        </span>

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant={follow ? "secondary" : "outline"}
            size="sm"
            onClick={() => setFollow((v) => !v)}
            title="Tự cuộn xuống dòng mới nhất"
            className="h-8 gap-1 text-xs"
          >
            <ArrowDownToLine className="h-3 w-3" />
            Bám đáy
          </Button>
          <Button
            variant={paused ? "default" : "outline"}
            size="sm"
            onClick={() => {
              pausedRef.current = !pausedRef.current
              setPaused(pausedRef.current)
            }}
            className="h-8 gap-1 text-xs"
          >
            {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
            {paused ? "Tiếp tục" : "Tạm dừng"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setEntries([])
              idRef.current = 0
            }}
            className="h-8 gap-1 text-xs"
          >
            <Trash2 className="h-3 w-3" />
            Xoá
          </Button>
        </div>
      </div>

      {/* ── Bộ lọc ───────────────────────────────────────────────────── */}
      <Card className="border-border bg-card">
        <CardContent className="flex flex-wrap items-center gap-2 p-2.5">
          <Filter className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />

          {/* Lọc theo loại — kèm SỐ ĐẾM để biết có gì mà lọc trước khi bấm. */}
          {(["req", "res", "err"] as Kind[]).map((k) => {
            const on = kinds.has(k)
            return (
              <Button
                key={k}
                size="sm"
                variant={on ? "default" : "outline"}
                onClick={() => toggleKind(k)}
                className="h-7 gap-1 px-2 text-[11px]"
              >
                {KIND_LABEL[k]}
                <span className={on ? "opacity-80" : "text-muted-foreground"}>{counts[k]}</span>
              </Button>
            )
          })}

          <div className="mx-1 h-5 w-px bg-border" />

          <Select value={model} onValueChange={(v) => setModel(v ?? "")}>
            {/* SelectValue hiển thị value thô, nên tự render nhãn tiếng Việt. */}
            <SelectTrigger className="h-7 w-44 text-[11px]">
              <span className="truncate">{model || `Mọi model (${models.length})`}</span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="" className="text-xs">Mọi model ({models.length})</SelectItem>
              {models.map((m) => (
                <SelectItem key={m} value={m} className="text-xs">{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={apiKey} onValueChange={(v) => setApiKey(v ?? "")}>
            <SelectTrigger className="h-7 w-40 text-[11px]">
              <span className="truncate">{apiKey || `Mọi API key (${apiKeys.length})`}</span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="" className="text-xs">Mọi API key ({apiKeys.length})</SelectItem>
              {apiKeys.map((k) => (
                <SelectItem key={k} value={k} className="text-xs">{k}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Tìm trong log…"
              className="h-7 w-44 pl-7 text-[11px]"
            />
          </div>

          {filtering ? (
            <Button variant="ghost" size="sm" onClick={clearFilters} className="h-7 gap-1 px-2 text-[11px]">
              <X className="h-3 w-3" />
              Bỏ lọc
            </Button>
          ) : null}

          {/* Trạng thái bộ lọc: luôn nói rõ đang hiện bao nhiêu trên tổng bao nhiêu. */}
          <div className="ml-auto flex items-center gap-2 text-[11px]">
            {paused ? (
              <Badge className="h-5 rounded bg-primary/15 px-1.5 text-[10px] text-primary">
                ĐANG DỪNG
              </Badge>
            ) : null}
            <span className={filtering ? "font-medium text-primary" : "text-muted-foreground"}>
              {filtering ? `lọc: ${shown.length}/${entries.length} dòng` : `${entries.length} dòng`}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* ── Danh sách log ────────────────────────────────────────────── */}
      <Card className="flex min-h-0 flex-1 flex-col border-border bg-card">
        <CardContent className="min-h-0 flex-1 overflow-y-auto p-0">
          {shown.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2">
              <ScrollText className="h-8 w-8 text-border" />
              <p className="text-sm text-muted-foreground">
                {entries.length === 0
                  ? connected
                    ? "Đang chờ request…"
                    : "Đang kết nối /events…"
                  : "Không dòng nào khớp bộ lọc"}
              </p>
              {entries.length > 0 && filtering ? (
                <Button variant="outline" size="sm" onClick={clearFilters} className="h-7 text-xs">
                  Bỏ lọc
                </Button>
              ) : null}
            </div>
          ) : (
            <div>
              {shown.map((e) => (
                <div
                  key={e.id}
                  className="border-b border-border/40 px-3 py-2 transition-colors hover:bg-background/60"
                >
                  {/* HÀNG 1 — thẻ */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                      {hhmmss(e.ts)}
                    </span>
                    <LogTag tone={KIND_TONE[e.kind]} value={KIND_LABEL[e.kind]} />
                    {e.status ? (
                      <LogTag tone={statusTone(e.status)} value={e.status} title="HTTP status" />
                    ) : null}
                    {e.model ? (
                      <LogTag tone="model" icon={<Cpu className="h-2.5 w-2.5" />} value={e.model} title="model" />
                    ) : null}
                    {e.apiKey ? (
                      <LogTag tone="key" icon={<KeyRound className="h-2.5 w-2.5" />} value={e.apiKey} title="API key" />
                    ) : null}
                    {e.combo ? (
                      <LogTag tone="combo" icon={<Shuffle className="h-2.5 w-2.5" />} value={e.combo} title="combo" />
                    ) : null}
                    {e.account && e.account !== "-" ? (
                      <LogTag tone="account" icon={<User className="h-2.5 w-2.5" />} value={e.account} title="account" />
                    ) : null}
                    {e.ms != null ? (
                      <LogTag tone="muted" icon={<Clock className="h-2.5 w-2.5" />} value={`${e.ms}ms`} title="thời gian" />
                    ) : null}
                    {e.tokens ? <LogTag tone="muted" value={`${e.tokens} tok`} title="tokens" /> : null}
                    {e.attempt && e.attempt > 1 ? (
                      <LogTag tone="warn" value={`lần ${e.attempt}`} title="lần thử" />
                    ) : null}
                  </div>

                  {/* HÀNG 2 — mô tả */}
                  <p
                    className={`mt-1 break-words font-mono text-[11px] leading-relaxed ${
                      e.kind === "err" ? "text-destructive/90" : "text-foreground"
                    }`}
                  >
                    {e.msg}
                  </p>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
