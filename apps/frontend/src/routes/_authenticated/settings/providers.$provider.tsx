import { createFileRoute } from '@tanstack/react-router';
import { ProviderSettingsPage } from '@/features/settings/providers';

 
export const Route = createFileRoute('/_authenticated/settings/providers/$provider')({
  component: ProviderSettingsPage,
});
 
