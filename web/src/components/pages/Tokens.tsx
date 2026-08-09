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
import { DataTable } from "@/components/common/DataTable"
import { KpiCard } from "@/components/common"
import { SegmentBar } from "@/components/common/charts"
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
      <Badge className="bg-success/15 text-success">
        alive
      </Badge>
    )
  }
  if (health === "dead") {
    return (
      <Badge className="bg-destructive/15 text-destructive">dead</Badge>
    )
  }
  return (
    <Badge className="bg-muted text-muted-foreground">—</Badge>
  )
}

// ── Provider badge ─────────────────────────────────────────────────────

function TargetBadge({ target }: { target: string }) {
  const map: Record<string, string> = {
    agy: "bg-primary/15 text-primary",
    kiro: "bg-info/15 text-info",
    gweb: "bg-info/15 text-info",
  }
  const cls = map[target] ?? "bg-muted text-muted-foreground"
  return (
    <Badge className={cls}>{target}</Badge>
  )
}

// ── Row component ──────────────────────────────────────────────────────

/**
 * Ô "Token" — TÁCH RIÊNG vì mang state cục bộ (đang hiện hay ẩn, vừa copy chưa).
 * DataTable render ô qua `column.render`, mà hook không gọi được trong hàm đó, nên phải
 * là component thật.
 */
function TokenCell({ cred }: { cred: Credential }) {
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
    <div className="max-w-[260px] font-mono text-xs text-muted-foreground">
      <span className="select-all" title={shown ? rawVal : undefined} style={{ wordBreak: "break-all" }}>
        {displayValue}
      </span>
      {isReal && (
        <span className="ml-1.5 inline-flex gap-1 align-middle">
          <button
            onClick={() => setShown(!shown)}
            className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
            title={shown ? "Ẩn" : "Hiện"}
          >
            {shown ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
          </button>
          <button
            onClick={handleCopy}
            className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
            title="Copy token"
          >
            {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
          </button>
        </span>
      )}
      {info && <span className="mt-0.5 block text-[10px] text-muted-foreground">{info}</span>}
    </div>
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
        <Skeleton className="h-20 w-full bg-muted" />
        <Skeleton className="h-64 w-full bg-muted" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <AlertTriangle className="h-8 w-8 text-destructive" />
        <p className="text-sm text-muted-foreground">Lỗi: {error}</p>
        <button
          onClick={fetchData}
          className="text-xs text-primary hover:text-primary flex items-center gap-1.5"
        >
          <RefreshCw className="h-3 w-3" /> Retry
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* KPI row — KpiCard chung: 4 dấu góc + nền lưới + cỡ chữ chuẩn Atlas. Trước
          đây là Card tay dùng text-2xl/bold nên trang này trông khác phần còn lại. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="Tổng" value={creds.length} icon={KeyRound} loading={loading} />
        <KpiCard label="Alive" value={alive} tone="success" sub={creds.length ? `${Math.round((alive / creds.length) * 100)}% tổng` : undefined} loading={loading} />
        <KpiCard label="Dead" value={dead} tone="danger" loading={loading} />
        <KpiCard label="Chưa rõ" value={unknown} loading={loading} />
      </div>

      {/* Ba trạng thái cộng lại đúng 100% → SegmentBar, thay stacked bar tự dựng bằng div. */}
      {creds.length > 0 && (
        <SegmentBar
          segments={[
            { label: "Alive", value: alive, tone: "success" },
            { label: "Dead", value: dead, tone: "danger" },
            { label: "Chưa rõ", value: unknown, tone: "muted" },
          ]}
        />
      )}

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-2 items-start sm:items-center">
        <div className="relative flex-1 max-w-xs">
          <KeyRound className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Tìm email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 bg-card border-border text-foreground placeholder:text-muted-foreground h-8 text-sm"
          />
        </div>

        <Select value={filterTarget} onValueChange={(v) => setFilterTarget(v ?? "all")}>
          <SelectTrigger className="w-32 h-8 bg-card border-border text-foreground text-xs">
            <SelectValue placeholder="Provider" />
          </SelectTrigger>
          <SelectContent className="bg-card border-border">
            <SelectItem value="all" className="text-xs text-foreground">Tất cả</SelectItem>
            {targets.map((t) => (
              <SelectItem key={t} value={t} className="text-xs text-foreground">
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={filterHealth} onValueChange={(v) => setFilterHealth(v ?? "all")}>
          <SelectTrigger className="w-32 h-8 bg-card border-border text-foreground text-xs">
            <SelectValue placeholder="Health" />
          </SelectTrigger>
          <SelectContent className="bg-card border-border">
            <SelectItem value="all" className="text-xs text-foreground">Tất cả</SelectItem>
            <SelectItem value="alive" className="text-xs text-success">alive</SelectItem>
            <SelectItem value="dead" className="text-xs text-destructive">dead</SelectItem>
            <SelectItem value="unknown" className="text-xs text-muted-foreground">chưa rõ</SelectItem>
          </SelectContent>
        </Select>

        <Button
          size="sm"
          onClick={handleCheck}
          disabled={checking}
          className="bg-primary hover:bg-primary text-primary-foreground h-8 text-xs gap-1.5 ml-auto"
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
          className="border-border text-muted-foreground hover:text-primary h-8 text-xs gap-1"
        >
          <Download className="h-3 w-3" /> Export CSV
        </Button>
      </div>

      {checkMsg && (
        <p className="text-xs text-success bg-success/10 border border-success/20 rounded px-3 py-1.5">
          {checkMsg}
        </p>
      )}

      {/* Table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-foreground flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-muted-foreground" />
            Credentials ({filtered.length} / {creds.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable
            rows={filtered}
            rowKey={(c) => `${c.email}-${c.target}`}
            pageSize={25}
            empty={creds.length === 0 ? "Chưa có credential nào" : "Không khớp bộ lọc"}
            initialSort={{ key: "email", dir: "asc" }}
            columns={[
              {
                key: "email",
                header: "Email",
                sort: (c) => c.email,
                render: (c) => (
                  <span className="block max-w-[220px] truncate font-mono text-sm text-foreground" title={c.email}>
                    {c.email}
                  </span>
                ),
              },
              { key: "target", header: "Target", sort: (c) => c.target, render: (c) => <TargetBadge target={c.target} /> },
              { key: "health", header: "Health", sort: (c) => c.health ?? "", render: (c) => <HealthBadge health={c.health} /> },
              { key: "value", header: "Token", render: (c) => <TokenCell cred={c} /> },
              {
                key: "updated_at",
                header: "Updated",
                sort: (c) => c.updated_at ?? 0,
                render: (c) => (
                  <span className="text-xs text-muted-foreground">
                    {c.updated_at ? new Date(c.updated_at).toLocaleString("vi-VN") : "—"}
                  </span>
                ),
              },
            ]}
          />
        </CardContent>
      </Card>
    </div>
  )
}
