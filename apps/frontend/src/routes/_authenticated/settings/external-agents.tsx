import { createFileRoute } from '@tanstack/react-router';
import { ExternalAgentSettingsPage } from '@/features/settings/external-agents';

export const Route = createFileRoute('/_authenticated/settings/external-agents')({
  component: ExternalAgentSettingsPage,
});
