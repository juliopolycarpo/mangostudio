import { createLazyFileRoute } from '@tanstack/react-router';
import { ProviderSettingsPage } from '@/features/settings/providers';

export const Route = createLazyFileRoute('/_authenticated/settings/providers/$provider')({
  component: ProviderSettingsPage,
});
