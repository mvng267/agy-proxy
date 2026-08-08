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
  MoreHorizontal,
  Sun,
  Moon,
  MonitorSmartphone,
  Check,
  BookOpen,
  ExternalLink,
} from "lucide-react"

const REPO_URL = "https://github.com/mvng267/agy-proxy"
import { api } from "@/lib/api"
import { getTheme, setTheme, type Theme } from "@/lib/theme"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
  const [theme, setThemeState] = useState<Theme>(getTheme)
  const { data: me } = useQuery({
    queryKey: ["auth-me"],
    queryFn: () => api.get<{ ok: boolean; user: string }>("/api/auth/me"),
    staleTime: 5 * 60_000,
  })
  const user = me?.user || "admin"

  const { data: pendingData } = useQuery({
    queryKey: ["pending-human"],
    queryFn: () => api.get<{ pending: unknown[] }>("/api/pending-human"),
    refetchInterval: POLL.live,
    retry: 1,
  })
  const pendingCount = pendingData?.pending?.length ?? 0

  return (
    <Sidebar collapsible="icon" className="border-r border-border">
      {/* Atlas: header cao 52px, padding 8px, logo 14px/600 — không có dòng version phụ và
          không có đường kẻ ngăn dưới. Bản cũ dùng px-3 py-4 nên cao 68px, lệch hẳn so với
          header nội dung (h-16) bên phải. */}
      <SidebarHeader className="p-2">
        <div className="flex h-9 items-center gap-2 px-1 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
            A
          </div>
          <span className="truncate text-sm font-semibold text-foreground group-data-[collapsible=icon]:hidden">
            agyproxy
          </span>
        </div>
      </SidebarHeader>

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
            {/* Atlas: 12px / 500 / thường — KHÔNG uppercase, KHÔNG letter-spacing.
                Kiểu nhãn viết hoa nhỏ li ti là của template khác. */}
            <SidebarGroupLabel className="h-8 text-xs font-medium text-muted-foreground">
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
                      /* Không tự vẽ trạng thái active nữa — `ui/sidebar.tsx` đã có
                         `data-[active=true]:bg-sidebar-accent`. Tự viết class là thêm một
                         chỗ nữa có thể lệch với phần còn lại. */
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <item.icon />
                      <span>{item.title}</span>
                    </SidebarMenuButton>
                    {item.tab === "accounts" && accountCount != null && (
                      <SidebarMenuBadge className="bg-muted text-foreground text-[10px] px-1.5 rounded">
                        {accountCount}
                      </SidebarMenuBadge>
                    )}
                    {item.tab === "pending" && pendingCount > 0 && (
                      <SidebarMenuBadge className="bg-warning/15 text-warning text-[10px] px-1.5 rounded">
                        {pendingCount}
                      </SidebarMenuBadge>
                    )}
                    {item.tab === "agy" && poolCount != null && (
                      <SidebarMenuBadge className="bg-primary/12 text-primary text-[10px] px-1.5 rounded">
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

      {/* Card người dùng kiểu Atlas: avatar + tên + menu "…". Không kẻ ngăn phía trên —
          Atlas để footer liền mạch với vùng nav.
          Menu này THAY cho UserMenu ở topbar VÀ cho footer cũ của trang: hai chỗ cùng đổi
          theme / đăng xuất thì người dùng phải nhớ hai nơi cho một việc. */}
      <SidebarFooter className="p-2 pb-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton
                    size="lg"
                    tooltip={user}
                    className="data-[state=open]:bg-sidebar-accent"
                  >
                    <Avatar className="size-7 rounded-md">
                      <AvatarFallback className="rounded-md bg-primary text-[11px] font-semibold text-primary-foreground">
                        {user.slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <span className="flex-1 truncate text-left text-sm font-medium">{user}</span>
                    <MoreHorizontal className="size-4 shrink-0 text-muted-foreground" />
                  </SidebarMenuButton>
                }
              />
              <DropdownMenuContent side="top" align="start" className="min-w-52">
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="text-xs text-muted-foreground">Giao diện</DropdownMenuLabel>
                </DropdownMenuGroup>
                {([
                  { v: "light", label: "Sáng", Icon: Sun },
                  { v: "dark", label: "Tối", Icon: Moon },
                  { v: "system", label: "Theo máy", Icon: MonitorSmartphone },
                ] as const).map(({ v, label, Icon }) => (
                  <DropdownMenuItem
                    key={v}
                    onClick={() => { setTheme(v); setThemeState(v) }}
                    className={theme === v ? "text-primary" : ""}
                  >
                    <Icon className="h-4 w-4" />
                    {label}
                    {theme === v ? <Check className="ml-auto h-3.5 w-3.5" /> : null}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onTabChange("settings")}>
                  <Settings className="h-4 w-4" />
                  Cấu hình
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => window.location.reload()}>
                  <RefreshCw className="h-4 w-4" />
                  Làm mới
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {/* Hai link này trước ở <footer> của trang. Atlas không có footer, nên chúng
                    về đây thay vì bị bỏ đi. */}
                <DropdownMenuItem
                  onClick={() => window.open(`${REPO_URL}#readme`, "_blank", "noreferrer")}
                >
                  <BookOpen className="h-4 w-4" />
                  Tài liệu
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => window.open(REPO_URL, "_blank", "noreferrer")}>
                  <ExternalLink className="h-4 w-4" />
                  GitHub
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                    v{__APP_VERSION__}
                  </span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={handleLogout}>
                  <LogOut className="h-4 w-4" />
                  Đăng xuất
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
