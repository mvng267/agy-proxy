import { lazy, Suspense } from "react"
import { KeyRound, UserPlus, Users } from "lucide-react"
import { TabShell } from "@/components/common/TabShell"

/**
 * Trang "Tài khoản" gộp: Accounts + Tokens + Thêm tài khoản.
 *
 * Tokens hiển thị *trạng thái token của chính những account này* — tách thành trang
 * riêng bắt người dùng nhớ hai nơi cho cùng một tập dữ liệu. "Thêm tài khoản" là một
 * hành động, không phải một mục điều hướng ngang hàng, nên vào đây làm tab cuối.
 */
const Accounts = lazy(() => import("./Accounts").then((m) => ({ default: m.Accounts })))
const Tokens = lazy(() => import("./Tokens").then((m) => ({ default: m.Tokens })))
const AddAccount = lazy(() => import("./AddAccount").then((m) => ({ default: m.AddAccount })))

const ic = "h-3.5 w-3.5"
const Loading = () => (
  <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">Đang tải…</div>
)

export function AccountsHub() {
  return (
    <TabShell
      storageKey="Tài khoản"
      tabs={[
        {
          key: "list",
          label: "Danh sách",
          icon: <Users className={ic} />,
          render: () => (
            <Suspense fallback={<Loading />}>
              <Accounts />
            </Suspense>
          ),
        },
        {
          key: "tokens",
          label: "Tokens",
          icon: <KeyRound className={ic} />,
          render: () => (
            <Suspense fallback={<Loading />}>
              <Tokens />
            </Suspense>
          ),
        },
        {
          key: "add",
          label: "Thêm tài khoản",
          icon: <UserPlus className={ic} />,
          render: () => (
            <Suspense fallback={<Loading />}>
              <AddAccount />
            </Suspense>
          ),
        },
      ]}
    />
  )
}
