import { useState, useRef, useCallback, useEffect } from "react"
import {
  UserPlus,
  AlertTriangle,
  CheckCircle2,
  Upload,
  Loader2,
  Users,
  Wand2,
  FileText,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

// ── Types ──────────────────────────────────────────────────────────────

type Tab = "single" | "bulk" | "generate"

interface ProxyLabel {
  label: string
}

// ── Helpers ────────────────────────────────────────────────────────────

function Tab3({
  active,
  id,
  label,
  icon,
  onClick,
}: {
  active: boolean
  id: Tab
  label: string
  icon: React.ReactNode
  onClick: (id: Tab) => void
}) {
  return (
    <button
      onClick={() => onClick(id)}
      className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-colors ${
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-muted"
      }`}
    >
      {icon}
      {label}
    </button>
  )
}

function ResultBox({
  ok,
  message,
}: {
  ok: boolean
  message: string
}) {
  return (
    <div
      className={`flex items-start gap-2 p-3 rounded-lg border text-sm ${
        ok
          ? "bg-success/30 border-success/50 text-success"
          : "bg-destructive/30 border-destructive/50 text-destructive"
      }`}
    >
      {ok ? (
        <CheckCircle2 className="h-4 w-4 text-success mt-0.5 shrink-0" />
      ) : (
        <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
      )}
      <span>{message}</span>
    </div>
  )
}

// ── Single tab ─────────────────────────────────────────────────────────

function SingleForm({ proxyLabels }: { proxyLabels: string[] }) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [totp, setTotp] = useState("")
  const [proxy, setProxy] = useState("")
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null)

  const handleSubmit = async () => {
    if (!email.trim()) return
    setLoading(true)
    setResult(null)
    try {
      const res = await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          password,
          totp_secret: totp.trim() || undefined,
          proxy: proxy || undefined,
        }),
      })
      const json = await res.json() as { added?: number; error?: string; ok?: boolean }
      if (!res.ok || json.error) {
        setResult({ ok: false, msg: json.error ?? `HTTP ${res.status}` })
      } else {
        setResult({ ok: true, msg: "Đã thêm tài khoản thành công" })
        setEmail("")
        setPassword("")
        setTotp("")
        setProxy("")
      }
    } catch (err) {
      setResult({ ok: false, msg: err instanceof Error ? err.message : "Lỗi" })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Email *</label>
          <Input
            type="email"
            placeholder="user@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="bg-background border-border text-foreground placeholder:text-muted-foreground h-9 text-sm"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Password</label>
          <Input
            type="password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="bg-background border-border text-foreground placeholder:text-muted-foreground h-9 text-sm"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">TOTP Secret (tùy chọn)</label>
          <Input
            placeholder="JBSWY3DPEHPK3PXP"
            value={totp}
            onChange={(e) => setTotp(e.target.value)}
            className="bg-background border-border text-foreground placeholder:text-muted-foreground h-9 text-sm font-mono"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Proxy (tùy chọn)</label>
          <select
            value={proxy}
            onChange={(e) => setProxy(e.target.value)}
            className="w-full h-9 px-2 rounded-md bg-background border border-border text-foreground text-sm focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="">(không gán)</option>
            {proxyLabels.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>
      </div>

      <Button
        onClick={handleSubmit}
        disabled={loading || !email.trim()}
        className="bg-primary hover:bg-primary text-primary-foreground h-9 text-sm gap-2"
      >
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
        {loading ? "Đang thêm…" : "Thêm tài khoản"}
      </Button>

      {result && <ResultBox ok={result.ok} message={result.msg} />}
    </div>
  )
}

// ── Bulk import tab ────────────────────────────────────────────────────

function BulkForm() {
  const [text, setText] = useState("")
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleImport = async (content: string) => {
    if (!content.trim()) return
    setLoading(true)
    setResult(null)
    try {
      const res = await fetch("/api/accounts/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: content }),
      })
      const json = await res.json() as { added?: number; error?: string }
      if (!res.ok || json.error) {
        setResult({ ok: false, msg: json.error ?? `HTTP ${res.status}` })
      } else {
        setResult({ ok: true, msg: `Đã import ${json.added ?? 0} tài khoản` })
        setText("")
      }
    } catch (err) {
      setResult({ ok: false, msg: err instanceof Error ? err.message : "Lỗi" })
    } finally {
      setLoading(false)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const content = String(reader.result)
      setText(content)
    }
    reader.readAsText(file)
  }

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setText(String(reader.result))
    reader.readAsText(file)
    e.target.value = ""
  }

  const lineCount = text.split("\n").filter((l) => l.trim()).length

  return (
    <div className="space-y-3">
      <div
        className={`relative rounded-lg border-2 border-dashed transition-colors ${
          dragging ? "border-primary bg-primary/5" : "border-border hover:border-border"
        }`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"Paste danh sách email (mỗi dòng 1 email) hoặc kéo thả file vào đây:\n\nuser1@example.com\nuser2@example.com\n\nHoặc JSON:\n{\"email\": \"user@example.com\", \"password\": \"pass\"}"}
          rows={10}
          className="w-full bg-transparent px-3 py-2.5 text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none resize-y"
        />
        {dragging && (
          <div className="absolute inset-0 flex items-center justify-center bg-card/80 rounded-lg pointer-events-none">
            <p className="text-primary font-medium text-sm">Thả file vào đây</p>
          </div>
        )}
      </div>

      {lineCount > 0 && (
        <p className="text-xs text-muted-foreground">
          Nhận diện{" "}
          <span className="text-primary font-medium">{lineCount}</span> dòng
        </p>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <Button
          onClick={() => handleImport(text)}
          disabled={loading || !text.trim()}
          className="bg-primary hover:bg-primary text-primary-foreground h-9 text-sm gap-2"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          {loading ? "Đang import…" : "Import"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
          className="border-border text-muted-foreground hover:text-foreground h-9 text-xs gap-1.5"
        >
          <FileText className="h-3.5 w-3.5" />
          Chọn file
        </Button>
        {text.trim() && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setText(""); setResult(null) }}
            className="text-muted-foreground hover:text-foreground h-9 text-xs"
          >
            Xoá
          </Button>
        )}
        <input ref={fileInputRef} type="file" accept=".txt,.csv,.json" className="hidden" onChange={handleFile} />
      </div>

      {result && <ResultBox ok={result.ok} message={result.msg} />}
    </div>
  )
}

// ── Generate range tab ─────────────────────────────────────────────────

function GenerateForm() {
  const [prefix, setPrefix] = useState("")
  const [start, setStart] = useState(1)
  const [count, setCount] = useState(10)
  const [domain, setDomain] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null)

  // Preview: how many accounts will be created
  const preview = count > 0 ? count : 0

  // Example of first and last email
  const exampleFirst =
    prefix && domain
      ? `${prefix}${String(start).padStart(String(start + count - 1).length, "0")}@${domain}`
      : ""
  const exampleLast =
    prefix && domain
      ? `${prefix}${String(start + count - 1).padStart(String(start + count - 1).length, "0")}@${domain}`
      : ""

  const handleGenerate = async () => {
    if (!prefix.trim() || !domain.trim()) return
    setLoading(true)
    setResult(null)
    try {
      const res = await fetch("/api/accounts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prefix: prefix.trim(),
          start,
          end: start + count - 1,
          domain: domain.trim(),
          password,
        }),
      })
      const json = await res.json() as { added?: number; error?: string }
      if (!res.ok || json.error) {
        setResult({ ok: false, msg: json.error ?? `HTTP ${res.status}` })
      } else {
        setResult({ ok: true, msg: `Đã tạo ${json.added ?? count} tài khoản` })
      }
    } catch (err) {
      setResult({ ok: false, msg: err instanceof Error ? err.message : "Lỗi" })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Prefix *</label>
          <Input
            placeholder="user"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            className="bg-background border-border text-foreground placeholder:text-muted-foreground h-9 text-sm font-mono"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Domain *</label>
          <Input
            placeholder="gmail.com"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            className="bg-background border-border text-foreground placeholder:text-muted-foreground h-9 text-sm font-mono"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Bắt đầu từ số</label>
          <Input
            type="number"
            min={1}
            value={start}
            onChange={(e) => setStart(Math.max(1, parseInt(e.target.value) || 1))}
            className="bg-background border-border text-foreground h-9 text-sm tabular-nums"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Số lượng</label>
          <Input
            type="number"
            min={1}
            max={500}
            value={count}
            onChange={(e) => setCount(Math.max(1, Math.min(500, parseInt(e.target.value) || 1)))}
            className="bg-background border-border text-foreground h-9 text-sm tabular-nums"
          />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <label className="text-xs text-muted-foreground">Password (dùng chung)</label>
          <Input
            type="password"
            placeholder="Password cho tất cả account"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="bg-background border-border text-foreground placeholder:text-muted-foreground h-9 text-sm"
          />
        </div>
      </div>

      {/* Preview */}
      {preview > 0 && prefix && domain && (
        <div className="bg-muted/50 rounded-lg px-3 py-2.5 space-y-1">
          <p className="text-xs text-muted-foreground font-medium">Preview ({preview} account)</p>
          <p className="text-xs font-mono text-foreground">
            {exampleFirst}
            {count > 1 && (
              <>
                <span className="text-muted-foreground mx-2">→</span>
                {exampleLast}
              </>
            )}
          </p>
        </div>
      )}

      <Button
        onClick={handleGenerate}
        disabled={loading || !prefix.trim() || !domain.trim() || count < 1}
        className="bg-primary hover:bg-primary text-primary-foreground h-9 text-sm gap-2"
      >
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
        {loading ? "Đang tạo…" : `Tạo ${preview} tài khoản`}
      </Button>

      {result && <ResultBox ok={result.ok} message={result.msg} />}
    </div>
  )
}

// ── AddAccount Page ────────────────────────────────────────────────────

export function AddAccount() {
  const [tab, setTab] = useState<Tab>("single")
  const [proxyLabels, setProxyLabels] = useState<string[]>([])

  // Fetch proxy labels for the single-account proxy dropdown
  const fetchProxies = useCallback(async () => {
    try {
      const res = await fetch("/api/proxies")
      if (!res.ok) return
      const json = (await res.json()) as { proxies: ProxyLabel[] }
      setProxyLabels((json.proxies ?? []).map((p) => p.label).filter(Boolean))
    } catch {
      // ignore — proxy list is optional
    }
  }, [])

  useEffect(() => {
    fetchProxies()
  }, [fetchProxies])

  return (
    <div className="space-y-4 max-w-2xl">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-foreground flex items-center gap-2">
            <UserPlus className="h-4 w-4 text-muted-foreground" />
            Thêm tài khoản
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Tab switcher */}
          <div className="flex items-center gap-1 bg-muted/50 rounded-lg p-1 w-fit">
            <Tab3
              active={tab === "single"}
              id="single"
              label="Thêm 1 account"
              icon={<UserPlus className="h-3 w-3" />}
              onClick={setTab}
            />
            <Tab3
              active={tab === "bulk"}
              id="bulk"
              label="Import hàng loạt"
              icon={<Users className="h-3 w-3" />}
              onClick={setTab}
            />
            <Tab3
              active={tab === "generate"}
              id="generate"
              label="Tạo dải"
              icon={<Wand2 className="h-3 w-3" />}
              onClick={setTab}
            />
          </div>

          {/* Content */}
          {tab === "single" && <SingleForm proxyLabels={proxyLabels} />}
          {tab === "bulk" && <BulkForm />}
          {tab === "generate" && <GenerateForm />}
        </CardContent>
      </Card>
    </div>
  )
}
