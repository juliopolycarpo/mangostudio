import { createLazyFileRoute } from '@tanstack/react-router';
import { SettingsComparison } from '@/features/library/components/SettingsComparison';

export const Route = createLazyFileRoute('/_authenticated/environments/library/settings')({
  component: SettingsComparison,
});
