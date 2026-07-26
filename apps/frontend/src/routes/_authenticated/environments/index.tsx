import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/environments/')({
  beforeLoad: () => {
    redirect({ to: '/environments/runtimes', throw: true });
  },
});
