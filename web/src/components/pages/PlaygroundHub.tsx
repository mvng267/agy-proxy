import { lazy, Suspense } from "react"
import { MessageSquare, Plug, Columns3 } from "lucide-react"
import { TabShell } from "@/components/common/TabShell"
import { PageHeader } from "@/components/common"

/**
 * Playground — ba cách thử, ba câu hỏi khác nhau:
 *
 *  Chat thử   "model này trả lời thế nào" — hội thoại nhiều lượt, gửi/nhận ảnh
 *  Gọi API    "client ngoài cắm vào có chạy không" — đúng endpoint, đúng header, bằng API key
 *  So sánh    "nên chọn model nào" — cùng prompt, nhiều model, chạy song song
 *
 * Tách ba vì chúng trả lời ba câu khác nhau, nhưng gộp một trang vì cùng là "thử".
 */
const Chat = lazy(() => import("./Chat").then((m) => ({ default: m.Chat })))
const ApiPlayground = lazy(() => import("./ApiPlayground").then((m) => ({ default: m.ApiPlayground })))
const ModelCompare = lazy(() => import("./ModelCompare").then((m) => ({ default: m.ModelCompare })))

const ic = "h-3.5 w-3.5"
const Loading = () => (
  <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">Đang tải…</div>
)

export function PlaygroundHub({ initial }: { initial?: string }) {
  return (
    <div className="space-y-4">
      <PageHeader title="Playground" desc="Thử model, thử chuẩn kết nối, so sánh model" />
      <TabShell
        storageKey="Playground"
        initial={initial}
        tabs={[
          {
            key: "chat",
            label: "Chat thử",
            icon: <MessageSquare className={ic} />,
            render: () => (
              <Suspense fallback={<Loading />}>
                <Chat />
              </Suspense>
            ),
          },
          {
            key: "api",
            label: "Gọi API",
            icon: <Plug className={ic} />,
            render: () => (
              <Suspense fallback={<Loading />}>
                <ApiPlayground />
              </Suspense>
            ),
          },
          {
            key: "compare",
            label: "So sánh model",
            icon: <Columns3 className={ic} />,
            render: () => (
              <Suspense fallback={<Loading />}>
                <ModelCompare />
              </Suspense>
            ),
          },
        ]}
      />
    </div>
  )
}
