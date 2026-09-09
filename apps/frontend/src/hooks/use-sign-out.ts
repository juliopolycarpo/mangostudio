/**
 * Signing out, including the wait that makes it land where it should.
 *
 * A hook rather than a copy per surface: the header offers this, and so does
 * first-run setup — which is the only page a not-yet-configured account can
 * reach, so without it someone signed in as the wrong person would have to
 * finish or skip a setup that is not theirs before they could leave.
 *
 * // Usage: const { signOut, isSigningOut } = useSignOut();
 */

import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { authClient } from '@/lib/auth-client';

export function useSignOut(): {
  readonly signOut: () => Promise<void>;
  readonly isSigningOut: boolean;
} {
  const { t } = useI18n();
  const { toast } = useToast();
  const navigate = useNavigate();
  const { data: session } = authClient.useSession();
  const [isSigningOut, setSigningOut] = useState(false);

  // Navigate to /login only once Better Auth has actually cleared the session.
  // signOut runs fetchOptions.onSuccess *before* it refetches the session (the
  // client toggles the session signal in a deferred setTimeout), so navigating
  // from onSuccess races a stale session and login.tsx bounces the user back
  // into the app. Gating on the cleared session removes the race entirely.
  useEffect(() => {
    if (isSigningOut && !session?.user) {
      void navigate({ to: '/login' });
    }
  }, [isSigningOut, session?.user, navigate]);

  const signOut = useCallback(async () => {
    setSigningOut(true);
    await authClient.signOut({
      fetchOptions: {
        onError: () => {
          setSigningOut(false);
          toast(t.auth.logoutError, 'error');
        },
      },
    });
  }, [t.auth.logoutError, toast]);

  return { signOut, isSigningOut };
}
