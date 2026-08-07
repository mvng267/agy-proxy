import { useState } from "react"
import {
  UserPlus,
  AlertTriangle,
  CheckCircle2,
  Upload,
  Loader2,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

// ── Types ──────────────────────────────────────────────────────────────

interface AddResult {
  success: boolean
  message: string
  added?: number
  errors?: string[]
}

// ── AddAccount Page ────────────────────────────────────────────────────

export function AddAccount() {
  const [provider, setProvider] = useState<"agy" | "kiro">("agy")
  const [credential, setCredential] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<AddResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    const trimmed = credential.trim()
    if (!trimmed) return

    setSubmitting(true)
    setResult(null)
    setError(null)

    try {
      // Try parsing as JSON (single or array)
      let payload: unknown
      try {
        payload = JSON.parse(trimmed)
      } catch {
        // If not valid JSON, treat each line as an email/credential
        const lines = trimmed
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
        payload = { credentials: lines, provider }
      }

      // If parsed JSON is an object (not array), wrap with provider
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        payload = { ...payload as Record<string, unknown>, provider }
      } else if (Array.isArray(payload)) {
        payload = { credentials: payload, provider }
      }

      const res = await fetch("/api/gateway/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })

      const json = (await res.json()) as AddResult

      if (!res.ok) {
        setError(json.message ?? `HTTP ${res.status}`)
        return
      }

      setResult(json)
      if (json.success) {
        setCredential("")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit")
    } finally {
      setSubmitting(false)
    }
  }

  const lineCount = credential.split("\n").filter((l) => l.trim()).length

  return (
    <div className="space-y-4 max-w-2xl">
      {/* Provider select */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
            <UserPlus className="h-4 w-4 text-slate-500" />
            Thêm tài khoản
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Provider toggle */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-500 uppercase tracking-wider">
              Provider
            </label>
            <div className="flex items-center gap-2">
              {(["agy", "kiro"] as const).map((p) => (
                <Button
                  key={p}
                  variant={provider === p ? "default" : "outline"}
                  size="sm"
                  onClick={() => setProvider(p)}
                  className={
                    provider === p
                      ? "bg-orange-500 hover:bg-orange-600 text-white h-8 text-xs"
                      : "border-slate-700 text-slate-400 hover:text-slate-200 hover:bg-slate-800 h-8 text-xs"
                  }
                >
                  {p.toUpperCase()}
                </Button>
              ))}
            </div>
          </div>

          {/* Credential input */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-slate-500 uppercase tracking-wider">
                Credential JSON
              </label>
              {lineCount > 0 && (
                <Badge className="bg-slate-700 text-slate-400 border-none text-[10px]">
                  {lineCount} {lineCount === 1 ? "entry" : "entries"}
                </Badge>
              )}
            </div>
            <textarea
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              placeholder={`Paste credential JSON tại đây...\n\nVí dụ:\n{"email": "user@example.com", "token": "..."}\n\nHoặc nhiều dòng (mỗi dòng 1 credential):\n{"email": "a@ex.com", "token": "..."}\n{"email": "b@ex.com", "token": "..."}`}
              rows={10}
              className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-orange-500/50 focus:ring-1 focus:ring-orange-500/30 resize-y transition-colors"
            />
          </div>

          {/* Email list shortcut */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-500 uppercase tracking-wider">
              Hoặc paste email (mỗi dòng 1 email)
            </label>
            <Input
              placeholder="user1@example.com, user2@example.com"
              className="bg-slate-950 border-slate-800 text-slate-200 placeholder:text-slate-600 h-9 text-sm"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const val = (e.target as HTMLInputElement).value.trim()
                  if (val) {
                    const emails = val
                      .split(/[,\n]/)
                      .map((s) => s.trim())
                      .filter(Boolean)
                    const asJson = emails
                      .map((email) => JSON.stringify({ email }))
                      .join("\n")
                    setCredential((prev) =>
                      prev ? prev + "\n" + asJson : asJson
                    )
                    ;(e.target as HTMLInputElement).value = ""
                  }
                }
              }}
            />
          </div>

          {/* Submit */}
          <div className="flex items-center gap-3 pt-2">
            <Button
              onClick={handleSubmit}
              disabled={submitting || !credential.trim()}
              className="bg-orange-500 hover:bg-orange-600 text-white h-9 text-sm gap-2"
            >
              {submitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              {submitting ? "Đang gửi..." : "Thêm tài khoản"}
            </Button>
            {credential.trim() && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setCredential("")
                  setResult(null)
                  setError(null)
                }}
                className="border-slate-700 text-slate-400 hover:text-slate-200 h-9 text-xs"
              >
                Xoá
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Result */}
      {result && (
        <Card
          className={
            result.success
              ? "bg-emerald-950/30 border-emerald-800/50"
              : "bg-red-950/30 border-red-800/50"
          }
        >
          <CardContent className="pt-4">
            <div className="flex items-start gap-3">
              {result.success ? (
                <CheckCircle2 className="h-5 w-5 text-emerald-400 mt-0.5 shrink-0" />
              ) : (
                <AlertTriangle className="h-5 w-5 text-red-400 mt-0.5 shrink-0" />
              )}
              <div className="space-y-1 flex-1">
                <p className="text-sm text-slate-200">
                  {result.message ?? (result.success ? "Thành công" : "Thất bại")}
                </p>
                {result.added != null && (
                  <p className="text-xs text-slate-400">
                    Đã thêm: {result.added} tài khoản
                  </p>
                )}
                {result.errors && result.errors.length > 0 && (
                  <div className="mt-2 space-y-1">
                    <p className="text-xs text-red-400 font-medium">Lỗi:</p>
                    {result.errors.map((err, i) => (
                      <p
                        key={i}
                        className="text-xs text-red-300/80 font-mono pl-2"
                      >
                        • {err}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Error */}
      {error && !result && (
        <Card className="bg-red-950/30 border-red-800/50">
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <AlertTriangle className="h-5 w-5 text-red-400 shrink-0" />
              <p className="text-sm text-red-300">{error}</p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
