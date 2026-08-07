import { useState, useEffect, lazy, Suspense } from "react"
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query"
import { queryClient } from "@/lib/queryClient"
import { RefreshCw } from "lucide-react"
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { AppSidebar } from "@/components/AppSidebar"
import { ToastProvider } from "@/components/ui/toast"
import { ErrorBoundary } from "@/components/ErrorBoundary"

const Overview = lazy(() => import("@/components/Overview").then((m) => ({ default: m.Overview })))
// ── Pages (lazy-load: mỗi trang một chunk riêng) ──────────────────────
// Chunk khởi động chỉ chứa khung app; trang nào mở mới tải trang đó.
// Trang GỘP (kế hoạch 15 → 11): Tài khoản ← Accounts+Tokens+Thêm; Cấu hình ← Settings+Connections+CLI.
const AccountsHub = lazy(() => import("@/components/pages/AccountsHub").then((m) => ({ default: m.AccountsHub })))
const SettingsHub = lazy(() => import("@/components/pages/SettingsHub").then((m) => ({ default: m.SettingsHub })))
const Pool = lazy(() => import("@/components/pages/Pool").then((m) => ({ default: m.Pool })))
const Models = lazy(() => import("@/components/pages/Models").then((m) => ({ default: m.Models })))
const Combo = lazy(() => import("@/components/pages/Combo").then((m) => ({ default: m.Combo })))
const Proxy = lazy(() => import("@/components/pages/Proxy").then((m) => ({ default: m.Proxy })))
const Quota = lazy(() => import("@/components/pages/Quota").then((m) => ({ default: m.Quota })))
// Trang Usage cũ được thay bằng Reports (lọc theo key/combo). Giữ tab "usage" để link cũ vẫn chạy.
const Reports = lazy(() => import("@/components/pages/Reports").then((m) => ({ default: m.Reports })))
const Chat = lazy(() => import("@/components/pages/Chat").then((m) => ({ default: m.Chat })))
const LiveLog = lazy(() => import("@/components/pages/LiveLog").then((m) => ({ default: m.LiveLog })))
const ApiKeys = lazy(() => import("@/components/pages/ApiKeys").then((m) => ({ default: m.ApiKeys })))

// ── Page title mapping ─────────────────────────────────────────────────

const tabTitles: Record<string, string> = {
  overview: "Dashboard",
  accounts: "Tài khoản",
  tokens: "Tài khoản",
  proxies: "Proxy",
  add: "Tài khoản",
  agy: "Pool",
  models: "Models",
  combo: "Combo",
  quota: "Hạn mức",
  connections: "Cấu hình",
  usage: "Báo cáo",
  reports: "Báo cáo",
  chat: "Chat thử",
  gwlog: "Live Log",
  tools: "Cấu hình",
  settings: "Cấu hình",
  keys: "API Keys",
}

// ── Page router ────────────────────────────────────────────────────────

function PageContent({ tab }: { tab: string }) {
  switch (tab) {
    case "overview":
      return <Overview />
    // Tab cũ (tokens/add) trỏ vào hub — link đã lưu của người dùng vẫn mở được.
    case "accounts":
    case "tokens":
    case "add":
      return <AccountsHub />
    case "agy":
      return <Pool />
    case "models":
      return <Models />
    case "combo":
      return <Combo />
    case "proxies":
      return <Proxy />
    case "quota":
      return <Quota />
    case "usage":
    case "reports":
      return <Reports />
    case "chat":
      return <Chat />
    case "gwlog":
      return <LiveLog />
    case "tools":
    case "connections":
    case "settings":
      return <SettingsHub />
    case "keys":
      return <ApiKeys />
    default:
      return (
        <div className="flex flex-col items-center justify-center h-64 gap-3">
          <p className="text-sm text-slate-500">
            {tabTitles[tab] ?? tab} — not found
          </p>
        </div>
      )
  }
}

// ── App ────────────────────────────────────────────────────────────────

/**
 * Tab hiện tại lấy từ URL thay vì useState.
 * Trước đây F5 luôn về "overview", không share được link, không có back/forward.
 * Dùng path đơn giản (`/pool`) — SPA fallback ở backend đã trả index.html cho mọi route.
 */
function useTabFromUrl(): [string, (t: string) => void] {
  const [tab, setTab] = useState(() => window.location.pathname.slice(1) || "overview")

  useEffect(() => {
    const onPop = () => setTab(window.location.pathname.slice(1) || "overview")
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

  const go = (t: string) => {
    const path = t === "overview" ? "/" : `/${t}`
    if (window.location.pathname !== path) window.history.pushState(null, "", path)
    setTab(t)
  }
  return [tab, go]
}

function AppShell() {
  const [activeTab, setActiveTab] = useTabFromUrl()
  const qc = useQueryClient()

  return (
    <ToastProvider>
      <ErrorBoundary>
        <SidebarProvider>
          <AppSidebar
            activeTab={activeTab}
            onTabChange={setActiveTab}
          />
          <SidebarInset>
            {/* Topbar */}
            <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-slate-800 bg-slate-950/80 backdrop-blur-sm px-4">
              <SidebarTrigger className="-ml-1 text-slate-400 hover:text-slate-200" />
              <Separator orientation="vertical" className="h-5 bg-slate-800" />
              <div className="flex items-center gap-2">
                <h1 className="text-sm font-medium text-slate-200">
                  {tabTitles[activeTab] ?? activeTab}
                </h1>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <button
                  onClick={() => qc.invalidateQueries()}
                  className="p-1.5 rounded-md text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-colors"
                  title="Làm mới dữ liệu"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
              </div>
            </header>

            {/* Content */}
            <main className="flex-1 p-4 lg:p-6 bg-slate-950">
              <Suspense fallback={<div className="flex h-64 items-center justify-center text-sm text-slate-500">Đang tải…</div>}>
                <PageContent tab={activeTab} />
              </Suspense>
            </main>
          </SidebarInset>
        </SidebarProvider>
      </ErrorBoundary>
    </ToastProvider>
  )
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppShell />
    </QueryClientProvider>
  )
}

export default App
