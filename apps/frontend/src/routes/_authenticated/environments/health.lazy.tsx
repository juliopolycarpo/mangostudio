import { createLazyFileRoute } from '@tanstack/react-router';
import { HealthPage } from '@/features/environments/components/HealthPage';

export const Route = createLazyFileRoute('/_authenticated/environments/health')({
  component: HealthPage,
});
