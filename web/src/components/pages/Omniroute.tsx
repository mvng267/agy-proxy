import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Cpu, Link2, Loader2, PlugZap, Route } from "lucide-react"
import { api } from "@/lib/api"
import { POLL } from "@/lib/queryClient"
import { DataTable, KpiCard, PageHeader, StatusBadge, ErrorState, type Column } from "@/components/common"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/toast"

/**
 * OmniRoute — xem cấu hình routing upstream: connections (providers) và models
 * mà instance OmniRoute đang phục vụ. Chỉ đọc; URL/mật khẩu sửa ở trang Cấu hình.
 */

interface OmniConnection {
  id: string
  provider: string
  authType: string
  name: string
  priority: number
  isActive: boolean
  testStatus: string
  proxyEnabled?: boolean
  createdAt?: string
}

interface OmniModel {
  provider: string
  model: string
  fullModel: string
  name: string
  available: boolean
}

export function Omniroute() {
  const qc = useQueryClient()
  const toast = useToast()

  const conns = useQuery({
    queryKey: ["omniroute", "connections"],
    queryFn: () => api.get<{ ok: boolean; connections?: OmniConnection[]; error?: string }>("/api/omniroute/connections"),
    refetchInterval: POLL.normal,
  })

  const models = useQuery({
    queryKey: ["omniroute", "models"],
    queryFn: () => api.get<{ ok: boolean; models?: OmniModel[]; error?: string }>("/api/omniroute/models"),
    refetchInterval: POLL.slow,
  })

  const cfg = useQuery({
    queryKey: ["config"],
    queryFn: () => api.get<{ omnirouteUrl: string }>("/api/config"),
  })

  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; connections?: number; error?: string }>("/api/settings/omniroute/test"),
    onSuccess: (r) => {
      if (r.ok) toast({ title: "Kết nối OK", description: `${r.connections} connection`, variant: "success" })
      else toast({ title: "Kết nối lỗi", description: r.error, variant: "error" })
      qc.invalidateQueries({ queryKey: ["omniroute"] })
    },
    onError: (e) => toast({ title: "Lỗi", description: e.message, variant: "error" }),
  })

  if (conns.isError) return <ErrorState error={conns.error} onRetry={() => conns.refetch()} />

  const online = conns.data?.ok === true
  const connList = conns.data?.connections ?? []
  const modelList = models.data?.models ?? []
  const activeCount = connList.filter((c) => c.isActive).length
  const availModels = modelList.filter((m) => m.available).length

  const connCols: Column<OmniConnection>[] = [
    {
      key: "name",
      header: "Tên",
      sort: (r) => r.name.toLowerCase(),
      render: (r) => <span className="font-medium text-foreground">{r.name}</span>,
    },
    {
      key: "provider",
      header: "Provider",
      sort: (r) => r.provider,
      render: (r) => <code className="rounded bg-background px-1.5 py-0.5 text-xs">{r.provider}</code>,
    },
    {
      key: "authType",
      header: "Auth",
      sort: (r) => r.authType,
      render: (r) => <span className="text-xs text-muted-foreground">{r.authType}</span>,
    },
    {
      key: "priority",
      header: "Ưu tiên",
      align: "right",
      sort: (r) => r.priority,
      render: (r) => <span className="tabular-nums">{r.priority}</span>,
    },
    {
      key: "test",
      header: "Test",
      sort: (r) => r.testStatus,
      render: (r) => (
        <StatusBadge
          status={r.testStatus === "success" ? "ok" : r.testStatus === "failed" ? "error" : "unknown"}
          label={r.testStatus || "chưa test"}
        />
      ),
    },
    {
      key: "active",
      header: "Trạng thái",
      sort: (r) => (r.isActive ? 1 : 0),
      render: (r) => <StatusBadge status={r.isActive ? "ok" : "off"} label={r.isActive ? "Hoạt động" : "Tắt"} />,
    },
  ]

  const modelCols: Column<OmniModel>[] = [
    {
      key: "fullModel",
      header: "Model",
      sort: (r) => r.fullModel,
      render: (r) => <code className="rounded bg-background px-1.5 py-0.5 text-xs">{r.fullModel}</code>,
    },
    {
      key: "name",
      header: "Tên hiển thị",
      sort: (r) => r.name.toLowerCase(),
      render: (r) => <span className="text-muted-foreground">{r.name}</span>,
    },
    {
      key: "provider",
      header: "Provider",
      sort: (r) => r.provider,
      render: (r) => <span className="text-xs text-muted-foreground">{r.provider}</span>,
    },
    {
      key: "available",
      header: "Sẵn sàng",
      sort: (r) => (r.available ? 1 : 0),
      render: (r) => <StatusBadge status={r.available ? "ok" : "off"} label={r.available ? "Có" : "Không"} />,
    },
  ]

  return (
    <div>
      <PageHeader
        title="OmniRoute"
        desc={
          cfg.data?.omnirouteUrl
            ? `Routing upstream tại ${cfg.data.omnirouteUrl} — sửa URL/mật khẩu ở trang Cấu hình`
            : "Cấu hình routing provider upstream"
        }
        actions={
          <Button size="sm" onClick={() => test.mutate()} disabled={test.isPending} className="h-8 gap-1.5 text-xs">
            {test.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlugZap className="h-3.5 w-3.5" />}
            Test kết nối
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label="Kết nối"
          value={online ? "Online" : "Offline"}
          sub={!online ? conns.data?.error : undefined}
          icon={Route}
          tone={online ? "success" : "danger"}
          loading={conns.isPending}
        />
        <KpiCard
          label="Connections"
          value={connList.length}
          sub={`${activeCount} đang hoạt động`}
          icon={Link2}
          loading={conns.isPending}
        />
        <KpiCard
          label="Models"
          value={modelList.length}
          sub={`${availModels} sẵn sàng`}
          icon={Cpu}
          loading={models.isPending}
        />
        <KpiCard
          label="Provider"
          value={new Set(connList.map((c) => c.provider)).size}
          sub="loại provider khác nhau"
          icon={Route}
          loading={conns.isPending}
        />
      </div>

      <Card className="mt-4 bg-card border-border">
        <CardContent className="p-4">
          <h3 className="mb-3 text-sm font-medium text-foreground">Connections ({connList.length})</h3>
          <DataTable
            rows={connList}
            columns={connCols}
            rowKey={(r) => r.id}
            loading={conns.isPending}
            empty={online ? "OmniRoute chưa có connection nào" : "Không kết nối được OmniRoute — kiểm tra URL/mật khẩu ở Cấu hình"}
            initialSort={{ key: "priority", dir: "asc" }}
          />
        </CardContent>
      </Card>

      <Card className="mt-4 bg-card border-border">
        <CardContent className="p-4">
          <h3 className="mb-3 text-sm font-medium text-foreground">Models ({modelList.length})</h3>
          <DataTable
            rows={modelList}
            columns={modelCols}
            rowKey={(r) => r.fullModel}
            loading={models.isPending}
            empty="Không lấy được danh sách model"
            pageSize={20}
          />
        </CardContent>
      </Card>
    </div>
  )
}
