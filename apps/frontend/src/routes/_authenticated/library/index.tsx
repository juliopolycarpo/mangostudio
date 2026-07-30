import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * The library moved under the environments umbrella. These `/library/*` routes
 * exist only so bookmarks and links minted before the move keep resolving; they
 * render nothing and forward to the matching `/environments/library/*` sibling.
 */
export const Route = createFileRoute('/_authenticated/library/')({
  beforeLoad: () => {
    redirect({ to: '/environments/library', throw: true });
  },
});
