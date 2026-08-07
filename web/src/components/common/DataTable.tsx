import { useMemo, useState, type ReactNode } from "react"
import { ChevronDown, ChevronUp, ChevronsUpDown, Inbox } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * Bảng dùng chung: sort bằng click header + phân trang + trạng thái rỗng/đang tải.
 *
 * Trước đây KHÔNG bảng nào cho sort bằng click header (Pool/Quota phải dùng dropdown
 * riêng), và Tokens/Proxy/Connections/Usage không hề phân trang — render toàn bộ danh
 * sách ra DOM.
 */

export interface Column<T> {
  key: string
  header: ReactNode
  /** Giá trị để SẮP XẾP. Bỏ trống = cột không sort được. */
  sort?: (row: T) => string | number
  render: (row: T) => ReactNode
  className?: string
  align?: "left" | "right" | "center"
}

interface Props<T> {
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string
  loading?: boolean
  empty?: ReactNode
  pageSize?: number
  /** Sort mặc định khi mở trang. */
  initialSort?: { key: string; dir: "asc" | "desc" }
  onRowClick?: (row: T) => void
}

export function DataTable<T>({
  rows, columns, rowKey, loading, empty, pageSize = 50, initialSort, onRowClick,
}: Props<T>) {
  const [sort, setSort] = useState(initialSort ?? null)
  const [page, setPage] = useState(0)

  const sorted = useMemo(() => {
    if (!sort) return rows
    const col = columns.find((c) => c.key === sort.key)
    if (!col?.sort) return rows
    const dir = sort.dir === "asc" ? 1 : -1
    // Bản sao rồi mới sort — sort tại chỗ sẽ đột biến mảng của React Query cache.
    return [...rows].sort((a, b) => {
      const x = col.sort!(a)
      const y = col.sort!(b)
      if (x === y) return 0
      return (x > y ? 1 : -1) * dir
    })
  }, [rows, sort, columns])

  const pages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const cur = Math.min(page, pages - 1)
  const view = sorted.slice(cur * pageSize, (cur + 1) * pageSize)

  const toggleSort = (key: string) => {
    setPage(0)
    setSort((s) =>
      s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" },
    )
  }

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    )
  }

  if (!rows.length) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
        <Inbox className="h-8 w-8 opacity-40" />
        <p className="text-sm">{empty ?? "Chưa có dữ liệu"}</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-card/60">
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  onClick={c.sort ? () => toggleSort(c.key) : undefined}
                  className={[
                    "px-3 py-2 text-xs font-medium text-muted-foreground whitespace-nowrap",
                    c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : "text-left",
                    c.sort ? "cursor-pointer select-none hover:text-foreground" : "",
                    c.className ?? "",
                  ].join(" ")}
                >
                  <span className="inline-flex items-center gap-1">
                    {c.header}
                    {c.sort ? (
                      sort?.key === c.key ? (
                        sort.dir === "asc" ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                      ) : (
                        <ChevronsUpDown className="h-3 w-3 opacity-30" />
                      )
                    ) : null}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.map((r) => (
              <tr
                key={rowKey(r)}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                className={[
                  "border-t border-border/60",
                  onRowClick ? "cursor-pointer hover:bg-card/60" : "",
                ].join(" ")}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={[
                      "px-3 py-2",
                      c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : "text-left",
                    ].join(" ")}
                  >
                    {c.render(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {cur * pageSize + 1}–{Math.min((cur + 1) * pageSize, sorted.length)} / {sorted.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={cur === 0}
              className="h-8 rounded-md border border-border px-2 disabled:opacity-40 hover:bg-card"
            >
              Trước
            </button>
            <span className="px-2">
              {cur + 1} / {pages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
              disabled={cur >= pages - 1}
              className="h-8 rounded-md border border-border px-2 disabled:opacity-40 hover:bg-card"
            >
              Sau
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
