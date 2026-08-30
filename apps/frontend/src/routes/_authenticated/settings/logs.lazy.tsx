import { createLazyFileRoute } from '@tanstack/react-router';
import { LogsSettingsPage } from '@/features/settings/observability';

export const Route = createLazyFileRoute('/_authenticated/settings/logs')({
  component: LogsSettingsPage,
});
