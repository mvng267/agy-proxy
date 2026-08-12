import { useEffect, useState, useCallback } from "react"
import {
  RefreshCw,
  AlertTriangle,
  Save,
  CheckCircle2,
  Key,
  Copy,
  Eye,
  EyeOff,
  Power,
  Shield,
  Trash2,
  RotateCcw,
  Lock,
} from "lucide-react"
import { UpdatePanel } from "@/components/common/UpdatePanel"
import { PageHeader, writeClipboard } from "@/components/common"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Skeleton } from "@/components/ui/skeleton"
import { Separator } from "@/components/ui/separator"

// ── Types ──────────────────────────────────────────────────────────────

interface GatewayConfig {
  enabled?: boolean
  rotation?: string
  cooldownSec?: number
  maxRetries?: number
  timeout?: number
  logLevel?: string
  apiKey?: string
  baseUrl?: string
  outboundProxy?: string
  [key: string]: unknown
}

interface Session {
  id: string
  ua?: string
  ip?: string
  created_at?: number
  last_seen?: number
  current?: boolean
}

// ── Helpers ───────────────────────────────────────────────────────────

function fmtAgo(ms?: number) {
  if (!ms) return "—"
  const d = Date.now() - ms
  if (d < 60000) return Math.max(1, Math.round(d / 1000)) + "s trước"
  if (d < 3600000) return Math.round(d / 60000) + "p trước"
  if (d < 86400000) return Math.round(d / 3600000) + "h trước"
  return Math.round(d / 86400000) + "d trước"
}

function Toast({ msg, onClose }: { msg: string; onClose: () => void }) {
  useEffect(() => { const t = setTimeout(onClose, 2600); return () => clearTimeout(t) }, [onClose])
  return (
    <div className="fixed bottom-4 right-4 z-50 bg-muted border border-border text-foreground text-sm px-4 py-2 rounded-lg shadow-lg">
      {msg}
    </div>
  )
}

// ── Settings Page ───────────────────────────────────────────────────────

/**
 * PHẢI khớp enum `gatewayRotation` ở src/config.ts.
 *
 * Trước đây danh sách này là "random / least-used / first-available" — BA giá trị
 * backend KHÔNG hề có, chọn vào là bị SPECS từ chối; đồng thời "highest-first" (giá
 * trị đang chạy thật) lại không có trong danh sách nên không ai chọn lại được sau khi
 * đổi đi. Mô tả ghi rõ từng chiến lược làm gì để không phải đoán qua tên.
 */
const ROTATION_OPTIONS = [
  { value: "round-robin", label: "Round Robin", desc: "Xoay đều cả pool — account lâu chưa dùng nhất đi trước." },
  { value: "highest-first", label: "Quota cao nhất", desc: "Ưu tiên account còn nhiều hạn mức nhất ở đúng bể của model." },
  { value: "smart", label: "Thông minh", desc: "Chấm điểm tổng hợp: quota 45% · tỉ lệ lỗi 25% · độ trễ 15% · tải 15%." },
  { value: "full-first", label: "Dùng cạn dần", desc: "Dồn vào account quota thấp nhất còn dùng được, cạn rồi mới sang cái kế." },
  { value: "failover", label: "Failover", desc: "Bám một account tới khi nó hỏng mới đổi." },
]

export function Settings() {
  const [config, setConfig] = useState<GatewayConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  // Form state
  const [enabled, setEnabled] = useState(true)
  const [rotation, setRotation] = useState("round-robin")
  const [cooldownSec, setCooldownSec] = useState("60")
  const [maxRetries, setMaxRetries] = useState("3")
  const [timeout, setTimeout_] = useState("30")
  const [logLevel, setLogLevel] = useState("info")
  const [apiKey, setApiKey] = useState("")
  const [outboundProxy, setOutboundProxy] = useState("")
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [regenSpin, setRegenSpin] = useState(false)

  // Sessions
  const [sessions, setSessions] = useState<Session[]>([])
  const [sessionsLoading, setSessLoading] = useState(false)

  // Password change
  const [pwdUser, setPwdUser] = useState("")
  const [pwdCurrent, setPwdCurrent] = useState("")
  const [pwdNew, setPwdNew] = useState("")
  const [pwdSaving, setPwdSaving] = useState(false)

  // Restart
  const [restarting, setRestarting] = useState(false)

  const showToast = (msg: string) => setToast(msg)

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/gateway/config")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as GatewayConfig
      setConfig(json)
      setEnabled(json.enabled !== false)
      setRotation(json.rotation ?? "round-robin")
      setCooldownSec(String(json.cooldownSec ?? 60))
      setMaxRetries(String(json.maxRetries ?? 3))
      setTimeout_(String(json.timeout ?? 30))
      setLogLevel(json.logLevel ?? "info")
      setApiKey(json.apiKey ?? "")
      setOutboundProxy(json.outboundProxy ?? "")
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch")
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchSessions = useCallback(async () => {
    setSessLoading(true)
    try {
      const res = await fetch("/api/auth/sessions")
      if (!res.ok) return
      const json = await res.json() as { sessions?: Session[] }
      setSessions(json.sessions ?? [])
    } finally {
      setSessLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchConfig()
    fetchSessions()
  }, [fetchConfig, fetchSessions])

  const handleSave = async () => {
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const patch: GatewayConfig = {
        enabled,
        rotation,
        cooldownSec: parseInt(cooldownSec, 10) || 60,
        maxRetries: parseInt(maxRetries, 10) || 3,
        timeout: parseInt(timeout, 10) || 30,
        logLevel,
        outboundProxy,
      }
      const res = await fetch("/api/gateway/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
      showToast("Đã lưu cấu hình gateway")
      await fetchConfig()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  const handleRegenKey = async () => {
    setRegenSpin(true)
    try {
      const res = await fetch("/api/gateway/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ regenerateKey: true }),
      })
      const data = await res.json() as { config?: { apiKey?: string } }
      if (data.config?.apiKey) setApiKey(data.config.apiKey)
      showToast("Đã sinh API key mới")
    } finally {
      setRegenSpin(false)
    }
  }

  const handleCopyKey = async () => {
    try {
      // apiKey trên màn hình đang bị CHE — phải lấy bản thật rồi mới copy, nếu không
      // người dùng dán ra một chuỗi có dấu … và không hiểu vì sao gọi API không được.
      const real = await fetch("/api/gateway/config?reveal=1")
        .then(r => r.json()).then(j => j.apiKey as string).catch(() => "")
      if (!real) { showToast("Không lấy được API key"); return }
      if (!(await writeClipboard(real))) throw new Error("clipboard")
      showToast("Đã copy API key")
    } catch { showToast("Copy lỗi") }
  }

  const handleRotation = async (value: string) => {
    const prev = rotation
    setRotation(value)
    // Backend có thể TỪ CHỐI giá trị (enum không khớp). Trước đây UI báo "đã đổi" bất
    // kể kết quả, nút sáng lên trong khi cấu hình thật không đổi.
    try {
      const r = await fetch("/api/gateway/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rotation: value }),
      })
      const j = await r.json().catch(() => ({}))
      const bad = j?.rejected?.find((x: any) => x.key === "gatewayRotation")
      if (bad) {
        setRotation(prev)
        showToast("Không đổi được: " + (bad.reason ?? "giá trị không hợp lệ"))
        return
      }
      setRotation(j?.config?.rotation ?? value)
      showToast("Chiến lược: " + value)
    } catch {
      setRotation(prev)
      showToast("Lỗi mạng — chưa đổi được chiến lược")
    }
  }

  const handleRestart = async () => {
    if (!confirm("Khởi động lại tiến trình? Dashboard sẽ mất kết nối vài giây.")) return
    setRestarting(true)
    await fetch("/api/system/restart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }).catch(() => {})
    showToast("Đang khởi động lại…")
    setTimeout(() => window.location.reload(), 4000)
  }

  const handlePasswordSave = async () => {
    setPwdSaving(true)
    try {
      const res = await fetch("/api/security/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pwdNew, user: pwdUser, current: pwdCurrent }),
      })
      const data = await res.json() as { ok?: boolean; error?: string }
      if (data.ok) {
        showToast(pwdNew ? "Đã đổi mật khẩu" : "Đã tắt đăng nhập")
        setPwdNew(""); setPwdCurrent("")
      } else {
        showToast("Lỗi: " + (data.error || "unknown"))
      }
    } finally {
      setPwdSaving(false)
    }
  }

  const handleRevokeSession = async (id: string) => {
    await fetch("/api/auth/sessions/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    })
    showToast("Đã thu hồi phiên")
    fetchSessions()
  }

  const handleRevokeOthers = async () => {
    if (!confirm("Đăng xuất tất cả thiết bị khác?")) return
    const res = await fetch("/api/auth/sessions/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ others: true }),
    })
    const data = await res.json() as { revoked?: number }
    showToast(`Đã đăng xuất ${data.revoked ?? 0} phiên khác`)
    fetchSessions()
  }

  // ── Loading / Error ──────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-48 w-full bg-muted" />
        <Skeleton className="h-48 w-full bg-muted" />
      </div>
    )
  }

  if (error && !config) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <AlertTriangle className="h-8 w-8 text-destructive" />
        <p className="text-sm text-muted-foreground">Error: {error}</p>
        <button onClick={fetchConfig} className="text-xs text-primary hover:text-primary flex items-center gap-1.5">
          <RefreshCw className="h-3 w-3" /> Retry
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4 max-w-3xl">
      {toast && <Toast msg={toast} onClose={() => setToast(null)} />}

      <PageHeader
        title="Cấu hình Gateway"
        desc="API key, chiến lược xoay account, hạn mức và tham số vận hành"
        actions={
          <Button variant="outline" size="sm" onClick={fetchConfig} className="h-8 gap-1.5 border-border text-xs text-muted-foreground hover:text-primary">
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        }
      />

      {/* ── API Key ─────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-foreground flex items-center gap-2">
            <Key className="h-4 w-4 text-muted-foreground" /> API Key
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Input
                type={showKey ? "text" : "password"}
                value={apiKey}
                readOnly
                className="bg-muted border-border text-foreground h-9 text-sm font-mono pr-8"
              />
              <button
                onClick={async () => {
                  // Bật con mắt = hành động có chủ đích → mới nạp key thật từ server.
                  // Mặc định API trả bản đã che, nên không bấm thì key không rời server.
                  if (!showKey) {
                    const real = await fetch("/api/gateway/config?reveal=1")
                      .then(r => r.json()).then(j => j.apiKey as string).catch(() => "")
                    if (real) setApiKey(real)
                  }
                  setShowKey(v => !v)
                }}
                aria-label={showKey ? "Ẩn API key" : "Hiện API key"}
                title={showKey ? "Ẩn API key" : "Hiện API key"}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
            <Button size="sm" onClick={handleCopyKey} className="border border-border bg-transparent text-muted-foreground hover:text-foreground h-9 gap-1">
              <Copy className="h-3.5 w-3.5" /> Copy
            </Button>
            <Button size="sm" onClick={handleRegenKey} disabled={regenSpin} className="border border-border bg-transparent text-primary hover:text-primary h-9 gap-1">
              {regenSpin ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
              Regenerate
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Gửi header <code className="text-foreground">Authorization: Bearer &lt;key&gt;</code> khi gọi proxy.</p>
        </CardContent>
      </Card>

      {/* ── Gateway toggle + Outbound proxy ──────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-foreground">Gateway</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between py-1">
            <div>
              <p className="text-sm text-foreground">Gateway Enabled</p>
              <p className="text-xs text-muted-foreground mt-0.5">Bật/tắt toàn bộ gateway proxy</p>
            </div>
            <div className="flex items-center gap-3">
              <Badge className={enabled ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"}>
                {enabled ? "Enabled" : "Disabled"}
              </Badge>
              <Switch checked={enabled} onCheckedChange={setEnabled} className="data-[state=checked]:bg-primary" />
            </div>
          </div>

          <Separator className="bg-muted" />

          <div className="space-y-2">
            <label className="text-sm text-foreground">Outbound Proxy</label>
            <p className="text-xs text-muted-foreground">Proxy để gateway dùng khi gọi ra ngoài (ip:port:user:pass hoặc socks5://…)</p>
            <Input
              value={outboundProxy}
              onChange={e => setOutboundProxy(e.target.value)}
              placeholder="ip:port:user:pass hoặc socks5://..."
              className="bg-muted border-border text-foreground h-9 text-sm"
            />
          </div>
        </CardContent>
      </Card>

      {/* ── Rotation strategy ────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-foreground">Rotation Strategy</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {ROTATION_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => handleRotation(opt.value)}
                className={`h-8 px-3 rounded-md text-xs font-medium transition-colors ${
                  rotation === opt.value
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted border border-border text-foreground/70 hover:text-foreground hover:bg-muted"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <p className="text-xs text-muted-foreground">
            {ROTATION_OPTIONS.find(o => o.value === rotation)?.desc ??
              "Chiến lược này không còn được hỗ trợ — chọn lại một trong các mục trên."}
          </p>

          <Separator className="bg-muted" />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm text-foreground">Cooldown (giây)</label>
              <Input
                type="number" min={0} max={3600}
                value={cooldownSec}
                onChange={e => setCooldownSec(e.target.value)}
                className="bg-muted border-border text-foreground h-9 text-sm"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm text-foreground">Max Retries</label>
              <Input
                type="number" min={0} max={10}
                value={maxRetries}
                onChange={e => setMaxRetries(e.target.value)}
                className="bg-muted border-border text-foreground h-9 text-sm"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Advanced ─────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-foreground">Advanced</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm text-foreground">Timeout (giây)</label>
              <Input
                type="number" min={5} max={300}
                value={timeout}
                onChange={e => setTimeout_(e.target.value)}
                className="bg-muted border-border text-foreground h-9 text-sm"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm text-foreground">Log Level</label>
              <select
                value={logLevel}
                onChange={e => setLogLevel(e.target.value)}
                className="w-full h-9 px-3 rounded-md bg-muted border border-border text-foreground text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="debug">Debug</option>
                <option value="info">Info</option>
                <option value="warn">Warn</option>
                <option value="error">Error</option>
              </select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Save button */}
      {error && config && (
        <div className="flex items-start gap-2 bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2.5">
          <AlertTriangle className="h-3.5 w-3.5 text-destructive flex-shrink-0 mt-0.5" />
          <p className="text-xs text-destructive">{error}</p>
        </div>
      )}
      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={saving} className="bg-primary hover:bg-primary text-primary-foreground gap-2 disabled:opacity-50">
          {saving ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {saving ? "Đang lưu…" : "Lưu cấu hình"}
        </Button>
        {saved && (
          <div className="flex items-center gap-1.5 text-success text-sm">
            <CheckCircle2 className="h-4 w-4" /> Đã lưu!
          </div>
        )}
      </div>

      {/* Cập nhật đứng TRƯỚC restart: cài xong thì bước kế là khởi động lại. */}
      <UpdatePanel />

      {/* ── Restart server ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-foreground flex items-center gap-2">
            <Power className="h-4 w-4 text-muted-foreground" /> Server
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              onClick={handleRestart}
              disabled={restarting}
              className="bg-destructive hover:bg-destructive text-destructive-foreground h-8 text-xs gap-1"
            >
              {restarting ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Power className="h-3 w-3" />}
              {restarting ? "Đang khởi động lại…" : "Restart Server"}
            </Button>
            <p className="text-xs text-muted-foreground">Dashboard sẽ mất kết nối vài giây</p>
          </div>
        </CardContent>
      </Card>

      {/* ── Password change ───────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-foreground flex items-center gap-2">
            <Lock className="h-4 w-4 text-muted-foreground" /> Đổi mật khẩu
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Username</label>
              <Input
                value={pwdUser}
                onChange={e => setPwdUser(e.target.value)}
                placeholder="admin"
                className="bg-muted border-border text-foreground h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Mật khẩu hiện tại</label>
              <Input
                type="password"
                value={pwdCurrent}
                onChange={e => setPwdCurrent(e.target.value)}
                placeholder="••••••••"
                className="bg-muted border-border text-foreground h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Mật khẩu mới</label>
              <Input
                type="password"
                value={pwdNew}
                onChange={e => setPwdNew(e.target.value)}
                placeholder="••••••••"
                className="bg-muted border-border text-foreground h-8 text-sm"
              />
            </div>
          </div>
          <Button
            size="sm"
            onClick={handlePasswordSave}
            disabled={pwdSaving}
            className="bg-primary hover:bg-primary/90 text-primary-foreground h-8 text-xs gap-1"
          >
            {pwdSaving ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Shield className="h-3 w-3" />}
            Lưu mật khẩu
          </Button>
          <p className="text-xs text-muted-foreground">Để trống mật khẩu mới = tắt đăng nhập</p>
        </CardContent>
      </Card>

      {/* ── Sessions ──────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium text-foreground flex items-center gap-2">
              <Shield className="h-4 w-4 text-muted-foreground" /> Phiên đăng nhập ({sessions.length})
            </CardTitle>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={fetchSessions} disabled={sessionsLoading} className="border border-border bg-transparent text-muted-foreground hover:text-foreground h-7 text-xs gap-1">
                <RefreshCw className={`h-3 w-3 ${sessionsLoading ? "animate-spin" : ""}`} /> Refresh
              </Button>
              <Button size="sm" onClick={handleRevokeOthers} className="border border-destructive bg-transparent text-destructive hover:text-destructive h-7 text-xs gap-1">
                <Trash2 className="h-3 w-3" /> Đăng xuất khác
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {sessions.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">Không có phiên</p>
          ) : (
            /* max-h + scroll: pool login bằng curl/CLI tạo hàng trăm phiên — render
               thẳng làm trang Cấu hình dài cả chục nghìn px, kéo mãi không hết. */
            <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
              {sessions.map(sess => (
                <div
                  key={sess.id}
                  className={`flex items-center justify-between p-2.5 rounded-lg border ${sess.current ? "border-primary/30 bg-primary/5" : "border-border bg-muted/30"}`}
                >
                  <div className="space-y-0.5 flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-foreground truncate font-mono">{(sess.ua ?? "").slice(0, 60)}</span>
                      {sess.current && <Badge className="bg-primary/20 text-primary">phiên này</Badge>}
                    </div>
                    <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                      <span>{sess.ip ?? "—"}</span>
                      <span>tạo {fmtAgo(sess.created_at)}</span>
                      <span>hoạt động {fmtAgo(sess.last_seen)}</span>
                    </div>
                  </div>
                  {!sess.current && (
                    <button
                      onClick={() => handleRevokeSession(sess.id)}
                      className="ml-2 h-6 w-6 flex items-center justify-center rounded hover:bg-destructive/30 text-muted-foreground hover:text-destructive flex-shrink-0"
                      title="Thu hồi phiên"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
