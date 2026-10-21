/**
 * Whether an agent CLI is signed in, as far as a probe can honestly tell.
 *
 * `authSignal: 'unknown'` renders "Sign-in state unknown", never "Not signed
 * in" — a file-presence probe genuinely cannot see a system keychain, and
 * claiming otherwise would be a lie the user cannot check. It is its own state
 * on every surface that shows it, which is why this lives apart from the card
 * that first needed it.
 */

import type { AgentCliStatus } from '@mangostudio/shared/environments';
import { useI18n } from '@/hooks/use-i18n';
import { cn } from '@/lib/utils';

interface AgentAuthStateProps {
  readonly status: AgentCliStatus;
  /** Explains what "unknown" means; dropped where space is the scarcer thing. */
  readonly showHint?: boolean;
}

export function AgentAuthState({ status, showHint = true }: AgentAuthStateProps) {
  const { t } = useI18n();
  const e = t.environments.agents;

  if (status.authSignal === 'unknown') {
    return (
      <div className="space-y-0.5" data-testid="auth-state" data-auth-signal="unknown">
        <p className="text-sm text-fg-muted">{e.authUnknown}</p>
        {showHint && <p className="text-xs text-fg-muted">{e.authUnknownHint}</p>}
      </div>
    );
  }

  return (
    <p
      className={cn('text-sm', status.authenticated ? 'text-success' : 'text-info')}
      data-testid="auth-state"
      data-auth-signal={status.authSignal}
    >
      {status.authenticated ? e.authSignedIn : e.authSignedOut}
    </p>
  );
}
