import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/library/subagents')({
  beforeLoad: () => {
    redirect({ to: '/environments/library/subagents', throw: true });
  },
});
