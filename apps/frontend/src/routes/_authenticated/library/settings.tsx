import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/library/settings')({
  beforeLoad: () => {
    redirect({ to: '/environments/library/settings', throw: true });
  },
});
