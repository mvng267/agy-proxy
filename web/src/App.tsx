import { useState, useEffect, lazy, Suspense } from "react"
import { initTheme } from "@/lib/theme"
import { QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query"
import { queryClient } from "@/lib/queryClient"
import { api } from "@/lib/api"
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
const Metrics = lazy(() => import("@/components/pages/Metrics").then((m) => ({ default: m.Metrics })))
const PlaygroundHub = lazy(() => import("@/components/pages/PlaygroundHub").then((m) => ({ default: m.PlaygroundHub })))
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
  chat: "Playground",
  playground: "Playground",
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
    case "playground":
      // `chat` là link cũ (sidebar, bookmark) — vẫn vào được, mở sẵn tab Chat thử.
      return <PlaygroundHub initial={tab === "chat" ? "chat" : undefined} />
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
          <p className="text-sm text-muted-foreground">
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
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-success/30 bg-success/10 text-success"
      }`}
      title={down ? "Không gọi được /api/health" : `Server OK — cổng ${port}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${down ? "bg-destructive" : "bg-success"}`} />
      <span className="hidden sm:inline">{isPending ? "Đang kiểm tra…" : down ? "Mất kết nối" : "Đang chạy"}</span>
      <span className="font-mono text-[11px] opacity-70">:{port}</span>
    </div>
  )
}

/** Menu người dùng: tên đăng nhập từ /api/auth/me + lối tắt Cấu hình / Đăng xuất. */

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
  // Áp theme SỚM và theo dõi thay đổi của hệ điều hành khi đang ở chế độ "theo máy".
  useEffect(() => initTheme(), [])

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
            {/*
              Header và nội dung dùng CHUNG một khuôn căn giữa:
                  mx-auto w-full max-w-(--container-app) px-6

              Đây là điều kiện để hai tầng thẳng hàng, và trước đây chính là chỗ sai. Header
              cũ căn theo mép trái (`px-4 lg:px-6`) còn nội dung căn GIỮA trong hộp 80rem, nên
              màn càng rộng hai bên càng lệch: đo ở 1920px thì header ở left=272 mà nội dung ở
              left=448 — thụt 176px. Atlas đo được left=448 cho CẢ HAI.

              Hệ quả: `px-6` phải là số CỐ ĐỊNH ở cả hai chỗ. Dùng cặp responsive khác nhau
              (`p-4 lg:p-6` cho một bên) là cách chắc chắn để chúng lại lệch nhau.

              Header cũng KHÔNG sticky, không viền dưới, không nền mờ — Atlas để nó cuộn đi
              cùng nội dung. Bỏ luôn `<footer>`: Atlas không có, và bản cũ chỉ chứa link
              GitHub/Tài liệu — đã chuyển xuống menu người dùng ở đáy sidebar.
            */}
            <header className="flex h-16 shrink-0 items-center pt-[env(safe-area-inset-top)]">
              <div className="mx-auto flex w-full min-w-0 max-w-(--container-app) items-center justify-between gap-2 px-6">
                <div className="flex min-w-0 items-center gap-2">
                  <SidebarTrigger className="-ml-1.5 shrink-0 text-muted-foreground hover:text-foreground" />
                  <Separator orientation="vertical" className="mr-1 h-4 bg-border" />
                  <h1 className="truncate text-sm font-medium text-foreground">
                    {tabTitles[activeTab] ?? activeTab}
                  </h1>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <ServerStatus />
                  <button
                    onClick={() => qc.invalidateQueries()}
                    className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    title="Làm mới dữ liệu"
                  >
                    <RefreshCw className="size-3.5" />
                  </button>
                </div>
              </div>
            </header>

            {/*
              Hộp giới hạn bề rộng phải là thẻ TRONG `<main>`, không phải chính `<main>`.
              `SidebarInset` là flex-column, mà flex mặc định `align-items: stretch` — nó kéo
              con ra hết bề ngang và `mx-auto` không thắng được: đo ra `main.left=256`,
              `width=1920`, tức `max-w` bị vô hiệu hoàn toàn. Atlas cũng dựng đúng hai tầng
              như thế này.

              `@container` để trang dùng được @3xl:/@6xl: thay cho media query, đúng cách Atlas
              dựng grid KPI. `pt-0`: khoảng cách phía trên đã do header h-16 lo.
            */}
            <main className="flex min-w-0 flex-1 flex-col">
              <div className="@container mx-auto w-full min-w-0 max-w-(--container-app) flex-1 px-6 pt-0 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
                <Suspense fallback={<div className="flex h-64 items-center justify-center text-sm text-muted-foreground">Đang tải…</div>}>
                  <PageContent tab={activeTab} />
                </Suspense>
              </div>
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
