import { createLazyFileRoute } from '@tanstack/react-router';
import { ProviderSettingsMenu } from '@/features/settings/providers';

export const Route = createLazyFileRoute('/_authenticated/settings/providers/')({
  component: ProviderSettingsMenu,
});
