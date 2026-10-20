import { createFileRoute } from '@tanstack/react-router';
import { AutoTagToggle } from '@/components/settings/AutoTagToggle';
import { ChannelStyle } from '@/components/settings/ChannelStyle';
import { DebugJobCard } from '@/components/settings/DebugJobCard';
import { HealthCard } from '@/components/settings/HealthCard';
import { ModelDefaults } from '@/components/settings/ModelDefaults';

export const Route = createFileRoute('/settings')({
  component: () => (
    <div className="mx-auto grid max-w-3xl gap-6">
      <h1 className="text-2xl font-semibold">Налаштування</h1>
      <HealthCard />
      <ModelDefaults />
      <AutoTagToggle />
      <ChannelStyle />
      <DebugJobCard />
    </div>
  ),
});
