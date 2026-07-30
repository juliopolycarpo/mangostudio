import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/environments/library/')({
  beforeLoad: () => {
    redirect({ to: '/environments/library/skills', throw: true });
  },
});
