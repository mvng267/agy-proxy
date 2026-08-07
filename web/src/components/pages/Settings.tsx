import { useEffect, useState, useCallback } from "react"
import {
  Settings as SettingsIcon,
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
  TestTube2,
  RotateCcw,
  Lock,
} from "lucide-react"
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
    <div className="fixed bottom-4 right-4 z-50 bg-slate-800 border border-slate-700 text-slate-200 text-sm px-4 py-2 rounded-lg shadow-lg">
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

  // OmniRoute test
  const [omniTestResult, setOmniTestResult] = useState<string | null>(null)
  const [omniTesting, setOmniTesting] = useState(false)

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
      await navigator.clipboard.writeText(real)
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

  const handleOmniTest = async () => {
    setOmniTesting(true)
    setOmniTestResult(null)
    try {
      const res = await fetch("/api/settings/omniroute/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      const data = await res.json() as { ok?: boolean; error?: string; connections?: number }
      setOmniTestResult(data.ok
        ? `✓ Kết nối OK · ${data.connections ?? 0} connection`
        : `✕ ${data.error ?? "lỗi"}`)
      showToast(data.ok ? "OmniRoute OK" : "OmniRoute lỗi")
    } finally {
      setOmniTesting(false)
    }
  }

  // ── Loading / Error ──────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-48 w-full bg-slate-800" />
        <Skeleton className="h-48 w-full bg-slate-800" />
      </div>
    )
  }

  if (error && !config) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <AlertTriangle className="h-8 w-8 text-red-500" />
        <p className="text-sm text-slate-400">Error: {error}</p>
        <button onClick={fetchConfig} className="text-xs text-orange-400 hover:text-orange-300 flex items-center gap-1.5">
          <RefreshCw className="h-3 w-3" /> Retry
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-3xl">
      {toast && <Toast msg={toast} onClose={() => setToast(null)} />}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <SettingsIcon className="h-4 w-4 text-slate-500" />
          <h2 className="text-sm font-medium text-slate-300">Cấu hình Gateway</h2>
        </div>
        <Button variant="outline" size="sm" onClick={fetchConfig} className="border-slate-700 text-slate-400 hover:text-orange-400 h-7 text-xs gap-1">
          <RefreshCw className="h-3 w-3" /> Refresh
        </Button>
      </div>

      {/* ── API Key ─────────────────────────────────────────────────────── */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
            <Key className="h-4 w-4 text-slate-500" /> API Key
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Input
                type={showKey ? "text" : "password"}
                value={apiKey}
                readOnly
                className="bg-slate-800 border-slate-700 text-slate-200 h-9 text-sm font-mono pr-8"
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
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
              >
                {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
            <Button size="sm" onClick={handleCopyKey} className="border border-slate-700 bg-transparent text-slate-400 hover:text-slate-200 h-9 gap-1">
              <Copy className="h-3.5 w-3.5" /> Copy
            </Button>
            <Button size="sm" onClick={handleRegenKey} disabled={regenSpin} className="border border-slate-700 bg-transparent text-orange-400 hover:text-orange-300 h-9 gap-1">
              {regenSpin ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
              Regenerate
            </Button>
          </div>
          <p className="text-xs text-slate-500">Gửi header <code className="text-slate-300">Authorization: Bearer &lt;key&gt;</code> khi gọi proxy.</p>
        </CardContent>
      </Card>

      {/* ── Gateway toggle + Outbound proxy ──────────────────────────────── */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-slate-300">Gateway</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between py-1">
            <div>
              <p className="text-sm text-slate-200">Gateway Enabled</p>
              <p className="text-xs text-slate-500 mt-0.5">Bật/tắt toàn bộ gateway proxy</p>
            </div>
            <div className="flex items-center gap-3">
              <Badge className={enabled ? "bg-emerald-500/15 text-emerald-400 border-none text-[10px]" : "bg-slate-700 text-slate-400 border-none text-[10px]"}>
                {enabled ? "Enabled" : "Disabled"}
              </Badge>
              <Switch checked={enabled} onCheckedChange={setEnabled} className="data-[state=checked]:bg-orange-500" />
            </div>
          </div>

          <Separator className="bg-slate-800" />

          <div className="space-y-2">
            <label className="text-sm text-slate-200">Outbound Proxy</label>
            <p className="text-xs text-slate-500">Proxy để gateway dùng khi gọi ra ngoài (ip:port:user:pass hoặc socks5://…)</p>
            <Input
              value={outboundProxy}
              onChange={e => setOutboundProxy(e.target.value)}
              placeholder="ip:port:user:pass hoặc socks5://..."
              className="bg-slate-800 border-slate-700 text-slate-200 h-9 text-sm"
            />
          </div>
        </CardContent>
      </Card>

      {/* ── Rotation strategy ────────────────────────────────────────────── */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-slate-300">Rotation Strategy</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {ROTATION_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => handleRotation(opt.value)}
                className={`h-8 px-3 rounded-md text-xs font-medium transition-colors ${
                  rotation === opt.value
                    ? "bg-orange-500 text-white"
                    : "bg-slate-800 border border-slate-700 text-slate-400 hover:text-slate-200 hover:bg-slate-700"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <p className="text-xs text-slate-500">
            {ROTATION_OPTIONS.find(o => o.value === rotation)?.desc ??
              "Chiến lược này không còn được hỗ trợ — chọn lại một trong các mục trên."}
          </p>

          <Separator className="bg-slate-800" />

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm text-slate-200">Cooldown (giây)</label>
              <Input
                type="number" min={0} max={3600}
                value={cooldownSec}
                onChange={e => setCooldownSec(e.target.value)}
                className="bg-slate-800 border-slate-700 text-slate-200 h-9 text-sm"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm text-slate-200">Max Retries</label>
              <Input
                type="number" min={0} max={10}
                value={maxRetries}
                onChange={e => setMaxRetries(e.target.value)}
                className="bg-slate-800 border-slate-700 text-slate-200 h-9 text-sm"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Advanced ─────────────────────────────────────────────────────── */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-slate-300">Advanced</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm text-slate-200">Timeout (giây)</label>
              <Input
                type="number" min={5} max={300}
                value={timeout}
                onChange={e => setTimeout_(e.target.value)}
                className="bg-slate-800 border-slate-700 text-slate-200 h-9 text-sm"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm text-slate-200">Log Level</label>
              <select
                value={logLevel}
                onChange={e => setLogLevel(e.target.value)}
                className="w-full h-9 px-3 rounded-md bg-slate-800 border border-slate-700 text-slate-200 text-sm focus:outline-none focus:ring-1 focus:ring-orange-500"
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
        <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5">
          <AlertTriangle className="h-3.5 w-3.5 text-red-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-red-400">{error}</p>
        </div>
      )}
      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={saving} className="bg-orange-500 hover:bg-orange-600 text-white gap-2 disabled:opacity-50">
          {saving ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {saving ? "Đang lưu…" : "Lưu cấu hình"}
        </Button>
        {saved && (
          <div className="flex items-center gap-1.5 text-emerald-400 text-sm">
            <CheckCircle2 className="h-4 w-4" /> Đã lưu!
          </div>
        )}
      </div>

      {/* ── OmniRoute Test ────────────────────────────────────────────────── */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
            <TestTube2 className="h-4 w-4 text-slate-500" /> OmniRoute
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              onClick={handleOmniTest}
              disabled={omniTesting}
              className="border border-slate-700 bg-transparent text-slate-300 hover:text-slate-100 h-8 text-xs gap-1"
            >
              {omniTesting ? <RefreshCw className="h-3 w-3 animate-spin" /> : <TestTube2 className="h-3 w-3" />}
              Test OmniRoute
            </Button>
            {omniTestResult && (
              <span className={`text-xs font-medium ${omniTestResult.startsWith("✓") ? "text-emerald-400" : "text-red-400"}`}>
                {omniTestResult}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Restart server ────────────────────────────────────────────────── */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
            <Power className="h-4 w-4 text-slate-500" /> Server
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              onClick={handleRestart}
              disabled={restarting}
              className="bg-red-600 hover:bg-red-700 text-white h-8 text-xs gap-1"
            >
              {restarting ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Power className="h-3 w-3" />}
              {restarting ? "Đang khởi động lại…" : "Restart Server"}
            </Button>
            <p className="text-xs text-slate-500">Dashboard sẽ mất kết nối vài giây</p>
          </div>
        </CardContent>
      </Card>

      {/* ── Password change ───────────────────────────────────────────────── */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
            <Lock className="h-4 w-4 text-slate-500" /> Đổi mật khẩu
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-slate-400">Username</label>
              <Input
                value={pwdUser}
                onChange={e => setPwdUser(e.target.value)}
                placeholder="admin"
                className="bg-slate-800 border-slate-700 text-slate-200 h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-slate-400">Mật khẩu hiện tại</label>
              <Input
                type="password"
                value={pwdCurrent}
                onChange={e => setPwdCurrent(e.target.value)}
                placeholder="••••••••"
                className="bg-slate-800 border-slate-700 text-slate-200 h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-slate-400">Mật khẩu mới</label>
              <Input
                type="password"
                value={pwdNew}
                onChange={e => setPwdNew(e.target.value)}
                placeholder="••••••••"
                className="bg-slate-800 border-slate-700 text-slate-200 h-8 text-sm"
              />
            </div>
          </div>
          <Button
            size="sm"
            onClick={handlePasswordSave}
            disabled={pwdSaving}
            className="bg-slate-700 hover:bg-slate-600 text-white h-8 text-xs gap-1"
          >
            {pwdSaving ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Shield className="h-3 w-3" />}
            Lưu mật khẩu
          </Button>
          <p className="text-xs text-slate-500">Để trống mật khẩu mới = tắt đăng nhập</p>
        </CardContent>
      </Card>

      {/* ── Sessions ──────────────────────────────────────────────────────── */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
              <Shield className="h-4 w-4 text-slate-500" /> Phiên đăng nhập ({sessions.length})
            </CardTitle>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={fetchSessions} disabled={sessionsLoading} className="border border-slate-700 bg-transparent text-slate-400 hover:text-slate-200 h-7 text-xs gap-1">
                <RefreshCw className={`h-3 w-3 ${sessionsLoading ? "animate-spin" : ""}`} /> Refresh
              </Button>
              <Button size="sm" onClick={handleRevokeOthers} className="border border-red-800 bg-transparent text-red-400 hover:text-red-300 h-7 text-xs gap-1">
                <Trash2 className="h-3 w-3" /> Đăng xuất khác
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {sessions.length === 0 ? (
            <p className="text-xs text-slate-600 text-center py-4">Không có phiên</p>
          ) : (
            <div className="space-y-2">
              {sessions.map(sess => (
                <div
                  key={sess.id}
                  className={`flex items-center justify-between p-2.5 rounded-lg border ${sess.current ? "border-orange-500/30 bg-orange-500/5" : "border-slate-800 bg-slate-800/30"}`}
                >
                  <div className="space-y-0.5 flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-300 truncate font-mono">{(sess.ua ?? "").slice(0, 60)}</span>
                      {sess.current && <Badge className="bg-orange-500/20 text-orange-400 border-none text-[10px]">phiên này</Badge>}
                    </div>
                    <div className="flex items-center gap-3 text-[10px] text-slate-500">
                      <span>{sess.ip ?? "—"}</span>
                      <span>tạo {fmtAgo(sess.created_at)}</span>
                      <span>hoạt động {fmtAgo(sess.last_seen)}</span>
                    </div>
                  </div>
                  {!sess.current && (
                    <button
                      onClick={() => handleRevokeSession(sess.id)}
                      className="ml-2 h-6 w-6 flex items-center justify-center rounded hover:bg-red-900/30 text-slate-500 hover:text-red-400 flex-shrink-0"
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
