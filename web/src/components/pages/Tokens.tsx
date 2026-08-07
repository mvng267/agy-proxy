import { useEffect, useState, useCallback } from "react"
import {
  KeyRound,
  RefreshCw,
  AlertTriangle,
  Eye,
  EyeOff,
  Copy,
  Check,
  Download,
  ShieldCheck,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"

// ── Types ──────────────────────────────────────────────────────────────

interface Credential {
  email: string
  target: string
  value: string
  health?: string
  expires_at?: string
  omniroute_connection_id?: string
  updated_at?: string
}

interface CheckResult {
  ok: boolean
  alive?: number
  dead?: number
  unknown?: number
  total?: number
}

// ── helpers ────────────────────────────────────────────────────────────

function maskToken(val: string): string {
  if (val === "stored_in_omniroute") return "(lưu trong OmniRoute)"
  if (val.length <= 16) return val
  return val.slice(0, 6) + "••••••" + val.slice(-4)
}

function tokenInfo(c: Credential): string {
  if (c.target === "kiro") {
    try {
      const j = JSON.parse(c.value) as { profileArn?: string; region?: string }
      const arn = j.profileArn ? j.profileArn.split("/").pop() ?? "" : ""
      return [arn, j.region].filter(Boolean).join(" · ")
    } catch {
      return ""
    }
  }
  if (c.target === "gweb") {
    return c.expires_at ? "hết hạn " + new Date(c.expires_at).toLocaleDateString("vi-VN") : "cookie"
  }
  if (c.omniroute_connection_id) {
    return "conn " + c.omniroute_connection_id.slice(0, 8)
  }
  return ""
}

function downloadFile(name: string, content: string, type: string) {
  const a = document.createElement("a")
  a.href = URL.createObjectURL(new Blob([content], { type }))
  a.download = name
  a.click()
}

// ── Health badge ───────────────────────────────────────────────────────

function HealthBadge({ health }: { health?: string }) {
  if (health === "alive") {
    return (
      <Badge className="bg-emerald-500/15 text-emerald-400 border-none text-[10px]">
        alive
      </Badge>
    )
  }
  if (health === "dead") {
    return (
      <Badge className="bg-red-500/15 text-red-400 border-none text-[10px]">dead</Badge>
    )
  }
  return (
    <Badge className="bg-slate-700 text-slate-400 border-none text-[10px]">—</Badge>
  )
}

// ── Provider badge ─────────────────────────────────────────────────────

function TargetBadge({ target }: { target: string }) {
  const map: Record<string, string> = {
    agy: "bg-orange-500/15 text-orange-400",
    kiro: "bg-blue-500/15 text-blue-400",
    gweb: "bg-purple-500/15 text-purple-400",
  }
  const cls = map[target] ?? "bg-slate-700 text-slate-400"
  return (
    <Badge className={`${cls} border-none text-[10px]`}>{target}</Badge>
  )
}

// ── Row component ──────────────────────────────────────────────────────

function TokenRow({ cred }: { cred: Credential }) {
  const [shown, setShown] = useState(false)
  const [copied, setCopied] = useState(false)

  const rawVal = cred.target === "kiro"
    ? (() => {
        try {
          return (JSON.parse(cred.value) as { refreshToken?: string }).refreshToken ?? cred.value
        } catch {
          return cred.value
        }
      })()
    : cred.value

  const isReal = !(cred.target === "agy" && rawVal.startsWith("("))

  const displayValue = shown ? rawVal : maskToken(rawVal)
  const info = tokenInfo(cred)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(rawVal)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }

  return (
    <TableRow className="border-slate-800 hover:bg-slate-800/40">
      <TableCell className="text-sm text-slate-200 font-mono max-w-[200px] truncate" title={cred.email}>
        {cred.email}
      </TableCell>
      <TableCell>
        <TargetBadge target={cred.target} />
      </TableCell>
      <TableCell>
        <HealthBadge health={cred.health} />
      </TableCell>
      <TableCell className="font-mono text-xs text-slate-400 max-w-[220px]">
        <span
          className="select-all"
          title={shown ? rawVal : undefined}
          style={{ wordBreak: "break-all" }}
        >
          {displayValue}
        </span>
        {isReal && (
          <span className="inline-flex gap-1 ml-1.5 align-middle">
            <button
              onClick={() => setShown(!shown)}
              className="p-0.5 rounded text-slate-600 hover:text-slate-300 transition-colors"
              title={shown ? "Ẩn" : "Hiện"}
            >
              {shown ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            </button>
            <button
              onClick={handleCopy}
              className="p-0.5 rounded text-slate-600 hover:text-slate-300 transition-colors"
              title="Copy token"
            >
              {copied ? (
                <Check className="h-3 w-3 text-emerald-400" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </button>
          </span>
        )}
        {info && <span className="block text-slate-600 text-[10px] mt-0.5">{info}</span>}
      </TableCell>
      <TableCell className="text-xs text-slate-500">
        {cred.updated_at ? new Date(cred.updated_at).toLocaleString("vi-VN") : "—"}
      </TableCell>
    </TableRow>
  )
}

// ── Tokens Page ────────────────────────────────────────────────────────

export function Tokens() {
  const [creds, setCreds] = useState<Credential[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Filters
  const [filterTarget, setFilterTarget] = useState<string>("all")
  const [filterHealth, setFilterHealth] = useState<string>("all")
  const [search, setSearch] = useState("")

  // Check health
  const [checking, setChecking] = useState(false)
  const [checkMsg, setCheckMsg] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/credentials")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as { credentials: Credential[] }
      setCreds(json.credentials ?? [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    const iv = setInterval(fetchData, 60_000)
    return () => clearInterval(iv)
  }, [fetchData])

  // ── Check health ───────────────────────────────────────────────────

  const handleCheck = async () => {
    setChecking(true)
    setCheckMsg(null)
    try {
      const body: Record<string, string> = {}
      if (filterTarget !== "all") body.target = filterTarget
      const res = await fetch("/api/tokens/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = (await res.json()) as CheckResult
      if (json.ok !== false) {
        setCheckMsg(
          `🟢 ${json.alive ?? 0}  🔴 ${json.dead ?? 0}  ⚪ ${json.unknown ?? 0} / ${json.total ?? 0}`
        )
        fetchData()
      }
    } catch (err) {
      setCheckMsg(err instanceof Error ? err.message : "Check lỗi")
    } finally {
      setChecking(false)
    }
  }

  // ── Export CSV ─────────────────────────────────────────────────────

  const handleExport = () => {
    const list = filtered
    const rows: string[][] = [["email", "target", "value", "health", "omniroute_connection_id", "updated_at"]]
    for (const c of list) {
      rows.push([c.email, c.target, c.value, c.health ?? "", c.omniroute_connection_id ?? "", c.updated_at ?? ""])
    }
    const csv = rows
      .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
      .join("\r\n")
    const suffix = filterTarget !== "all" ? "_" + filterTarget : ""
    downloadFile(`credentials${suffix}.csv`, csv, "text/csv")
  }

  // ── Filter + sort ─────────────────────────────────────────────────

  const filtered = creds
    .filter((c) => {
      if (filterTarget !== "all" && c.target !== filterTarget) return false
      if (filterHealth !== "all" && (c.health ?? "unknown") !== filterHealth) return false
      if (search && !c.email.toLowerCase().includes(search.toLowerCase())) return false
      return true
    })
    .sort((a, b) => {
      // stored_in_omniroute goes last
      const aReal = a.value !== "stored_in_omniroute" ? 0 : 1
      const bReal = b.value !== "stored_in_omniroute" ? 0 : 1
      return aReal - bReal
    })

  // ── Stats ─────────────────────────────────────────────────────────

  const alive = creds.filter((c) => c.health === "alive").length
  const dead = creds.filter((c) => c.health === "dead").length
  const unknown = creds.length - alive - dead

  const targets = Array.from(new Set(creds.map((c) => c.target))).sort()

  // ── Loading ────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20 w-full bg-slate-800" />
        <Skeleton className="h-64 w-full bg-slate-800" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <AlertTriangle className="h-8 w-8 text-red-500" />
        <p className="text-sm text-slate-400">Lỗi: {error}</p>
        <button
          onClick={fetchData}
          className="text-xs text-orange-400 hover:text-orange-300 flex items-center gap-1.5"
        >
          <RefreshCw className="h-3 w-3" /> Retry
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card className="bg-slate-900 border-slate-800">
          <CardContent className="pt-4 pb-3">
            <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Tổng</p>
            <p className="text-2xl font-bold text-slate-100 tabular-nums">{creds.length}</p>
          </CardContent>
        </Card>
        <Card className="bg-slate-900 border-slate-800">
          <CardContent className="pt-4 pb-3">
            <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Alive</p>
            <p className="text-2xl font-bold text-emerald-400 tabular-nums">{alive}</p>
          </CardContent>
        </Card>
        <Card className="bg-slate-900 border-slate-800">
          <CardContent className="pt-4 pb-3">
            <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Dead</p>
            <p className="text-2xl font-bold text-red-400 tabular-nums">{dead}</p>
          </CardContent>
        </Card>
        <Card className="bg-slate-900 border-slate-800">
          <CardContent className="pt-4 pb-3">
            <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Chưa rõ</p>
            <p className="text-2xl font-bold text-slate-400 tabular-nums">{unknown}</p>
          </CardContent>
        </Card>
      </div>

      {/* Health bar */}
      {creds.length > 0 && (
        <div className="flex items-center gap-2">
          <div className="flex-1 h-2 rounded-full overflow-hidden bg-slate-800 flex">
            <div
              className="h-full bg-emerald-500 transition-all"
              style={{ width: `${(alive / creds.length) * 100}%` }}
            />
            <div
              className="h-full bg-red-500 transition-all"
              style={{ width: `${(dead / creds.length) * 100}%` }}
            />
            <div
              className="h-full bg-slate-600 transition-all"
              style={{ width: `${(unknown / creds.length) * 100}%` }}
            />
          </div>
          <span className="text-xs text-slate-500 whitespace-nowrap">
            {Math.round((alive / creds.length) * 100)}% alive
          </span>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-2 items-start sm:items-center">
        <div className="relative flex-1 max-w-xs">
          <KeyRound className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500" />
          <Input
            placeholder="Tìm email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 bg-slate-900 border-slate-800 text-slate-200 placeholder:text-slate-600 h-8 text-sm"
          />
        </div>

        <Select value={filterTarget} onValueChange={(v) => setFilterTarget(v ?? "all")}>
          <SelectTrigger className="w-32 h-8 bg-slate-900 border-slate-800 text-slate-300 text-xs">
            <SelectValue placeholder="Provider" />
          </SelectTrigger>
          <SelectContent className="bg-slate-900 border-slate-800">
            <SelectItem value="all" className="text-xs text-slate-300">Tất cả</SelectItem>
            {targets.map((t) => (
              <SelectItem key={t} value={t} className="text-xs text-slate-300">
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={filterHealth} onValueChange={(v) => setFilterHealth(v ?? "all")}>
          <SelectTrigger className="w-32 h-8 bg-slate-900 border-slate-800 text-slate-300 text-xs">
            <SelectValue placeholder="Health" />
          </SelectTrigger>
          <SelectContent className="bg-slate-900 border-slate-800">
            <SelectItem value="all" className="text-xs text-slate-300">Tất cả</SelectItem>
            <SelectItem value="alive" className="text-xs text-emerald-400">alive</SelectItem>
            <SelectItem value="dead" className="text-xs text-red-400">dead</SelectItem>
            <SelectItem value="unknown" className="text-xs text-slate-400">chưa rõ</SelectItem>
          </SelectContent>
        </Select>

        <Button
          size="sm"
          onClick={handleCheck}
          disabled={checking}
          className="bg-orange-500 hover:bg-orange-600 text-white h-8 text-xs gap-1.5 ml-auto"
        >
          {checking ? (
            <RefreshCw className="h-3 w-3 animate-spin" />
          ) : (
            <ShieldCheck className="h-3 w-3" />
          )}
          {checking ? "Đang check…" : "Check health"}
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={handleExport}
          className="border-slate-700 text-slate-400 hover:text-orange-400 h-8 text-xs gap-1"
        >
          <Download className="h-3 w-3" /> Export CSV
        </Button>
      </div>

      {checkMsg && (
        <p className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded px-3 py-1.5">
          {checkMsg}
        </p>
      )}

      {/* Table */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-slate-500" />
            Credentials ({filtered.length} / {creds.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="border-slate-800 hover:bg-transparent">
                <TableHead className="text-slate-500 text-xs pl-4">Email</TableHead>
                <TableHead className="text-slate-500 text-xs">Target</TableHead>
                <TableHead className="text-slate-500 text-xs">Health</TableHead>
                <TableHead className="text-slate-500 text-xs">Token</TableHead>
                <TableHead className="text-slate-500 text-xs">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow className="border-slate-800">
                  <TableCell colSpan={5} className="text-center text-slate-600 text-xs py-10">
                    {creds.length === 0
                      ? "Chưa có credential nào"
                      : "Không khớp bộ lọc"}
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((c, i) => (
                  <TokenRow key={`${c.email}-${c.target}-${i}`} cred={c} />
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
