import { createLazyFileRoute } from '@tanstack/react-router';
import { MetricsSettingsPage } from '@/features/settings/observability';

export const Route = createLazyFileRoute('/_authenticated/settings/metrics')({
  component: MetricsSettingsPage,
});
