import { createLazyFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createLazyFileRoute('/_authenticated/settings/providers')({
  component: () => <Outlet />,
});
