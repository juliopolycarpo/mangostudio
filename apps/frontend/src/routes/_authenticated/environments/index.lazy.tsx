import { createLazyFileRoute } from '@tanstack/react-router';
import { OverviewPage } from '@/features/environments/components/OverviewPage';

export const Route = createLazyFileRoute('/_authenticated/environments/')({
  component: OverviewPage,
});
