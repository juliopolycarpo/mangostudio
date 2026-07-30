import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/library/$resourceKey')({
  beforeLoad: ({ params }) => {
    redirect({ to: '/environments/library/$resourceKey', params, throw: true });
  },
});
