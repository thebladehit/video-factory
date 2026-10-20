import { Link } from '@tanstack/react-router';
import { BarChart3, Clapperboard, Images, Mic, Send, Settings } from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';

const ITEMS = [
  { to: '/', label: 'Проєкти', icon: Clapperboard },
  { to: '/library', label: 'Бібліотека', icon: Images },
  { to: '/voice', label: 'Студія озвучки', icon: Mic },
  { to: '/publications', label: 'Публікації', icon: Send },
  { to: '/analytics', label: 'Статистика', icon: BarChart3 },
  { to: '/settings', label: 'Налаштування', icon: Settings },
] as const;

export function AppSidebar() {
  return (
    <Sidebar>
      <SidebarHeader className="px-4 py-3 text-base font-semibold">🎬 Фабрика відео</SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <nav aria-label="Розділи">
            <SidebarMenu>
              {ITEMS.map(({ to, label, icon: Icon }) => (
                <SidebarMenuItem key={to}>
                  <SidebarMenuButton asChild>
                    <Link to={to} activeOptions={{ exact: to === '/' }} activeProps={{ 'data-active': true }}>
                      <Icon aria-hidden />
                      <span>{label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </nav>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
