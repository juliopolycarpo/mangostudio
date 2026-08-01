/**
 * The pairing half of a dial-in environment card: the address the runtime
 * dials, the credential it presents, and the commands to run on that machine.
 *
 * A token is readable exactly once. The panel therefore holds the issued string
 * in local state and says so plainly, rather than offering a "show token"
 * affordance the server could never honour.
 */

import type { RuntimePairingStatus } from '@mangostudio/shared/environments';
import { Check, Copy, KeyRound, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useClipboard } from '@/hooks/use-clipboard';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { resolveApiErrorMessage } from '@/lib/utils';
import {
  useIssueRuntimePairingMutation,
  useRevokeRuntimePairingMutation,
  useRuntimePairingQuery,
} from '../queries';

interface RuntimePairingPanelProps {
  readonly environmentId: string;
}

export function RuntimePairingPanel({ environmentId }: RuntimePairingPanelProps) {
  const { t } = useI18n();
  const labels = t.environments.entities.pairing;
  const pairing = useRuntimePairingQuery(environmentId, true);
  const issue = useIssueRuntimePairingMutation(environmentId);
  const revoke = useRevokeRuntimePairingMutation(environmentId);
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const status: RuntimePairingStatus | undefined = pairing.data;
  const busy = issue.isPending || revoke.isPending;

  const runIssue = async () => {
    setError(null);
    try {
      setIssuedToken((await issue.mutateAsync()).token);
    } catch (caught) {
      setError(resolveApiErrorMessage(caught, labels.issueFailed));
    }
  };

  const runRevoke = async () => {
    if (!window.confirm(labels.revokeConfirm)) return;
    setError(null);
    try {
      await revoke.mutateAsync();
      setIssuedToken(null);
    } catch (caught) {
      setError(resolveApiErrorMessage(caught, labels.revokeFailed));
    }
  };

  return (
    <section
      className="space-y-3 rounded-xl border border-outline-variant/20 bg-surface-container-lowest/60 p-3"
      data-testid="runtime-pairing-panel"
    >
      <div className="flex items-start gap-2">
        <KeyRound size={14} className="mt-0.5 shrink-0 text-primary" />
        <div className="min-w-0 space-y-0.5">
          <p className="font-semibold text-on-surface text-xs">{labels.title}</p>
          <p className="text-[11px] text-on-surface-variant/70">{labels.description}</p>
        </div>
      </div>

      {status?.endpoint ? null : (
        <p className="rounded-lg border border-warning/35 bg-warning/5 px-2.5 py-2 text-[11px] text-on-surface-variant">
          {labels.endpointUnset}
        </p>
      )}

      {status?.token ? (
        <p className="text-[11px] text-on-surface-variant/70">
          {status.token.lastSeenAt
            ? formatMessage(labels.lastSeen, {
                when: new Date(status.token.lastSeenAt).toLocaleString(),
              })
            : labels.neverSeen}
        </p>
      ) : (
        <p className="text-[11px] text-on-surface-variant/70">{labels.noToken}</p>
      )}

      {issuedToken ? <SetupSteps endpoint={status?.endpoint ?? null} token={issuedToken} /> : null}

      {error ? (
        <p className="text-[11px] text-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => void runIssue()}
          disabled={busy}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary/10 px-2.5 font-semibold text-primary text-xs transition-colors hover:bg-primary/15 disabled:opacity-45"
        >
          <RefreshCw size={13} />
          {status?.token ? labels.rotate : labels.issue}
        </button>
        {status?.token ? (
          <button
            type="button"
            onClick={() => void runRevoke()}
            disabled={busy}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-error/80 text-xs hover:bg-error/10 hover:text-error disabled:opacity-45"
          >
            <Trash2 size={13} />
            {labels.revoke}
          </button>
        ) : null}
      </div>
    </section>
  );
}

/**
 * The command to run on the target machine. The token goes in on stdin rather
 * than as an argument: a command line is readable by every process on that
 * machine, and this one is shown once.
 *
 * One line, not three. The install one-liner needs a published raw asset and
 * `setup` needs the consent gate — neither exists yet, and a card that prints a
 * command the binary answers with `Unknown argument` is worse than a card that
 * stays quiet about a step until there is one.
 */
function SetupSteps({
  endpoint,
  token,
}: {
  readonly endpoint: string | null;
  readonly token: string;
}) {
  const { t } = useI18n();
  const labels = t.environments.entities.pairing;
  const target = endpoint ?? labels.endpointPlaceholder;
  const command = `printf %s '${token}' | mangostudio-runtime connect --hub ${target} --token -`;

  return (
    <div className="space-y-2 rounded-lg border border-primary/35 bg-primary/5 p-2.5">
      <p className="font-semibold text-[11px] text-on-surface">{labels.tokenIssued}</p>
      <p className="text-[11px] text-on-surface-variant/70">{labels.tokenOnce}</p>
      <CopyLine label={labels.stepConnect} value={command} />
      <p className="text-[11px] text-on-surface-variant/60">{labels.serviceHint}</p>
    </div>
  );
}

function CopyLine({ label, value }: { readonly label: string; readonly value: string }) {
  const { t } = useI18n();
  const { copy, copied, failed } = useClipboard();

  return (
    <div className="space-y-1">
      <p className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/70">
        {label}
      </p>
      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 break-all rounded-lg bg-surface-container-highest px-2 py-1.5 font-mono text-[11px] text-on-surface">
          {value}
        </code>
        <Button variant="secondary" size="sm" onClick={() => void copy(value)}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? t.environments.actions.copied : t.environments.actions.copy}
        </Button>
      </div>
      {failed ? (
        <p className="text-[11px] text-error">{t.environments.actions.copyFailed}</p>
      ) : null}
    </div>
  );
}
