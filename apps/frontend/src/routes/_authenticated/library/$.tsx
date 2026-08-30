import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * The library moved under the environments umbrella. This forwards every
 * `/library/*` URL minted before the move to its `/environments/library/*`
 * sibling, so old bookmarks keep resolving.
 *
 * One splat rather than a stub per page: the mapping is a prefix, and seven
 * files repeating it were seven chances for a new library page to be forgotten
 * here — or for one of them to forward to the wrong sibling with nothing
 * failing loudly.
 *
 * `location.href` is pathname + search + hash, and all three carry meaning at
 * the destination: `environmentId` scopes every library tab and `compare` opens
 * the version diff on a resource. A redirect that forwarded only the path would
 * silently downgrade a legacy deep link into a different page.
 */
export const Route = createFileRoute('/_authenticated/library/$')({
  beforeLoad: ({ location }) => {
    redirect({ href: `/environments${location.href}`, replace: true, throw: true });
  },
});
