import { Link, Outlet, useLocation } from 'react-router';
import { canAccess, type Feature } from '@delivery/shared';
import {
  Archive, Camera, FileText, LogOut, MessageSquareWarning, Mic, MonitorPlay, MonitorUp, SlidersHorizontal, Users, Video,
  type LucideIcon,
} from 'lucide-react';
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader,
  SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger, useSidebar,
} from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useAuth } from '@/features/auth/auth-context';
import { ChatProvider } from '@/features/viewer/ChatProvider';
import { ROLE_LABELS } from './roles';

type NavItem = { to: string; label: string; icon: LucideIcon; feature: Feature };

export const USER_NAV: readonly NavItem[] = [
  { to: '/watch', label: '配信視聴', icon: Video, feature: 'watch' },
  { to: '/slides', label: 'スライド', icon: FileText, feature: 'watch' },
  { to: '/archives', label: 'アーカイブ', icon: Archive, feature: 'archives' },
  { to: '/send/camera', label: 'カメラ送信', icon: Camera, feature: 'cameraSend' },
  { to: '/send/mic', label: 'マイク送信', icon: Mic, feature: 'micSend' },
  { to: '/venue/mic', label: '会場音声 PoC（マイク）', icon: Mic, feature: 'venueSpeaker' },
  { to: '/venue/speaker', label: '会場音声 PoC（スピーカー）', icon: MonitorPlay, feature: 'venueSpeaker' },
  { to: '/send/slide', label: 'スライド共有', icon: MonitorUp, feature: 'slideShare' },
];

export const ADMIN_NAV: readonly NavItem[] = [
  { to: '/admin/switcher', label: 'スイッチング', icon: SlidersHorizontal, feature: 'switcher' },
  { to: '/admin/slides', label: 'スライド管理', icon: MonitorPlay, feature: 'slideManage' },
  { to: '/admin/comments', label: 'コメント管理', icon: MessageSquareWarning, feature: 'commentModeration' },
  { to: '/admin/users', label: 'ユーザー管理', icon: Users, feature: 'userManage' },
];

function NavGroup({ label, items }: { label: string; items: readonly NavItem[] }) {
  const { pathname } = useLocation();
  const { setOpenMobile } = useSidebar();
  if (items.length === 0) return null;
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map(({ to, label: text, icon: Icon }) => (
            <SidebarMenuItem key={to}>
              <SidebarMenuButton asChild size="lg" isActive={pathname === to || pathname.startsWith(`${to}/`)}>
                <Link to={to} onClick={() => setOpenMobile(false)}><Icon aria-hidden /><span>{text}</span></Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

/** ユーザー画面の共通レイアウト。管理者には管理メニューを追加する。スマホではシートで開く。 */
export function AppLayout() {
  const { me, logout } = useAuth();
  if (!me) return null;
  const userItems = USER_NAV.filter((item) => canAccess(me.role, item.feature));
  const adminItems = ADMIN_NAV.filter((item) => canAccess(me.role, item.feature));
  return (
    <ChatProvider>
      <SidebarProvider>
        <Sidebar aria-label="メインメニュー">
          <SidebarHeader className="px-4 py-3">
            <span className="text-base font-semibold">ライブ配信</span>
          </SidebarHeader>
          <SidebarContent>
            <NavGroup label="メニュー" items={userItems} />
            <NavGroup label="管理" items={adminItems} />
          </SidebarContent>
          <SidebarFooter className="gap-2 p-3">
            <div className="px-1 text-sm">
              <p className="font-medium break-all">{me.displayName}</p>
              <p className="text-muted-foreground">{ROLE_LABELS[me.role]}</p>
            </div>
            <Button variant="outline" className="min-h-11 justify-start" onClick={() => { void logout(); }}>
              <LogOut aria-hidden />ログアウト
            </Button>
          </SidebarFooter>
        </Sidebar>
        <SidebarInset>
          <header className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur md:hidden">
            <SidebarTrigger className="size-11" aria-label="メニューを開く" />
            <Separator orientation="vertical" className="h-5" />
            <span className="font-semibold">ライブ配信</span>
          </header>
          <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-8 md:py-8">
            <Outlet />
          </div>
        </SidebarInset>
      </SidebarProvider>
    </ChatProvider>
  );
}
