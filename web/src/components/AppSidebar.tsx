import { useEffect, useRef, useState } from "react"
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

/**
 * 4 nhóm cho 18 mục.
 *
 * Trước đây 6 nhóm: mỗi nhãn nhóm tốn ~28px nên riêng tiêu đề đã ăn 168px chiều cao.
 * Đo trên cửa sổ 900px: vùng nav chỉ cao 742px mà nội dung 864px → tràn 122px, mục
 * "Bảo mật" rơi xuống y=925 trong khi footer bắt đầu ở 812 nên bị che khuất hẳn.
 * Có cuộn được nhưng không có dấu hiệu gì báo còn nội dung → trông như bị cắt cụt.
 *
 * Gom theo CÂU HỎI người dùng đang có, không theo tên module:
 *   Tài khoản  — "tôi có những account nào, mạng ra sao"
 *   Gateway    — "gọi model thế nào, còn bao nhiêu hạn mức"
 *   Theo dõi   — "đang chạy gì, đã tiêu bao nhiêu, có lỗi không"
 *   Hệ thống   — "cấu hình, vận hành, bảo mật"
 */
const navGroups = [
  {
    label: "Tài khoản",
    items: [
      { title: "Dashboard", icon: LayoutDashboard, tab: "overview", badge: null },
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
      { title: "API Keys", icon: KeyRound, tab: "keys", badge: null },
    ],
  },
  {
    // Bốn góc nhìn cùng một câu hỏi "hệ thống đang chạy ra sao": số liệu tức thời,
    // số liệu tích luỹ, thử tay, và log thô.
    label: "Theo dõi",
    items: [
      { title: "Metrics", icon: Activity, tab: "metrics", badge: null },
      { title: "Báo cáo", icon: BarChart3, tab: "usage", badge: null },
      { title: "Chat thử", icon: MessageSquare, tab: "chat", badge: null },
      { title: "Live Log", icon: ScrollText, tab: "gwlog", badge: null },
    ],
  },
  {
    // Gộp "Vận hành" (pipeline login/warmup) vào đây: cả hai đều là việc quản trị,
    // không phải việc dùng gateway hằng ngày.
    label: "Hệ thống",
    items: [
      { title: "Cấu hình", icon: Settings, tab: "settings", badge: null },
      { title: "Scheduler", icon: CalendarClock, tab: "scheduler", badge: null },
      { title: "Runs", icon: History, tab: "runs", badge: null },
      { title: "Chờ duyệt", icon: UserCheck, tab: "pending", badge: null },
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
  // Chỉ mờ mép dưới khi vùng nav TRÀN và chưa cuộn tới đáy.
  const navRef = useRef<HTMLDivElement>(null)
  const [fade, setFade] = useState(false)
  const updateFade = () => {
    const el = navRef.current
    if (!el) return
    setFade(el.scrollHeight - el.clientHeight - el.scrollTop > 8)
  }
  useEffect(() => {
    updateFade()
    // Đổi kích thước cửa sổ có thể làm nav từ vừa đủ thành tràn và ngược lại.
    const ro = new ResizeObserver(updateFade)
    if (navRef.current) ro.observe(navRef.current)
    window.addEventListener("resize", updateFade)
    return () => { ro.disconnect(); window.removeEventListener("resize", updateFade) }
  }, [])

  // Số run chờ duyệt tay — hiện badge cạnh "Chờ duyệt" để không bỏ sót captcha đang treo.
  const { data: pendingData } = useQuery({
    queryKey: ["pending-human"],
    queryFn: () => api.get<{ pending: unknown[] }>("/api/pending-human"),
    refetchInterval: POLL.live,
    retry: 1,
  })
  const pendingCount = pendingData?.pending?.length ?? 0

  return (
    <Sidebar collapsible="icon" className="border-r border-border">
      <SidebarHeader className="px-3 py-4">
        <div className="flex items-center gap-2.5 group-data-[collapsible=icon]:justify-center">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-orange-500 text-white font-bold text-sm">
            A
          </div>
          <div className="flex flex-col group-data-[collapsible=icon]:hidden">
            <span className="text-sm font-semibold text-foreground">agyproxy</span>
            <span className="text-xs text-muted-foreground">v{__APP_VERSION__}</span>
          </div>
        </div>
      </SidebarHeader>

      <SidebarSeparator className="bg-muted" />

      {/* py-1 + gap-0: mặc định ReUI để py-2/gap-2 cho mỗi nhóm, cộng lại thừa 26px so
          với chỗ trống — đo trên cửa sổ 900px thì mục cuối "Bảo mật" rơi xuống y=829
          trong khi vùng nav kết thúc ở 811, tức bị khuất hẳn. */}
      {/* Màn thấp (<800px) thì 18 mục vẫn không vừa — cuộn là đúng, nhưng PHẢI có dấu
          hiệu còn nội dung, không có nó thì trông y như bị cắt cụt (chính lỗi đã báo).
          Mờ mép dưới CHỈ khi thật sự tràn và chưa cuộn hết — làm mờ vô điều kiện sẽ
          bôi xám mục cuối ngay cả lúc đã hiện đủ. */}
      <SidebarContent
        ref={navRef}
        onScroll={updateFade}
        className={`gap-0 py-1 ${fade ? "[mask-image:linear-gradient(to_bottom,black_calc(100%-28px),transparent)]" : ""}`}
      >
        {navGroups.map((group) => (
          <SidebarGroup key={group.label} className="py-1">
            <SidebarGroupLabel className="h-6 text-muted-foreground uppercase text-[10px] tracking-wider font-semibold">
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
                          : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                      }
                    >
                      <item.icon className={isActive ? "text-orange-500" : ""} />
                      <span>{item.title}</span>
                    </SidebarMenuButton>
                    {item.tab === "accounts" && accountCount != null && (
                      <SidebarMenuBadge className="bg-muted text-foreground text-[10px] px-1.5 rounded">
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

      <SidebarSeparator className="bg-muted" />

      <SidebarFooter className="px-3 py-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Làm mới"
              onClick={() => window.location.reload()}
              className="text-muted-foreground hover:text-foreground hover:bg-muted/50"
            >
              <RefreshCw />
              <span>Làm mới</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Đăng xuất"
              onClick={handleLogout}
              className="text-muted-foreground hover:text-red-400 hover:bg-red-500/10"
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
