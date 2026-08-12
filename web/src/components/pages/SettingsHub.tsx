import { lazy, Suspense } from "react"
import { Settings2, Terminal } from "lucide-react"
import { TabShell } from "@/components/common/TabShell"
import { PageHeader } from "@/components/common"

/**
 * Trang "Cấu hình" gộp: Settings + Connections + CLI Tools.
 *
 * Vá luồng đứt đã ghi trong kế hoạch: trang Connections hướng dẫn "thêm từ Settings"
 * nhưng Settings không hề có form đó — người dùng đi vòng rồi tắc. Gộp chung một trang
 * thì hai phần nằm cạnh nhau, chuyển tab là thấy.
 */
const Settings = lazy(() => import("./Settings").then((m) => ({ default: m.Settings })))
const CLITools = lazy(() => import("./CLITools").then((m) => ({ default: m.CLITools })))

const ic = "h-3.5 w-3.5"
const Loading = () => (
  <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">Đang tải…</div>
)

export function SettingsHub({ initial }: { initial?: string }) {
  return (
    <div className="space-y-4">
      <PageHeader title="Cấu hình" desc="Thiết lập gateway, kết nối và công cụ dòng lệnh" />
    <TabShell
      storageKey="Cấu hình"
      initial={initial}
      tabs={[
        {
          key: "general",
          label: "Chung",
          icon: <Settings2 className={ic} />,
          render: () => (
            <Suspense fallback={<Loading />}>
              <Settings />
            </Suspense>
          ),
        },
        {
          key: "cli",
          label: "CLI Tools",
          icon: <Terminal className={ic} />,
          render: () => (
            <Suspense fallback={<Loading />}>
              <CLITools />
            </Suspense>
          ),
        },
      ]}
    />
    </div>
  )
}
