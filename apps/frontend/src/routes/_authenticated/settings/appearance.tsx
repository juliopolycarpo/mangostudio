import { createFileRoute } from '@tanstack/react-router';
import { AppearanceSettings } from '@/components/settings/AppearanceSettings';

export const Route = createFileRoute('/_authenticated/settings/appearance')({
  component: AppearanceSettingsRoute,
});

function AppearanceSettingsRoute() {
  return <AppearanceSettings />;
}
