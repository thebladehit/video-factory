import { createFileRoute } from '@tanstack/react-router';
import { VoiceList } from '@/components/voice/VoiceList';

export const Route = createFileRoute('/voice/')({ component: VoiceList });
