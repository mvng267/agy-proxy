import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { POLL } from "@/lib/queryClient"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import type { Model } from "@/lib/types"

/**
 * Chọn model — MỘT bản dùng chung.
 *
 * Trước đây 6 trang tự viết, và chúng đã phân kỳ thật:
 *   Chat.tsx           `<select>` HTML tự viết, có gom nhóm theo provider
 *   ApiPlayground.tsx  ui/select, đẩy combo lên đầu kèm số bước
 *   ModelCompare.tsx   ui/select dùng như nút "+ Thêm model"
 *   Combo.tsx          ui/select, lọc bỏ `combo/*` (không cho combo lồng combo)
 *
 * Mỗi bản biết một luật mà bản khác không biết. Trang thứ 7 sẽ lại chép từ bản gần nhất
 * và thiếu tiếp — nên gộp lại, giữ đủ mọi luật qua props.
 */

/** Danh sách model — cache chung nên nhiều ModelSelect trên cùng trang chỉ gọi API 1 lần. */
export function useModels() {
  return useQuery({
    queryKey: ["models"],
    queryFn: () => api.get<{ models: Model[] }>("/api/gateway/models"),
    refetchInterval: POLL.slow,
  })
}

export interface ModelSelectProps {
  value: string
  onChange: (id: string) => void
  /** Bỏ combo khỏi danh sách — dùng khi đang SỬA combo (không cho combo lồng combo). */
  excludeCombo?: boolean
  /** Ẩn các id này (vd model đã chọn rồi). */
  exclude?: string[]
  /** Đẩy combo lên đầu kèm số bước — hữu ích ở trang thử API. */
  comboFirst?: boolean
  /** Gom nhóm theo provider. Mặc định bật khi có từ 2 provider trở lên. */
  group?: boolean
  /** Chữ hiện khi chưa chọn gì. Để trống + `value=""` là kiểu nút "+ Thêm model". */
  placeholder?: string
  disabled?: boolean
  className?: string
  /** Lọc thêm tuỳ trang (vd chỉ model nhận ảnh). */
  filter?: (m: Model) => boolean
}

export function ModelSelect({
  value,
  onChange,
  excludeCombo,
  exclude,
  comboFirst,
  group,
  placeholder = "Chọn model",
  disabled,
  className,
  filter,
}: ModelSelectProps) {
  const q = useModels()
  const all = q.data?.models ?? []

  const bo = new Set(exclude ?? [])
  let list = all.filter((m) => !bo.has(m.id))
  if (excludeCombo) list = list.filter((m) => m.kind !== "combo" && !m.id.startsWith("combo/"))
  if (filter) list = list.filter(filter)

  if (comboFirst) {
    // Combo nhiều bước nên dễ hỏng hơn model đơn — để lên đầu cho dễ thử.
    const c = list.filter((m) => m.kind === "combo")
    const k = list.filter((m) => m.kind !== "combo")
    list = [...c, ...k]
  }

  const nhom: Record<string, Model[]> = {}
  for (const m of list) {
    const g = m.providerLabel ?? m.provider ?? "Khác"
    ;(nhom[g] ??= []).push(m)
  }
  // Gom nhóm chỉ có nghĩa khi thật sự có nhiều provider; 1 nhóm thì tiêu đề chỉ tổ rối.
  const gomNhom = (group ?? true) && Object.keys(nhom).length > 1 && !comboFirst

  const hienThi = value || placeholder

  return (
    <Select value={value} onValueChange={(v) => onChange(v ?? "")} disabled={disabled || q.isLoading}>
      <SelectTrigger className={className ?? "h-8 w-60 text-xs"}>
        <span className={`truncate ${value ? "" : "text-muted-foreground"}`}>
          {q.isLoading ? "Đang tải…" : hienThi}
        </span>
      </SelectTrigger>
      <SelectContent>
        {list.length === 0 ? (
          <SelectItem value="" disabled className="text-xs">
            {q.isLoading ? "Đang tải…" : "Không có model nào"}
          </SelectItem>
        ) : gomNhom ? (
          Object.entries(nhom).map(([g, ms]) => (
            <div key={g}>
              <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">{g}</div>
              {ms.map((m) => (
                <SelectItem key={m.id} value={m.id} className="text-xs">
                  {m.id}
                </SelectItem>
              ))}
            </div>
          ))
        ) : (
          list.map((m) => (
            <SelectItem key={m.id} value={m.id} className="text-xs">
              {m.id}
              {m.kind === "combo" && m.steps?.length ? (
                <span className="ml-1.5 text-muted-foreground">({m.steps.length} bước)</span>
              ) : null}
            </SelectItem>
          ))
        )}
      </SelectContent>
    </Select>
  )
}
