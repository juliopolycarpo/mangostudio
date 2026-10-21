/**
 * Whether an agent CLI is signed in, as far as a probe can honestly tell, as a
 * badge beside the health badge in the card's header.
 *
 * `authSignal: 'unknown'` renders "Sign-in state unknown", never "Not signed
 * in" — a file-presence probe genuinely cannot see a system keychain, and
 * claiming otherwise would be a lie the user cannot check. It is its own state
 * on every surface that shows it, which is why this lives apart from the card
 * that first needed it.
 *
 * Signed in is `success`. Signed out is `warning` when there is a CLI to sign
 * in to — the person can fix it — and `neutral` when the CLI is not installed
 * at all, where "not signed in" is true of a tool that is not there and is no
 * reason to ask for anything. Unknown is `neutral`, and says why on hover.
 */

import type { AgentCliStatus } from '@mangostudio/shared/environments';
import { Badge } from '@/components/ui/Badge';
import { useI18n } from '@/hooks/use-i18n';

interface AgentAuthStateProps {
  readonly status: AgentCliStatus;
}

export function AgentAuthState({ status }: AgentAuthStateProps) {
  const { t } = useI18n();
  const e = t.environments.agents;

  if (status.authSignal === 'unknown') {
    return (
      <Badge
        variant="neutral"
        title={e.authUnknownHint}
        data-testid="auth-state"
        data-auth-signal="unknown"
      >
        {e.authUnknown}
      </Badge>
    );
  }

  return (
    <Badge
      variant={status.authenticated ? 'success' : status.effective ? 'warning' : 'neutral'}
      data-testid="auth-state"
      data-auth-signal={status.authSignal}
    >
      {status.authenticated ? e.authSignedIn : e.authSignedOut}
    </Badge>
  );
}
