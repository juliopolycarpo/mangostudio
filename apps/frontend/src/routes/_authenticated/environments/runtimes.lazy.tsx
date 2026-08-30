import { createLazyFileRoute } from '@tanstack/react-router';
import { RuntimesPage } from '@/features/environments/components/RuntimesPage';

export const Route = createLazyFileRoute('/_authenticated/environments/runtimes')({
  component: RuntimesPage,
});
