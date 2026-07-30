import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/library/backups')({
  beforeLoad: () => {
    redirect({ to: '/environments/library/backups', throw: true });
  },
});
