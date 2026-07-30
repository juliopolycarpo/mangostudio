import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/library/instructions')({
  beforeLoad: () => {
    redirect({ to: '/environments/library/instructions', throw: true });
  },
});
