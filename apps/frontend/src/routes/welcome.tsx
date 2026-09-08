import { createFileRoute, redirect } from '@tanstack/react-router';
import { BootstrapErrorPanel } from '@/components/layout/BootstrapErrorPanel';
import { appSettingsQueryOptions } from '@/features/settings/app/queries';
import { safeRedirect } from '@/lib/safe-redirect';

/**
 * First-run setup, deliberately a sibling of `_authenticated` rather than a
 * child of it.
 *
 * The authenticated layout loads chats, the model catalog and agent settings
 * before it renders anything. A person who has not finished setting up is
 * exactly the person most likely to have none of those working — no provider
 * key, an empty catalog — and nesting this route under that loader would make
 * the fix unreachable behind the failure it fixes. So this route loads only
 * what it genuinely needs: a session and the settings record its progress lives
 * in.
 */
export const Route = createFileRoute('/welcome')({
  // Sanitized here for the same reason `/login` sanitizes its own: the value
  // reaches `history.push` verbatim when setup finishes.
  validateSearch: (raw: Record<string, unknown>): { redirect?: string } => {
    if (typeof raw.redirect !== 'string') return {};
    return { redirect: safeRedirect(raw.redirect) };
  },
  beforeLoad: ({ context, location }) => {
    if (!context.auth.isAuthenticated) {
      redirect({ to: '/login', search: { redirect: location.href }, throw: true });
    }
  },
  loader: ({ context: { queryClient } }) => queryClient.ensureQueryData(appSettingsQueryOptions()),
  errorComponent: BootstrapErrorPanel,
});
