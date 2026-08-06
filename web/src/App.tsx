import { useState } from "react"
import {
  LayoutDashboard,
  RefreshCw,
} from "lucide-react"
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { AppSidebar } from "@/components/AppSidebar"
import { Overview } from "@/components/Overview"

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

// ── Placeholder page ───────────────────────────────────────────────────

function PlaceholderPage({ tab }: { tab: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-64 gap-3">
      <div className="p-3 rounded-xl bg-slate-800/50">
        <LayoutDashboard className="h-8 w-8 text-slate-600" />
      </div>
      <p className="text-sm text-slate-500">
        {tabTitles[tab] ?? tab} — coming soon
      </p>
    </div>
  )
}

// ── App ────────────────────────────────────────────────────────────────

function App() {
  const [activeTab, setActiveTab] = useState("overview")

  return (
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
              onClick={() => window.location.reload()}
              className="p-1.5 rounded-md text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-colors"
              title="Refresh"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 p-4 lg:p-6 bg-slate-950">
          {activeTab === "overview" ? (
            <Overview />
          ) : (
            <PlaceholderPage tab={activeTab} />
          )}
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}

export default App
