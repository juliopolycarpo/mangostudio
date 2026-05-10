import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import type { AuthContext } from './lib/auth-context';
import { queryClient } from './lib/query-client';

/** Placeholder until RouterProvider injects the real context on each render. */
const defaultAuth: AuthContext = { isAuthenticated: false, user: null, isPending: true };

export const router = createRouter({
  routeTree,
  context: { auth: defaultAuth, queryClient },
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
