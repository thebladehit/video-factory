import { createFileRoute, Outlet } from '@tanstack/react-router';

// батьківський маршрут: список — `voice.index`, студія — `voice.$id`
export const Route = createFileRoute('/voice')({ component: Outlet });
