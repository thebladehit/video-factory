import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { BarChart3, Clapperboard, Images, Mic, Send, Settings } from 'lucide-react';
import { useTRPC } from '@/lib/trpc';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
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

/** Кількість ручних публікацій, що чекають на користувача; 0 — бейдж прихований */
function PendingBadge() {
  const trpc = useTRPC();
  const count = useQuery({ ...trpc.publish.pendingCount.queryOptions(), refetchInterval: 60_000 });
  if (!count.data) return null;
  return (
    <SidebarMenuBadge
      data-testid="pending-badge"
      aria-label={`Чекають на вас: ${count.data}`}
      className="bg-primary text-primary-foreground peer-hover/menu-button:text-primary-foreground peer-data-[active=true]/menu-button:text-primary-foreground"
    >
      {count.data}
    </SidebarMenuBadge>
  );
}

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
                  {to === '/publications' && <PendingBadge />}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </nav>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
