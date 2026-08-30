import { createLazyFileRoute } from '@tanstack/react-router';
import { AppearanceSettings } from '@/components/settings/AppearanceSettings';

export const Route = createLazyFileRoute('/_authenticated/settings/appearance')({
  component: AppearanceSettings,
});
