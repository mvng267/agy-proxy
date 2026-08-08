import { Fragment, useMemo, useState, type ReactNode } from "react"
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ChevronsUpDown, Inbox } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"

/**
 * Bảng dùng chung: sort bằng click header + phân trang + trạng thái rỗng/đang tải.
 *
 * Dựng trên `ui/table` chứ KHÔNG tự viết `<table>` như trước. Bản cũ tự viết thẻ thô nên
 * repo có hai hệ style bảng song song: 6 trang dùng `ui/table`, 7 bảng dùng bản này, và
 * chúng lệch nhau về chiều cao dòng, cỡ chữ tiêu đề, đệm ngang. Giờ chỉ còn một nguồn.
 *
 * Cũng bỏ luôn `border border-border rounded-lg` tự bọc: khuôn Atlas là lọc + bảng +
 * phân trang cùng nằm TRONG một Card, viền tự vẽ sẽ thành viền lồng viền. (Đây là lý do
 * `ApiKeys.tsx` từng phải để bảng đứng trần ngoài Card.)
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
  /** Hiện bộ chọn số dòng/trang (khuôn Atlas). Mặc định bật khi có nhiều hơn 1 trang. */
  rowsPerPage?: number[]
  /**
   * Chọn nhiều dòng. Trước đây DataTable không hỗ trợ nên Accounts/Pool/Quota phải
   * tự viết cả bảng chỉ vì cần checkbox.
   */
  selection?: {
    selected: Set<string>
    onChange: (next: Set<string>) => void
  }
  /**
   * Hàng chi tiết mở rộng dưới mỗi dòng. `render` trả về null nghĩa là dòng đó không
   * mở rộng được. Trang Hạn mức dùng để xem quota từng model mà không phải rời trang.
   */
  expand?: {
    expanded: Set<string>
    onToggle: (key: string) => void
    render: (row: T) => ReactNode
  }
}

const DEFAULT_SIZES = [10, 25, 50, 100]

export function DataTable<T>({
  rows, columns, rowKey, loading, empty, pageSize = 50, initialSort, onRowClick,
  rowsPerPage, selection, expand,
}: Props<T>) {
  const [sort, setSort] = useState(initialSort ?? null)
  const [page, setPage] = useState(0)
  const [size, setSize] = useState(pageSize)

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

  const pages = Math.max(1, Math.ceil(sorted.length / size))
  const cur = Math.min(page, pages - 1)
  const view = sorted.slice(cur * size, (cur + 1) * size)

  const toggleSort = (key: string) => {
    setPage(0)
    setSort((s) =>
      s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" },
    )
  }

  // Checkbox "chọn tất cả" chỉ tác động lên TRANG ĐANG XEM — bấm một cái mà chọn luôn
  // 700 account ở các trang khác là hành vi bất ngờ và khó hoàn tác.
  const viewKeys = view.map(rowKey)
  const allOnPage = viewKeys.length > 0 && viewKeys.every((k) => selection?.selected.has(k))
  const someOnPage = viewKeys.some((k) => selection?.selected.has(k))
  const toggleAll = () => {
    if (!selection) return
    const next = new Set(selection.selected)
    if (allOnPage) viewKeys.forEach((k) => next.delete(k))
    else viewKeys.forEach((k) => next.add(k))
    selection.onChange(next)
  }
  const toggleOne = (k: string) => {
    if (!selection) return
    const next = new Set(selection.selected)
    next.has(k) ? next.delete(k) : next.add(k)
    selection.onChange(next)
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

  const alignOf = (c: Column<T>) =>
    c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : "text-left"

  const sizes = rowsPerPage ?? DEFAULT_SIZES
  const from = cur * size + 1
  const to = Math.min((cur + 1) * size, sorted.length)

  // Dải nút số trang, tối đa 5, trượt quanh trang hiện tại.
  const pageNums = Array.from({ length: Math.min(5, pages) }, (_, i) =>
    Math.max(0, Math.min(pages - 5, cur - 2)) + i,
  ).filter((n) => n < pages)

  return (
    <div>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {expand && <TableHead className="w-8" />}
            {selection && (
              <TableHead className="w-10">
                <Checkbox
                  checked={allOnPage}
                  indeterminate={!allOnPage && someOnPage}
                  onCheckedChange={toggleAll}
                  aria-label="Chọn tất cả dòng trên trang"
                />
              </TableHead>
            )}
            {columns.map((c) => (
              <TableHead
                key={c.key}
                onClick={c.sort ? () => toggleSort(c.key) : undefined}
                className={cn(
                  alignOf(c),
                  c.sort && "cursor-pointer select-none hover:text-foreground",
                  c.className,
                )}
              >
                <span className={cn("inline-flex items-center gap-1", c.align === "right" && "flex-row-reverse")}>
                  {c.header}
                  {c.sort ? (
                    sort?.key === c.key ? (
                      sort.dir === "asc" ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />
                    ) : (
                      <ChevronsUpDown className="size-3.5 opacity-30" />
                    )
                  ) : null}
                </span>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {view.map((r) => {
            const k = rowKey(r)
            const detail = expand?.expanded.has(k) ? expand.render(r) : null
            return (
              <Fragment key={k}>
              <TableRow
                data-state={selection?.selected.has(k) ? "selected" : undefined}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                className={cn(onRowClick && "cursor-pointer")}
              >
                {expand && (
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    {expand.render(r) ? (
                      <button
                        onClick={() => expand.onToggle(k)}
                        aria-expanded={expand.expanded.has(k)}
                        aria-label={expand.expanded.has(k) ? "Thu gọn" : "Xem chi tiết"}
                        className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        {expand.expanded.has(k)
                          ? <ChevronDown className="size-3.5" />
                          : <ChevronRight className="size-3.5" />}
                      </button>
                    ) : null}
                  </TableCell>
                )}
                {selection && (
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selection.selected.has(k)}
                      onCheckedChange={() => toggleOne(k)}
                      aria-label={`Chọn ${k}`}
                    />
                  </TableCell>
                )}
                {columns.map((c) => (
                  <TableCell key={c.key} className={alignOf(c)}>
                    {c.render(r)}
                  </TableCell>
                ))}
              </TableRow>
              {detail && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={columns.length + (expand ? 1 : 0) + (selection ? 1 : 0)} className="bg-muted/30 py-3">
                    {detail}
                  </TableCell>
                </TableRow>
              )}
              </Fragment>
            )
          })}
        </TableBody>
      </Table>

      {/*
        Chân bảng theo khuôn Atlas: "Rows per page" bên trái, "1-10 of 25" + nút trang bên
        phải. Hiện KỂ CẢ khi chỉ có 1 trang — bản cũ ẩn hẳn (`pages > 1`) làm bảng cụt lủn
        và người dùng mất luôn chỗ đổi số dòng/trang.
      */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <span>Số dòng</span>
          <select
            value={size}
            onChange={(e) => { setSize(Number(e.target.value)); setPage(0) }}
            className="h-7 rounded-md border border-border bg-transparent px-1.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {sizes.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>

        <div className="flex items-center gap-3">
          <span className="tabular-nums">{from}–{to} / {sorted.length}</span>
          {pages > 1 && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={cur === 0}
                aria-label="Trang trước"
                className="flex size-7 items-center justify-center rounded-md border border-border disabled:opacity-40 hover:bg-muted"
              >
                <ChevronLeft className="size-3.5" />
              </button>
              {pageNums.map((n) => (
                <button
                  key={n}
                  onClick={() => setPage(n)}
                  aria-current={n === cur ? "page" : undefined}
                  className={cn(
                    "size-7 rounded-md border text-xs tabular-nums",
                    n === cur
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border hover:bg-muted",
                  )}
                >
                  {n + 1}
                </button>
              ))}
              <button
                onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
                disabled={cur >= pages - 1}
                aria-label="Trang sau"
                className="flex size-7 items-center justify-center rounded-md border border-border disabled:opacity-40 hover:bg-muted"
              >
                <ChevronRight className="size-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
