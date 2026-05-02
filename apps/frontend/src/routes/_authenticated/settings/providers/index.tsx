import { createFileRoute } from '@tanstack/react-router';
import { ProviderSettingsMenu } from '@/features/settings/providers';

export const Route = createFileRoute('/_authenticated/settings/providers/')({
  component: ProviderSettingsMenu,
});
