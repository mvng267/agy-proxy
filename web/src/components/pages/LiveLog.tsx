import { useEffect, useState, useRef, useCallback } from "react"
import {
  ScrollText,
  Trash2,
  Pause,
  Play,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

// ── Types ──────────────────────────────────────────────────────────────

type LogType = "req" | "ok" | "err" | "429" | "info" | "warn" | string

interface LogEntry {
  id: number
  type: LogType
  message: string
  timestamp: string
  raw: string
}

const MAX_ENTRIES = 200

// ── Log color helpers ──────────────────────────────────────────────────

function typeColor(type: LogType): string {
  switch (type) {
    case "req":
      return "text-blue-400"
    case "ok":
    case "200":
      return "text-emerald-400"
    case "err":
    case "error":
      return "text-red-400"
    case "429":
      return "text-orange-400"
    case "warn":
      return "text-amber-400"
    default:
      return "text-slate-400"
  }
}

function typeBadgeClass(type: LogType): string {
  switch (type) {
    case "req":
      return "bg-blue-500/15 text-blue-400 border-none"
    case "ok":
    case "200":
      return "bg-emerald-500/15 text-emerald-400 border-none"
    case "err":
    case "error":
      return "bg-red-500/15 text-red-400 border-none"
    case "429":
      return "bg-orange-500/15 text-orange-400 border-none"
    default:
      return "bg-slate-700 text-slate-400 border-none"
  }
}

function parseLogLine(raw: string, id: number): LogEntry {
  // Try to detect type from content
  let type: LogType = "info"
  const lower = raw.toLowerCase()

  if (lower.includes('"type":"req"') || lower.includes("→") || lower.includes("request")) {
    type = "req"
  } else if (lower.includes('"type":"ok"') || lower.includes("200") || lower.includes("success")) {
    type = "ok"
  } else if (lower.includes('"type":"err"') || lower.includes("error") || lower.includes("fail")) {
    type = "err"
  } else if (lower.includes("429") || lower.includes("rate limit") || lower.includes("cooldown")) {
    type = "429"
  } else if (lower.includes("warn")) {
    type = "warn"
  }

  // Try parse JSON for type field
  try {
    const parsed = JSON.parse(raw) as { type?: LogType; message?: string; msg?: string; time?: string; ts?: string }
    if (parsed.type) type = parsed.type
    return {
      id,
      type,
      message: parsed.message ?? parsed.msg ?? raw,
      timestamp: parsed.time ?? parsed.ts ?? new Date().toISOString(),
      raw,
    }
  } catch {
    return {
      id,
      type,
      message: raw,
      timestamp: new Date().toISOString(),
      raw,
    }
  }
}

// ── LiveLog Page ────────────────────────────────────────────────────────

export function LiveLog() {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [paused, setPaused] = useState(false)
  const [connected, setConnected] = useState(false)
  const [counts, setCounts] = useState({ req: 0, ok: 0, err: 0, "429": 0 })
  const bottomRef = useRef<HTMLDivElement>(null)
  const pausedRef = useRef(false)
  const counterRef = useRef(0)
  const esRef = useRef<EventSource | null>(null)

  const addEntry = useCallback((raw: string) => {
    if (pausedRef.current) return
    counterRef.current += 1
    const entry = parseLogLine(raw.trim(), counterRef.current)

    setEntries((prev) => {
      const next = [...prev, entry]
      return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next
    })

    setCounts((prev) => {
      const key = entry.type as keyof typeof prev
      if (key in prev) {
        return { ...prev, [key]: prev[key] + 1 }
      }
      return prev
    })
  }, [])

  // Auto-scroll
  useEffect(() => {
    if (!paused) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" })
    }
  }, [entries, paused])

  // EventSource connection
  useEffect(() => {
    const es = new EventSource("/events")
    esRef.current = es

    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)

    es.onmessage = (event: MessageEvent<string>) => {
      if (event.data) addEntry(event.data)
    }

    // Also listen for named event types
    const handleLog = (event: MessageEvent<string>) => {
      if (event.data) addEntry(event.data)
    }
    es.addEventListener("log", handleLog)
    es.addEventListener("req", handleLog)
    es.addEventListener("ok", handleLog)
    es.addEventListener("err", handleLog)

    return () => {
      es.close()
      esRef.current = null
      setConnected(false)
    }
  }, [addEntry])

  const handlePause = () => {
    pausedRef.current = !pausedRef.current
    setPaused(pausedRef.current)
  }

  const handleClear = () => {
    setEntries([])
    setCounts({ req: 0, ok: 0, err: 0, "429": 0 })
    counterRef.current = 0
  }

  return (
    <div className="flex flex-col h-[calc(100vh-10rem)] gap-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 flex-shrink-0">
        <div className="flex items-center gap-2">
          <ScrollText className="h-4 w-4 text-slate-500" />
          <h2 className="text-sm font-medium text-slate-300">Live Log</h2>
          <div
            className={`h-2 w-2 rounded-full ml-1 ${
              connected ? "bg-emerald-400 ring-2 ring-emerald-400/25" : "bg-slate-600"
            }`}
          />
          <span className="text-xs text-slate-500">
            {connected ? "Connected" : "Disconnected"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* Counters */}
          <Badge className="bg-blue-500/15 text-blue-400 border-none text-[10px]">
            REQ {counts.req}
          </Badge>
          <Badge className="bg-emerald-500/15 text-emerald-400 border-none text-[10px]">
            OK {counts.ok}
          </Badge>
          <Badge className="bg-red-500/15 text-red-400 border-none text-[10px]">
            ERR {counts.err}
          </Badge>
          <Badge className="bg-orange-500/15 text-orange-400 border-none text-[10px]">
            429 {counts["429"]}
          </Badge>

          <Button
            variant="outline"
            size="sm"
            onClick={handlePause}
            className={`border-slate-700 h-7 text-xs gap-1 ${
              paused
                ? "text-orange-400 border-orange-700"
                : "text-slate-400 hover:text-orange-400"
            }`}
          >
            {paused ? (
              <>
                <Play className="h-3 w-3" /> Resume
              </>
            ) : (
              <>
                <Pause className="h-3 w-3" /> Pause
              </>
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleClear}
            className="border-slate-700 text-slate-400 hover:text-red-400 h-7 text-xs gap-1"
          >
            <Trash2 className="h-3 w-3" /> Clear
          </Button>
        </div>
      </div>

      {/* Log pane */}
      <Card className="bg-slate-900 border-slate-800 flex-1 min-h-0 flex flex-col">
        <CardHeader className="pb-2 flex-shrink-0">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xs font-medium text-slate-500">
              {entries.length} / {MAX_ENTRIES} entries
            </CardTitle>
            {paused && (
              <Badge className="bg-orange-500/15 text-orange-400 border-none text-[10px]">
                PAUSED
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="flex-1 min-h-0 overflow-y-auto p-0">
          {entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <ScrollText className="h-8 w-8 text-slate-700" />
              <p className="text-sm text-slate-600">
                {connected ? "Đang chờ events..." : "Đang kết nối /events..."}
              </p>
            </div>
          ) : (
            <div className="font-mono text-xs">
              {entries.map((entry) => (
                <div
                  key={entry.id}
                  className={`flex items-start gap-2 px-4 py-1 hover:bg-slate-800/40 border-b border-slate-800/30 ${typeColor(entry.type)}`}
                >
                  <span className="text-slate-600 flex-shrink-0 tabular-nums text-[10px] mt-0.5">
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </span>
                  <Badge
                    className={`flex-shrink-0 text-[9px] px-1 py-0 h-4 mt-0.5 ${typeBadgeClass(entry.type)}`}
                  >
                    {entry.type.toUpperCase()}
                  </Badge>
                  <span className="break-all leading-relaxed">{entry.message}</span>
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
