import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/settings/')({
  beforeLoad: () => {
    redirect({ to: '/settings/general', throw: true });
  },
});
