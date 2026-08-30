import { createLazyFileRoute } from '@tanstack/react-router';
import { AgentSettingsPage } from '@/features/settings/agents';

export const Route = createLazyFileRoute('/_authenticated/settings/agents')({
  component: AgentSettingsPage,
});
