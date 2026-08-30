import { createLazyFileRoute } from '@tanstack/react-router';
import { AgentsPage } from '@/features/environments/components/AgentsPage';

export const Route = createLazyFileRoute('/_authenticated/environments/agents')({
  component: AgentsPage,
});
