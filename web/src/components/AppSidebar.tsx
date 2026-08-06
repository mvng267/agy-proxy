import {
  LayoutDashboard,
  Users,
  KeyRound,
  Globe,
  UserPlus,
  Zap,
  Cpu,
  Shuffle,
  Gauge,
  BarChart3,
  MessageSquare,
  ScrollText,
  Terminal,
  Settings,
  Link,
  LogOut,
  RefreshCw,
} from "lucide-react"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@/components/ui/sidebar"

const navGroups = [
  {
    label: "Tổng quan",
    items: [
      { title: "Dashboard", icon: LayoutDashboard, tab: "overview", badge: null },
    ],
  },
  {
    label: "Tài khoản",
    items: [
      { title: "Accounts", icon: Users, tab: "accounts", badge: null },
      { title: "Tokens", icon: KeyRound, tab: "tokens", badge: null },
      { title: "Proxy", icon: Globe, tab: "proxies", badge: null },
      { title: "Thêm TK", icon: UserPlus, tab: "add", badge: null },
    ],
  },
  {
    label: "Gateway",
    items: [
      { title: "Pool", icon: Zap, tab: "agy", badge: null },
      { title: "Models", icon: Cpu, tab: "models", badge: null },
      { title: "Combo", icon: Shuffle, tab: "combo", badge: null },
      { title: "Hạn mức", icon: Gauge, tab: "quota", badge: null },
      { title: "Connections", icon: Link, tab: "connections", badge: null },
    ],
  },
  {
    label: "Công cụ",
    items: [
      { title: "Báo cáo", icon: BarChart3, tab: "usage", badge: null },
      { title: "Chat thử", icon: MessageSquare, tab: "chat", badge: null },
      { title: "Live Log", icon: ScrollText, tab: "gwlog", badge: null },
      { title: "CLI Tools", icon: Terminal, tab: "tools", badge: null },
    ],
  },
  {
    label: "Hệ thống",
    items: [
      { title: "Cấu hình", icon: Settings, tab: "settings", badge: null },
    ],
  },
]

interface AppSidebarProps {
  activeTab: string
  onTabChange: (tab: string) => void
  accountCount?: number
  poolCount?: number
}

export function AppSidebar({ activeTab, onTabChange, accountCount, poolCount }: AppSidebarProps) {
  return (
    <Sidebar collapsible="icon" className="border-r border-slate-800">
      <SidebarHeader className="px-3 py-4">
        <div className="flex items-center gap-2.5 group-data-[collapsible=icon]:justify-center">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-orange-500 text-white font-bold text-sm">
            A
          </div>
          <div className="flex flex-col group-data-[collapsible=icon]:hidden">
            <span className="text-sm font-semibold text-slate-100">agyproxy</span>
            <span className="text-xs text-slate-500">v2.14.0</span>
          </div>
        </div>
      </SidebarHeader>

      <SidebarSeparator className="bg-slate-800" />

      <SidebarContent>
        {navGroups.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel className="text-slate-500 uppercase text-[10px] tracking-wider font-semibold">
              {group.label}
            </SidebarGroupLabel>
            <SidebarMenu>
              {group.items.map((item) => {
                const isActive = activeTab === item.tab
                return (
                  <SidebarMenuItem key={item.tab}>
                    <SidebarMenuButton
                      isActive={isActive}
                      tooltip={item.title}
                      onClick={() => onTabChange(item.tab)}
                      className={
                        isActive
                          ? "bg-orange-500/10 text-orange-400 hover:bg-orange-500/15 hover:text-orange-400"
                          : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50"
                      }
                    >
                      <item.icon className={isActive ? "text-orange-500" : ""} />
                      <span>{item.title}</span>
                    </SidebarMenuButton>
                    {item.tab === "accounts" && accountCount != null && (
                      <SidebarMenuBadge className="bg-slate-700 text-slate-300 text-[10px] px-1.5 rounded">
                        {accountCount}
                      </SidebarMenuBadge>
                    )}
                    {item.tab === "agy" && poolCount != null && (
                      <SidebarMenuBadge className="bg-orange-500/20 text-orange-400 text-[10px] px-1.5 rounded">
                        {poolCount}
                      </SidebarMenuBadge>
                    )}
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarSeparator className="bg-slate-800" />

      <SidebarFooter className="px-3 py-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Làm mới"
              onClick={() => window.location.reload()}
              className="text-slate-400 hover:text-slate-200 hover:bg-slate-800/50"
            >
              <RefreshCw />
              <span>Làm mới</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Đăng xuất"
              className="text-slate-400 hover:text-red-400 hover:bg-red-500/10"
            >
              <LogOut />
              <span>Đăng xuất</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
