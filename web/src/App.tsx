import { useState } from "react"
import { RefreshCw } from "lucide-react"
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { AppSidebar } from "@/components/AppSidebar"
import { Overview } from "@/components/Overview"

// ── Pages ──────────────────────────────────────────────────────────────
import { Accounts } from "@/components/pages/Accounts"
import { Pool } from "@/components/pages/Pool"
import { Models } from "@/components/pages/Models"
import { Combo } from "@/components/pages/Combo"
import { Tokens } from "@/components/pages/Tokens"
import { Proxy } from "@/components/pages/Proxy"
import { AddAccount } from "@/components/pages/AddAccount"
import { Quota } from "@/components/pages/Quota"
import { Connections } from "@/components/pages/Connections"
import { Usage } from "@/components/pages/Usage"
import { Chat } from "@/components/pages/Chat"
import { LiveLog } from "@/components/pages/LiveLog"
import { CLITools } from "@/components/pages/CLITools"
import { Settings } from "@/components/pages/Settings"

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
          <PageContent tab={activeTab} />
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}

export default App
