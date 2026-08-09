import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Globe, KeyRound, Loader2, ShieldAlert, ShieldCheck, UserRound } from "lucide-react"
import { api } from "@/lib/api"
import { KpiCard, PageHeader, ErrorState } from "@/components/common"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useToast } from "@/components/ui/toast"

/**
 * Bảo mật — trạng thái auth của dashboard + đổi user/mật khẩu.
 * Cảnh báo khi còn dùng mật khẩu mặc định hoặc server lắng nghe mọi interface.
 */

interface SecurityInfo {
  hasPassword: boolean
  isDefault: boolean
  user: string
  host: string
  open: boolean
}

export function Security() {
  const qc = useQueryClient()
  const toast = useToast()

  const sec = useQuery({
    queryKey: ["security"],
    queryFn: () => api.get<SecurityInfo>("/api/security"),
  })

  const [form, setForm] = useState({ user: "", current: "", password: "", confirm: "" })
  const [touched, setTouched] = useState(false)

  const save = useMutation({
    mutationFn: (b: { user: string; current: string; password: string }) =>
      api.post<{ ok: boolean; hasPassword: boolean; user: string }>("/api/security/password", b),
    onSuccess: () => {
      toast({ title: "Đã lưu", description: "Thông tin đăng nhập đã được cập nhật", variant: "success" })
      setForm({ user: "", current: "", password: "", confirm: "" })
      setTouched(false)
      qc.invalidateQueries({ queryKey: ["security"] })
      qc.invalidateQueries({ queryKey: ["auth-me"] })
    },
    onError: (e) => toast({ title: "Lỗi", description: e.message, variant: "error" }),
  })

  if (sec.isError) return <ErrorState error={sec.error} onRetry={() => sec.refetch()} />

  const s = sec.data
  // user để trống = giữ nguyên user hiện tại
  const effectiveUser = form.user.trim() || s?.user || ""
  const passTooShort = form.password.length > 0 && form.password.length < 6
  const mismatch = form.confirm.length > 0 && form.password !== form.confirm
  const canSave =
    form.password.length >= 6 && form.password === form.confirm && (!s?.hasPassword || form.current.length > 0)

  const warnings: { icon: typeof ShieldAlert; text: string }[] = []
  if (s && !s.hasPassword) warnings.push({ icon: ShieldAlert, text: "Dashboard chưa đặt mật khẩu — ai vào cũng xem được." })
  if (s?.isDefault) warnings.push({ icon: ShieldAlert, text: "Đang dùng mật khẩu mặc định (123456) — đổi ngay bên dưới." })
  if (s?.open)
    warnings.push({
      icon: Globe,
      text: `Server đang lắng nghe ${s.host} (mọi interface) — dashboard truy cập được từ mạng ngoài.`,
    })

  return (
    <div>
      <PageHeader title="Bảo mật" desc="Trạng thái xác thực dashboard và đổi thông tin đăng nhập" />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <KpiCard
          label="Mật khẩu"
          value={s ? (s.hasPassword ? (s.isDefault ? "Mặc định" : "Đã đặt") : "Chưa đặt") : "—"}
          sub={s?.isDefault ? "123456 — cần đổi" : undefined}
          icon={s?.hasPassword && !s.isDefault ? ShieldCheck : ShieldAlert}
          tone={s ? (s.hasPassword && !s.isDefault ? "success" : "danger") : "default"}
          loading={sec.isPending}
        />
        <KpiCard
          label="Tài khoản"
          value={s?.user || "admin"}
          sub="user đăng nhập dashboard"
          icon={UserRound}
          loading={sec.isPending}
        />
        <KpiCard
          label="Host"
          value={<span className="font-mono text-lg">{s?.host ?? "—"}</span>}
          sub={s?.open ? "mở ra mạng ngoài" : "chỉ máy này"}
          icon={Globe}
          tone={s?.open ? "warning" : "success"}
          loading={sec.isPending}
        />
      </div>

      {warnings.length > 0 && (
        <div className="mt-4 space-y-2">
          {warnings.map((w, i) => (
            <div
              key={i}
              className="flex items-start gap-2.5 rounded-lg border border-[color:var(--warning)]/30 bg-[color:var(--warning)]/10 px-3.5 py-2.5 text-sm text-[color:var(--warning)]"
            >
              <w.icon className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{w.text}</span>
            </div>
          ))}
        </div>
      )}

      <Card className="mt-4 max-w-lg">
        <CardContent className="p-5">
          <h3 className="mb-1 flex items-center gap-2 text-sm font-medium text-foreground">
            <KeyRound className="h-4 w-4 text-muted-foreground" />
            Đổi thông tin đăng nhập
          </h3>
          <p className="mb-4 text-xs text-muted-foreground">
            Mật khẩu được lưu dạng hash. Phiên hiện tại vẫn giữ nguyên sau khi đổi.
          </p>

          <div className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground">Tên đăng nhập</label>
              <Input
                value={form.user}
                onChange={(e) => setForm({ ...form, user: e.target.value })}
                placeholder={s?.user || "admin"}
                className="mt-1 h-9"
              />
            </div>
            {s?.hasPassword && (
              <div>
                <label className="text-xs text-muted-foreground">Mật khẩu hiện tại</label>
                <Input
                  type="password"
                  value={form.current}
                  onChange={(e) => setForm({ ...form, current: e.target.value })}
                  className="mt-1 h-9"
                />
              </div>
            )}
            <div>
              <label className="text-xs text-muted-foreground">Mật khẩu mới (≥ 6 ký tự)</label>
              <Input
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                onBlur={() => setTouched(true)}
                className="mt-1 h-9"
              />
              {touched && passTooShort && (
                <p className="mt-1 text-xs text-destructive">Mật khẩu tối thiểu 6 ký tự</p>
              )}
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Nhập lại mật khẩu mới</label>
              <Input
                type="password"
                value={form.confirm}
                onChange={(e) => setForm({ ...form, confirm: e.target.value })}
                className="mt-1 h-9"
              />
              {mismatch && <p className="mt-1 text-xs text-destructive">Hai mật khẩu không khớp</p>}
            </div>

            <Button
              onClick={() => save.mutate({ user: effectiveUser, current: form.current, password: form.password })}
              disabled={!canSave || save.isPending}
              className="h-9 gap-1.5 text-sm"
            >
              {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
              Lưu thay đổi
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
