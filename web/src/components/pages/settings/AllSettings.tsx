import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { RefreshCw, Save, Search } from "lucide-react"
import { api } from "@/lib/api"
import { POLL } from "@/lib/queryClient"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { useToast } from "@/components/ui/toast"

/**
 * MỌI khoá cấu hình, tự sinh từ mô tả backend gửi xuống.
 *
 * Vì sao cần: đo ngày 13/08/2026, chỉ **11/46** khoá chỉnh được từ dashboard. 35 khoá còn
 * lại muốn đổi phải SSH vào máy chủ ghi thẳng vào SQLite — kể cả `quotaIntervalMin`, thứ
 * vừa phải đổi để cứu vòng làm mới hạn mức đang tắc 28 giờ.
 *
 * Gốc rễ: mỗi ô được viết TAY, nên thêm khoá vào backend mà quên sửa giao diện là nó vô
 * hình mãi mãi. Ở đây form sinh từ `fields` của `/api/settings`, nên khoá mới tự có ô.
 *
 * Các thẻ viết tay bên trên vẫn giữ: chúng gom sẵn những thứ hay dùng nhất kèm ngữ cảnh
 * (nút sinh API key, mô tả từng chiến lược xoay) mà form tự sinh không diễn đạt được.
 */

type FieldType = "int" | "bool" | "string" | "enum" | "password" | "model"

interface Field {
  label: string
  desc?: string
  group: string
  type: FieldType
  min?: number
  max?: number
  values?: string[]
  advanced?: boolean
}

interface SettingsRes {
  values: Record<string, unknown>
  fields: Record<string, Field>
  secretKeys: string[]
  restartKeys: string[]
}

const CHE = "••••••••"

export function AllSettings() {
  const qc = useQueryClient()
  const toast = useToast()
  const [nhap, setNhap] = useState<Record<string, unknown>>({})
  const [luu, setLuu] = useState(false)
  const [tuKhoa, setTuKhoa] = useState("")
  const [hienNangCao, setHienNangCao] = useState(false)

  const q = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<SettingsRes>("/api/settings"),
    refetchInterval: POLL.slow,
  })

  const d = q.data
  const doiCho = Object.keys(nhap)

  const datGiaTri = (k: string, v: unknown) => setNhap((p) => ({ ...p, [k]: v }))
  const giaTri = (k: string) => (k in nhap ? nhap[k] : d?.values[k])

  const luuLai = async () => {
    if (!doiCho.length) return
    setLuu(true)
    try {
      const r = await api.patch<{ changed: string[]; rejected: { key: string; reason: string }[] }>(
        "/api/settings",
        nhap,
      )
      // `rejected` mang lý do TIẾNG VIỆT do `applyConfig` sinh ra — hiện thẳng, đừng nuốt.
      if (r.rejected?.length) {
        toast({
          title: `${r.rejected.length} giá trị bị từ chối`,
          description: r.rejected.map((x) => `${x.key}: ${x.reason}`).join(" · ").slice(0, 200),
          variant: "error",
        })
      }
      if (r.changed?.length) {
        const canRestart = r.changed.filter((k) => d?.restartKeys.includes(k))
        toast({
          title: `Đã lưu ${r.changed.length} thay đổi`,
          description: canRestart.length ? `Cần khởi động lại: ${canRestart.join(", ")}` : undefined,
          variant: "success",
        })
      }
      setNhap({})
      qc.invalidateQueries({ queryKey: ["settings"] })
    } catch (e) {
      toast({
        title: "Lỗi khi lưu",
        description: String(e instanceof Error ? e.message : e).slice(0, 150),
        variant: "error",
      })
    } finally {
      setLuu(false)
    }
  }

  if (q.isLoading) return <p className="text-sm text-muted-foreground">Đang tải cấu hình…</p>
  if (!d?.fields) return null

  // Gom theo nhóm, giữ nguyên thứ tự khai báo ở backend (nhóm liên quan nằm cạnh nhau).
  const loc = tuKhoa.trim().toLowerCase()
  const nhomHoa: Record<string, [string, Field][]> = {}
  for (const [k, f] of Object.entries(d.fields)) {
    if (f.advanced && !hienNangCao && !loc) continue
    if (loc && !`${k} ${f.label} ${f.desc ?? ""}`.toLowerCase().includes(loc)) continue
    ;(nhomHoa[f.group] ??= []).push([k, f])
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-3 text-sm font-medium text-foreground">
          Tất cả cấu hình
          <span className="text-xs font-normal text-muted-foreground">
            {Object.keys(d.fields).length} khoá
          </span>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={tuKhoa}
                onChange={(e) => setTuKhoa(e.target.value)}
                placeholder="Tìm khoá…"
                className="h-8 w-44 pl-7 text-xs"
              />
            </div>
            <Button
              size="sm"
              variant={hienNangCao ? "default" : "outline"}
              onClick={() => setHienNangCao((v) => !v)}
              className="h-8 text-xs"
            >
              Nâng cao
            </Button>
          </div>
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-5">
        {Object.entries(nhomHoa).map(([nhom, list]) => (
          <div key={nhom} className="space-y-3">
            <p className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">{nhom}</p>
            <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2">
              {list.map(([k, f]) => (
                <O
                  key={k}
                  khoa={k}
                  f={f}
                  giaTri={giaTri(k)}
                  daDoi={k in nhap}
                  canRestart={d.restartKeys.includes(k)}
                  onChange={(v) => datGiaTri(k, v)}
                />
              ))}
            </div>
          </div>
        ))}

        {!Object.keys(nhomHoa).length ? (
          <p className="text-sm text-muted-foreground">Không có khoá nào khớp “{tuKhoa}”.</p>
        ) : null}

        <div className="flex items-center gap-3 border-t border-border pt-4">
          <Button onClick={luuLai} disabled={!doiCho.length || luu} className="gap-2">
            {luu ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {luu ? "Đang lưu…" : doiCho.length ? `Lưu ${doiCho.length} thay đổi` : "Chưa có thay đổi"}
          </Button>
          {doiCho.length ? (
            <Button variant="outline" onClick={() => setNhap({})} disabled={luu} className="text-xs">
              Huỷ
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}

/** Một ô cấu hình — kiểu control chọn theo `type` mà backend khai. */
function O({
  khoa,
  f,
  giaTri,
  daDoi,
  canRestart,
  onChange,
}: {
  khoa: string
  f: Field
  giaTri: unknown
  daDoi: boolean
  canRestart: boolean
  onChange: (v: unknown) => void
}) {
  const nhan = (
    <div className="flex items-start gap-1.5">
      <label className="text-sm text-foreground" title={khoa}>
        {f.label}
      </label>
      {canRestart ? (
        <span className="mt-0.5 rounded bg-warning/15 px-1 text-[0.625rem] text-warning">cần khởi động lại</span>
      ) : null}
      {daDoi ? <span className="mt-0.5 text-[0.625rem] text-primary">• đã sửa</span> : null}
    </div>
  )

  if (f.type === "bool") {
    return (
      <div className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2">
        <div className="min-w-0 space-y-0.5">
          {nhan}
          {f.desc ? <p className="text-xs text-muted-foreground">{f.desc}</p> : null}
        </div>
        <Switch checked={giaTri === true} onCheckedChange={onChange} />
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      {nhan}
      {f.type === "enum" ? (
        <select
          value={String(giaTri ?? "")}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-full rounded-md border border-border bg-muted px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        >
          {(f.values ?? []).map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      ) : (
        <Input
          type={f.type === "int" ? "number" : f.type === "password" ? "password" : "text"}
          min={f.min}
          max={f.max}
          value={String(giaTri ?? "")}
          // Secret hiện dạng che; gõ vào mới là ý định đổi thật. Backend bỏ qua giá trị
          // che nên không sợ ghi đè nhầm bằng chuỗi chấm.
          placeholder={f.type === "password" ? CHE : undefined}
          onChange={(e) => onChange(f.type === "int" ? Number(e.target.value) : e.target.value)}
          className="h-9 text-sm"
        />
      )}
      {f.desc ? <p className="text-xs text-muted-foreground">{f.desc}</p> : null}
      {f.type === "int" && f.min !== undefined ? (
        <p className="text-[0.625rem] text-muted-foreground">
          {f.min} – {f.max}
        </p>
      ) : null}
    </div>
  )
}
