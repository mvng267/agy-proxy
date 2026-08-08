import { useState, useEffect, lazy, Suspense } from "react"
import { QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query"
import { queryClient } from "@/lib/queryClient"
import { api } from "@/lib/api"
import {
  RefreshCw,
  BookOpen,
  ExternalLink,
  ChevronDown,
  CircleUser,
  Settings,
  LogOut,
} from "lucide-react"
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { AppSidebar, handleLogout } from "@/components/AppSidebar"
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
const Metrics = lazy(() => import("@/components/pages/Metrics").then((m) => ({ default: m.Metrics })))
const Chat = lazy(() => import("@/components/pages/Chat").then((m) => ({ default: m.Chat })))
const LiveLog = lazy(() => import("@/components/pages/LiveLog").then((m) => ({ default: m.LiveLog })))
const ApiKeys = lazy(() => import("@/components/pages/ApiKeys").then((m) => ({ default: m.ApiKeys })))
const Scheduler = lazy(() => import("@/components/pages/Scheduler").then((m) => ({ default: m.Scheduler })))
const Runs = lazy(() => import("@/components/pages/Runs").then((m) => ({ default: m.Runs })))
const PendingHuman = lazy(() => import("@/components/pages/PendingHuman").then((m) => ({ default: m.PendingHuman })))
const Omniroute = lazy(() => import("@/components/pages/Omniroute").then((m) => ({ default: m.Omniroute })))
const Security = lazy(() => import("@/components/pages/Security").then((m) => ({ default: m.Security })))

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
  metrics: "Metrics",
  chat: "Chat thử",
  gwlog: "Live Log",
  tools: "Cấu hình",
  settings: "Cấu hình",
  keys: "API Keys",
  scheduler: "Scheduler",
  runs: "Runs",
  pending: "Chờ duyệt",
  omniroute: "OmniRoute",
  security: "Bảo mật",
}

const REPO_URL = "https://github.com/mvng267/agy-proxy"

// ── Page router ────────────────────────────────────────────────────────

function PageContent({ tab }: { tab: string }) {
  switch (tab) {
    case "overview":
      return <Overview />
    // Tab cũ (tokens/add) trỏ vào hub — link đã lưu của người dùng vẫn mở được,
    // và mở ĐÚNG tab con thay vì rơi về tab đầu.
    case "accounts":
    case "tokens":
    case "add":
      return <AccountsHub initial={tab === "tokens" ? "tokens" : tab === "add" ? "add" : undefined} />
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
    case "metrics":
      return <Metrics />
    case "chat":
      return <Chat />
    case "gwlog":
      return <LiveLog />
    case "tools":
    case "connections":
    case "settings":
      return <SettingsHub initial={tab === "connections" ? "connections" : tab === "tools" ? "cli" : undefined} />
    case "keys":
      return <ApiKeys />
    case "scheduler":
      return <Scheduler />
    case "runs":
      return <Runs />
    case "pending":
      return <PendingHuman />
    case "omniroute":
      return <Omniroute />
    case "security":
      return <Security />
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

// ── Header widgets ─────────────────────────────────────────────────────

/**
 * Trạng thái server trên topbar: chấm xanh khi /api/health trả lời, đỏ khi mất
 * kết nối. Cổng lấy từ location — chính là cổng đang phục vụ dashboard.
 */
function ServerStatus() {
  const { isError, isPending } = useQuery({
    queryKey: ["health"],
    queryFn: () => api.get<{ status: string; uptime: number; version: string }>("/api/health"),
    refetchInterval: 30_000,
    retry: 1,
  })
  const port = window.location.port || (window.location.protocol === "https:" ? "443" : "80")
  const down = isError
  return (
    <div
      className={`flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs ${
        down
          ? "border-red-500/30 bg-red-500/10 text-red-400"
          : "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
      }`}
      title={down ? "Không gọi được /api/health" : `Server OK — cổng ${port}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${down ? "bg-red-400" : "bg-emerald-400"}`} />
      <span className="hidden sm:inline">{isPending ? "Đang kiểm tra…" : down ? "Mất kết nối" : "Đang chạy"}</span>
      <span className="font-mono text-[11px] opacity-70">:{port}</span>
    </div>
  )
}

/** Menu người dùng: tên đăng nhập từ /api/auth/me + lối tắt Cấu hình / Đăng xuất. */
function UserMenu({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { data } = useQuery({
    queryKey: ["auth-me"],
    queryFn: () => api.get<{ ok: boolean; user: string }>("/api/auth/me"),
    staleTime: 5 * 60_000,
  })
  const user = data?.user ?? "admin"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-slate-300 transition-colors hover:bg-slate-800 hover:text-slate-100">
        <CircleUser className="h-4 w-4 text-slate-400" />
        <span className="hidden max-w-28 truncate md:inline">{user}</span>
        <ChevronDown className="h-3 w-3 text-slate-500" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {/* GroupLabel của Base UI bắt buộc nằm trong Group — thiếu là crash khi mở menu */}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex items-center gap-2">
            <CircleUser className="h-4 w-4" />
            <span className="truncate">{user}</span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onOpenSettings}>
          <Settings className="h-4 w-4" />
          Cấu hình
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onClick={handleLogout}>
          <LogOut className="h-4 w-4" />
          Đăng xuất
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
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
  // Cùng queryKey với ServerStatus — react-query dedupe, không thêm request nào.
  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: () => api.get<{ status: string; accounts?: number; poolSize?: number }>("/api/health"),
    refetchInterval: 30_000,
    retry: 1,
  })

  return (
    <ToastProvider>
      <ErrorBoundary>
        <SidebarProvider>
          <AppSidebar
            activeTab={activeTab}
            onTabChange={setActiveTab}
            accountCount={health?.accounts}
            poolCount={health?.poolSize}
          />
          <SidebarInset>
            {/* Topbar — h-14, px-4/lg:px-6: footer dùng đúng cặp số này để hai thanh cân nhau */}
            <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-slate-800 bg-slate-950/80 px-4 backdrop-blur-sm lg:px-6">
              <SidebarTrigger className="-ml-1 text-slate-400 hover:text-slate-200" />
              <Separator orientation="vertical" className="h-5 bg-slate-800" />
              {/* Logo + tên app: sidebar mobile là offcanvas nên topbar phải tự nhận diện app */}
              <button
                onClick={() => setActiveTab("overview")}
                className="flex shrink-0 items-center gap-2"
                title="Về Dashboard"
              >
                <span className="flex h-6 w-6 items-center justify-center rounded-md bg-orange-500 text-xs font-bold text-white">
                  A
                </span>
                <span className="hidden text-sm font-semibold text-slate-100 sm:inline">agyproxy</span>
              </button>
              <span className="text-slate-700">/</span>
              <h1 className="truncate text-sm font-medium text-slate-300">
                {tabTitles[activeTab] ?? activeTab}
              </h1>
              <div className="ml-auto flex items-center gap-2">
                <ServerStatus />
                <button
                  onClick={() => qc.invalidateQueries()}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-300"
                  title="Làm mới dữ liệu"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
                <Separator orientation="vertical" className="h-5 bg-slate-800" />
                <UserMenu onOpenSettings={() => setActiveTab("settings")} />
              </div>
            </header>

            {/* Content */}
            <main className="flex-1 bg-slate-950 p-4 lg:p-6">
              <Suspense fallback={<div className="flex h-64 items-center justify-center text-sm text-slate-500">Đang tải…</div>}>
                <PageContent tab={activeTab} />
              </Suspense>
            </main>

            {/* Footer — cùng chiều cao/padding với topbar để khung trên–dưới đối xứng */}
            <footer className="flex h-14 shrink-0 items-center justify-between gap-3 border-t border-slate-800 bg-slate-950 px-4 lg:px-6">
              <p className="flex min-w-0 items-center gap-2 text-xs text-slate-500">
                <span className="truncate">© 2026 agyproxy</span>
                <span className="hidden sm:inline text-slate-700">·</span>
                <span className="hidden font-mono sm:inline">v{__APP_VERSION__}</span>
              </p>
              <nav className="flex items-center gap-1">
                <a
                  href={`${REPO_URL}#readme`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-300"
                >
                  <BookOpen className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Tài liệu</span>
                </a>
                <a
                  href={REPO_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-300"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">GitHub</span>
                </a>
              </nav>
            </footer>
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
