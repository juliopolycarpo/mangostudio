import { createLazyFileRoute } from '@tanstack/react-router';
import { MachinePage } from '@/features/environments/machine/components/MachinePage';

export const Route = createLazyFileRoute('/_authenticated/environments/machine')({
  component: MachinePage,
});
