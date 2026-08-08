import { useQuery } from "@tanstack/react-query"
import {
  LayoutDashboard,
  Users,
  KeyRound,
  Globe,
  Zap,
  Cpu,
  Shuffle,
  Gauge,
  Activity,
  BarChart3,
  MessageSquare,
  ScrollText,
  Settings,
  LogOut,
  RefreshCw,
  CalendarClock,
  History,
  UserCheck,
  Route,
  ShieldCheck,
} from "lucide-react"
import { api } from "@/lib/api"
import { POLL } from "@/lib/queryClient"

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
    // Tokens và "Thêm TK" đã gộp thành tab bên trong trang Tài khoản — chúng nói về
    // cùng một tập account, tách ra bắt người dùng nhớ hai chỗ cho một thứ.
    label: "Tài khoản",
    items: [
      { title: "Tài khoản", icon: Users, tab: "accounts", badge: null },
      { title: "Proxy", icon: Globe, tab: "proxies", badge: null },
    ],
  },
  {
    label: "Gateway",
    items: [
      { title: "Pool", icon: Zap, tab: "agy", badge: null },
      { title: "Models", icon: Cpu, tab: "models", badge: null },
      { title: "Combo", icon: Shuffle, tab: "combo", badge: null },
      { title: "Hạn mức", icon: Gauge, tab: "quota", badge: null },
    ],
  },
  {
    label: "Công cụ",
    items: [
      { title: "API Keys", icon: KeyRound, tab: "keys", badge: null },
      { title: "Metrics", icon: Activity, tab: "metrics", badge: null },
      { title: "Báo cáo", icon: BarChart3, tab: "usage", badge: null },
      { title: "Chat thử", icon: MessageSquare, tab: "chat", badge: null },
      { title: "Live Log", icon: ScrollText, tab: "gwlog", badge: null },
    ],
  },
  {
    // Pipeline login/warmup: hàng đợi scheduler, lịch sử run, và run chờ duyệt tay.
    label: "Vận hành",
    items: [
      { title: "Scheduler", icon: CalendarClock, tab: "scheduler", badge: null },
      { title: "Runs", icon: History, tab: "runs", badge: null },
      { title: "Chờ duyệt", icon: UserCheck, tab: "pending", badge: null },
    ],
  },
  {
    label: "Hệ thống",
    items: [
      // Connections + CLI Tools nay la tab ben trong trang nay.
      { title: "Cấu hình", icon: Settings, tab: "settings", badge: null },
      { title: "OmniRoute", icon: Route, tab: "omniroute", badge: null },
      { title: "Bảo mật", icon: ShieldCheck, tab: "security", badge: null },
    ],
  },
]

interface AppSidebarProps {
  activeTab: string
  onTabChange: (tab: string) => void
  accountCount?: number
  poolCount?: number
}

/** Xoá phiên ở server rồi về trang đăng nhập. Dùng chung cho sidebar và user menu trên topbar. */
export async function handleLogout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' })
  } catch {
    /* mất mạng vẫn cho về /login — cookie phía server sẽ hết hạn */
  }
  window.location.href = '/login'
}

export function AppSidebar({ activeTab, onTabChange, accountCount, poolCount }: AppSidebarProps) {
  // Số run chờ duyệt tay — hiện badge cạnh "Chờ duyệt" để không bỏ sót captcha đang treo.
  const { data: pendingData } = useQuery({
    queryKey: ["pending-human"],
    queryFn: () => api.get<{ pending: unknown[] }>("/api/pending-human"),
    refetchInterval: POLL.live,
    retry: 1,
  })
  const pendingCount = pendingData?.pending?.length ?? 0

  return (
    <Sidebar collapsible="icon" className="border-r border-slate-800">
      <SidebarHeader className="px-3 py-4">
        <div className="flex items-center gap-2.5 group-data-[collapsible=icon]:justify-center">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-orange-500 text-white font-bold text-sm">
            A
          </div>
          <div className="flex flex-col group-data-[collapsible=icon]:hidden">
            <span className="text-sm font-semibold text-slate-100">agyproxy</span>
            <span className="text-xs text-slate-500">v{__APP_VERSION__}</span>
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
                    {item.tab === "pending" && pendingCount > 0 && (
                      <SidebarMenuBadge className="bg-amber-500/20 text-amber-400 text-[10px] px-1.5 rounded">
                        {pendingCount}
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
              onClick={handleLogout}
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
