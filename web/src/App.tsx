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
const Accounts = lazy(() => import("@/components/pages/Accounts").then((m) => ({ default: m.Accounts })))
const Pool = lazy(() => import("@/components/pages/Pool").then((m) => ({ default: m.Pool })))
const Models = lazy(() => import("@/components/pages/Models").then((m) => ({ default: m.Models })))
const Combo = lazy(() => import("@/components/pages/Combo").then((m) => ({ default: m.Combo })))
const Tokens = lazy(() => import("@/components/pages/Tokens").then((m) => ({ default: m.Tokens })))
const Proxy = lazy(() => import("@/components/pages/Proxy").then((m) => ({ default: m.Proxy })))
const AddAccount = lazy(() => import("@/components/pages/AddAccount").then((m) => ({ default: m.AddAccount })))
const Quota = lazy(() => import("@/components/pages/Quota").then((m) => ({ default: m.Quota })))
const Connections = lazy(() => import("@/components/pages/Connections").then((m) => ({ default: m.Connections })))
const Usage = lazy(() => import("@/components/pages/Usage").then((m) => ({ default: m.Usage })))
const Chat = lazy(() => import("@/components/pages/Chat").then((m) => ({ default: m.Chat })))
const LiveLog = lazy(() => import("@/components/pages/LiveLog").then((m) => ({ default: m.LiveLog })))
const CLITools = lazy(() => import("@/components/pages/CLITools").then((m) => ({ default: m.CLITools })))
const Settings = lazy(() => import("@/components/pages/Settings").then((m) => ({ default: m.Settings })))

// ── Page title mapping ─────────────────────────────────────────────────

const tabTitles: Record<string, string> = {
  overview: "Dashboard",
  accounts: "Accounts",
  tokens: "Tokens",
  proxies: "Proxy",
  add: "Thêm tài khoản",
  agy: "Pool",
  models: "Models",
  combo: "Combo",
  quota: "Hạn mức",
  connections: "Connections",
  usage: "Báo cáo",
  chat: "Chat thử",
  gwlog: "Live Log",
  tools: "CLI Tools",
  settings: "Cấu hình",
}

// ── Page router ────────────────────────────────────────────────────────

function PageContent({ tab }: { tab: string }) {
  switch (tab) {
    case "overview":
      return <Overview />
    case "accounts":
      return <Accounts />
    case "agy":
      return <Pool />
    case "models":
      return <Models />
    case "combo":
      return <Combo />
    case "tokens":
      return <Tokens />
    case "proxies":
      return <Proxy />
    case "add":
      return <AddAccount />
    case "quota":
      return <Quota />
    case "connections":
      return <Connections />
    case "usage":
      return <Usage />
    case "chat":
      return <Chat />
    case "gwlog":
      return <LiveLog />
    case "tools":
      return <CLITools />
    case "settings":
      return <Settings />
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
