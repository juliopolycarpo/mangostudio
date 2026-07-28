import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/library/')({
  beforeLoad: () => {
    redirect({ to: '/library/skills', throw: true });
  },
});
