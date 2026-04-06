import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';

export const router = createRouter({
  routeTree,
  context: {
    // TanStack Router pattern: context is provided by RouterProvider on each render;
    // `undefined!` satisfies the type-checker without making the whole context optional.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- TanStack Router context initialisation pattern
    auth: undefined!,
  },
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
