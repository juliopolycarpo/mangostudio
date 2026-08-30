import { createLazyFileRoute } from '@tanstack/react-router';
import { ExternalAgentSettingsPage } from '@/features/settings/external-agents';

export const Route = createLazyFileRoute('/_authenticated/settings/external-agents')({
  component: ExternalAgentSettingsPage,
});
