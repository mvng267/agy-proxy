import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { POLL } from "@/lib/queryClient"
import { KpiCard, ChartCard } from "@/components/common"
import { DataTable, type Column } from "@/components/common/DataTable"
import { LogTag, statusTone } from "@/components/common/LogTag"
import { RankBar } from "@/components/common/charts"
import { Card, CardContent } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { Activity, AlertTriangle, Clock, X } from "lucide-react"

/**
 * Lịch sử + báo cáo chạy combo — TỪNG BƯỚC.
 *
 * `combo_runs` ghi đủ chi tiết từ lâu (engine.ts ghi ở cả nhánh thành công lẫn nhánh trượt)
 * nhưng chưa từng được phơi ra: hàm đọc duy nhất `comboStatsRows` chỉ trả hai con số tổng.
 * Đo trên production 12/08/2026 — 19.180 dòng nằm im, trong đó:
 *
 *   bước 0  agy/gemini-3.5-flash-low         12.245 lần ·  56% trượt · p95 63s
 *   bước 1  agy/gemini-3.5-flash-extra-low    6.828 lần · 100% trượt · p95 54s
 *
 * Bước 1 chưa THÀNH CÔNG lần nào mà vẫn tốn thêm ~54 giây cho mỗi request đi qua. Không có
 * màn này thì không cách nào biết.
 */

interface RunRow {
  ts: number
  combo: string
  step: number
  model: string
  ok: number
  status: number | null
  ms: number | null
  reason: string | null
}

interface StepStat {
  combo: string
  step: number
  model: string
  runs: number
  fails: number
  p50: number
  p95: number
}

interface RunsResponse {
  rows: RunRow[]
  total: number
  limit: number
  offset: number
  steps: StepStat[]
  facets: {
    combos: { value: string; n: number }[]
    models: { value: string; n: number }[]
    statuses: { value: number; n: number }[]
  }
}

const RANGES = [
  { k: "1d", label: "24 giờ" },
  { k: "7d", label: "7 ngày" },
  { k: "30d", label: "30 ngày" },
] as const

const PAGE = 100

function fmtMs(ms?: number | null): string {
  if (!ms) return "—"
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

export function ComboRuns({ tab }: { tab: "log" | "bao-cao" }) {
  const [range, setRange] = useState<string>("7d")
  const [combo, setCombo] = useState("")
  const [model, setModel] = useState("")
  const [ok, setOk] = useState("")
  const [page, setPage] = useState(0)

  const qs = new URLSearchParams({ range, limit: String(PAGE), offset: String(page * PAGE) })
  if (combo) qs.set("combo", combo)
  if (model) qs.set("model", model)
  if (ok) qs.set("ok", ok)

  const q = useQuery({
    queryKey: ["combo-runs", qs.toString()],
    queryFn: () => api.get<RunsResponse>(`/api/combos/runs?${qs}`),
    refetchInterval: POLL.normal,
  })

  const d = q.data
  const dangLoc = !!(combo || model || ok)
  const xoaLoc = () => { setCombo(""); setModel(""); setOk(""); setPage(0) }

  /** Đổi bộ lọc thì về trang 1 — giữ nguyên trang cũ dễ ra bảng rỗng vô cớ. */
  const doiLoc = (fn: () => void) => { fn(); setPage(0) }

  const tongBuoc = d?.steps.reduce((s, x) => s + x.runs, 0) ?? 0
  const tongTruot = d?.steps.reduce((s, x) => s + x.fails, 0) ?? 0
  const p95Max = d?.steps.reduce((m, x) => Math.max(m, x.p95), 0) ?? 0

  const boLoc = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1">
        {RANGES.map((r) => (
          <button
            key={r.k}
            onClick={() => doiLoc(() => setRange(r.k))}
            className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
              range === r.k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      <Select value={combo} onValueChange={(v) => doiLoc(() => setCombo(v ?? ""))}>
        <SelectTrigger className="h-8 w-52 text-xs">
          <span className="truncate">{combo || `Mọi combo (${d?.facets.combos.length ?? 0})`}</span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="" className="text-xs">Mọi combo</SelectItem>
          {(d?.facets.combos ?? []).map((c) => (
            <SelectItem key={c.value} value={c.value} className="text-xs">
              {c.value} ({c.n.toLocaleString("vi-VN")})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={model} onValueChange={(v) => doiLoc(() => setModel(v ?? ""))}>
        <SelectTrigger className="h-8 w-56 text-xs">
          <span className="truncate">{model || `Mọi model (${d?.facets.models.length ?? 0})`}</span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="" className="text-xs">Mọi model</SelectItem>
          {(d?.facets.models ?? []).map((m) => (
            <SelectItem key={m.value} value={m.value} className="text-xs">
              {m.value} ({m.n.toLocaleString("vi-VN")})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={ok} onValueChange={(v) => doiLoc(() => setOk(v ?? ""))}>
        <SelectTrigger className="h-8 w-32 text-xs">
          <span className="truncate">{ok === "1" ? "Thành công" : ok === "0" ? "Trượt" : "Mọi kết quả"}</span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="" className="text-xs">Mọi kết quả</SelectItem>
          <SelectItem value="0" className="text-xs">Chỉ bước trượt</SelectItem>
          <SelectItem value="1" className="text-xs">Chỉ thành công</SelectItem>
        </SelectContent>
      </Select>

      {dangLoc && (
        <Button variant="ghost" size="sm" onClick={xoaLoc} className="h-8 gap-1 px-2 text-xs">
          <X className="h-3 w-3" />
          Bỏ lọc
        </Button>
      )}
    </div>
  )

  // ── Tab BÁO CÁO ────────────────────────────────────────────────────────
  if (tab === "bao-cao") {
    const stepCols: Column<StepStat>[] = [
      {
        key: "combo", header: "Combo", sort: (r) => r.combo,
        render: (r) => <span className="font-mono text-xs text-foreground">{r.combo.replace(/^combo\//, "")}</span>,
      },
      {
        key: "step", header: "Bước", align: "right", sort: (r) => r.step,
        render: (r) => <span className="text-xs tabular-nums text-muted-foreground">{r.step + 1}</span>,
      },
      {
        key: "model", header: "Model", sort: (r) => r.model,
        render: (r) => <span className="font-mono text-xs text-foreground">{r.model}</span>,
      },
      {
        key: "runs", header: "Số lần", align: "right", sort: (r) => r.runs,
        render: (r) => <span className="text-xs tabular-nums text-foreground">{r.runs.toLocaleString("vi-VN")}</span>,
      },
      {
        /**
         * Cột đáng nhìn nhất: bước trượt 100% là bước VÔ DỤNG — nó chưa từng trả lời được
         * lần nào mà vẫn tốn thời gian chờ trước khi combo sang bước kế.
         */
        key: "fails", header: "Trượt", align: "right", sort: (r) => (r.runs ? r.fails / r.runs : 0),
        render: (r) => {
          const pct = r.runs ? Math.round((r.fails / r.runs) * 100) : 0
          return (
            <span className={`text-xs tabular-nums ${pct >= 100 ? "text-destructive" : pct >= 50 ? "text-warning" : "text-muted-foreground"}`}>
              {r.fails.toLocaleString("vi-VN")} ({pct}%)
            </span>
          )
        },
      },
      {
        key: "p50", header: "p50", align: "right", sort: (r) => r.p50,
        render: (r) => <span className="text-xs tabular-nums text-muted-foreground">{fmtMs(r.p50)}</span>,
      },
      {
        key: "p95", header: "p95", align: "right", sort: (r) => r.p95,
        render: (r) => (
          <span className={`text-xs tabular-nums ${r.p95 > 30_000 ? "text-warning" : "text-muted-foreground"}`}>
            {fmtMs(r.p95)}
          </span>
        ),
      },
    ]

    // Gộp theo combo cho biểu đồ xếp hạng.
    const theoCombo = new Map<string, { runs: number; fails: number }>()
    for (const s of d?.steps ?? []) {
      const cur = theoCombo.get(s.combo) ?? { runs: 0, fails: 0 }
      cur.runs += s.runs
      cur.fails += s.fails
      theoCombo.set(s.combo, cur)
    }
    const rank = [...theoCombo.entries()].sort((a, b) => b[1].runs - a[1].runs).slice(0, 8)
    const maxRuns = rank[0]?.[1].runs ?? 1

    return (
      <div className="space-y-4">
        {boLoc}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard label="Tổng lượt bước" value={tongBuoc.toLocaleString("vi-VN")} icon={Activity} loading={q.isLoading} />
          <KpiCard
            label="Bước trượt"
            value={tongTruot.toLocaleString("vi-VN")}
            tone={tongBuoc && tongTruot / tongBuoc >= 0.5 ? "danger" : "warning"}
            sub={tongBuoc ? `${Math.round((tongTruot / tongBuoc) * 100)}% tổng` : undefined}
            icon={AlertTriangle}
            loading={q.isLoading}
          />
          <KpiCard label="p95 chậm nhất" value={fmtMs(p95Max)} icon={Clock} loading={q.isLoading} />
          <KpiCard label="Combo có dữ liệu" value={theoCombo.size} icon={Activity} loading={q.isLoading} />
        </div>

        {rank.length > 0 && (
          <ChartCard title="Lượt bước theo combo">
            <div className="space-y-2">
              {rank.map(([name, v]) => (
                <RankBar
                  key={name}
                  label={name.replace(/^combo\//, "")}
                  value={v.runs}
                  max={maxRuns}
                  tone={v.runs && v.fails / v.runs >= 0.5 ? "chart-danger" : "chart-1"}
                  format={(n) => n.toLocaleString("vi-VN")}
                />
              ))}
            </div>
          </ChartCard>
        )}

        <Card>
          <CardContent className="p-0">
            <DataTable
              rows={d?.steps ?? []}
              columns={stepCols}
              rowKey={(r) => `${r.combo}-${r.step}-${r.model}`}
              loading={q.isLoading}
              pageSize={25}
              initialSort={{ key: "runs", dir: "desc" }}
              empty="Chưa có lượt chạy combo nào trong khoảng này"
            />
          </CardContent>
        </Card>
      </div>
    )
  }

  // ── Tab LOG ────────────────────────────────────────────────────────────
  const logCols: Column<RunRow>[] = [
    {
      key: "ts", header: "Thời gian", sort: (r) => r.ts,
      render: (r) => (
        <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
          {new Date(r.ts).toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </span>
      ),
    },
    {
      key: "combo", header: "Combo", sort: (r) => r.combo,
      render: (r) => (
        <button onClick={() => doiLoc(() => setCombo(r.combo))} className="font-mono text-xs hover:text-primary hover:underline">
          {r.combo.replace(/^combo\//, "")}
        </button>
      ),
    },
    {
      key: "step", header: "Bước", align: "right", sort: (r) => r.step,
      render: (r) => <span className="text-xs tabular-nums text-muted-foreground">{r.step + 1}</span>,
    },
    {
      key: "ok", header: "Kết quả", sort: (r) => r.ok,
      render: (r) =>
        r.ok
          ? <LogTag tone="ok" value="OK" />
          : <LogTag tone={statusTone(r.status ?? undefined)} value={r.status ?? "trượt"} />,
    },
    {
      key: "model", header: "Model", sort: (r) => r.model,
      render: (r) => (
        <button onClick={() => doiLoc(() => setModel(r.model))} className="font-mono text-xs hover:text-primary hover:underline">
          {r.model}
        </button>
      ),
    },
    {
      key: "ms", header: "Thời lượng", align: "right", sort: (r) => r.ms ?? 0,
      render: (r) => (
        <span className={`text-xs tabular-nums ${(r.ms ?? 0) > 30_000 ? "text-warning" : "text-muted-foreground"}`}>
          {fmtMs(r.ms)}
        </span>
      ),
    },
    {
      key: "reason", header: "Lý do",
      render: (r) =>
        r.reason
          ? <span className="block max-w-[26rem] truncate text-xs text-muted-foreground" title={r.reason}>{r.reason}</span>
          : <span className="text-xs text-muted-foreground/50">—</span>,
    },
  ]

  const tongTrang = Math.ceil((d?.total ?? 0) / PAGE)

  return (
    <div className="space-y-4">
      {boLoc}

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {d ? `${d.total.toLocaleString("vi-VN")} lượt bước` : "…"}
          {dangLoc ? " (đã lọc)" : ""}
        </span>
        {tongTrang > 1 && (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)} className="h-7 text-xs">
              Trước
            </Button>
            <span className="tabular-nums">{page + 1}/{tongTrang}</span>
            <Button variant="outline" size="sm" disabled={page + 1 >= tongTrang} onClick={() => setPage((p) => p + 1)} className="h-7 text-xs">
              Sau
            </Button>
          </div>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {/* Phân trang PHÍA SERVER (nút Trước/Sau ở trên) — pageSize lớn hơn PAGE để
              DataTable không phân trang lần hai trên cùng tập dữ liệu. */}
          <DataTable
            rows={d?.rows ?? []}
            columns={logCols}
            rowKey={(r) => `${r.ts}-${r.combo}-${r.step}-${r.model}`}
            loading={q.isLoading}
            pageSize={PAGE + 1}
            empty="Chưa có lượt chạy nào khớp bộ lọc"
          />
        </CardContent>
      </Card>
    </div>
  )
}
