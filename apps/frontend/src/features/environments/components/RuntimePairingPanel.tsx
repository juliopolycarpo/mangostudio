/**
 * The pairing half of a dial-in environment card: the address the runtime
 * dials, the credential it presents, and the commands to run on that machine.
 *
 * A token is readable exactly once. The panel therefore holds the issued string
 * in local state and says so plainly, rather than offering a "show token"
 * affordance the server could never honour.
 */

import type { RuntimePairingStatus } from '@mangostudio/shared/environments';
import { KeyRound, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_MD } from '@/lib/icon-sizes';
import { resolveApiErrorMessage } from '@/lib/utils';
import {
  useIssueRuntimePairingMutation,
  useRevokeRuntimePairingMutation,
  useRuntimeLifecycleQuery,
  useRuntimePairingQuery,
} from '../queries';
import { CopyLine } from './CopyLine';
import { CommandGroup, EntityPanel } from './EntityPanel';

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
    <EntityPanel
      testId="runtime-pairing-panel"
      icon={<KeyRound size={ICON_MD} />}
      title={labels.title}
      description={labels.description}
    >
      {status?.endpoint ? null : <Callout tone="warning">{labels.endpointUnset}</Callout>}

      {status?.token ? (
        <p className="text-xs text-fg-muted">
          {status.token.lastSeenAt
            ? formatMessage(labels.lastSeen, {
                when: new Date(status.token.lastSeenAt).toLocaleString(),
              })
            : labels.neverSeen}
        </p>
      ) : (
        <p className="text-xs text-fg-muted">{labels.noToken}</p>
      )}

      {issuedToken ? (
        <SetupSteps
          endpoint={status?.endpoint ?? null}
          token={issuedToken}
          environmentId={environmentId}
        />
      ) : null}

      {error ? (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => void runIssue()} disabled={busy}>
          <RefreshCw size={ICON_MD} />
          {status?.token ? labels.rotate : labels.issue}
        </Button>
        {status?.token ? (
          <Button
            variant="subtle"
            size="sm"
            onClick={() => void runRevoke()}
            disabled={busy}
            className="text-danger enabled:hover:bg-danger-subtle"
          >
            <Trash2 size={ICON_MD} />
            {labels.revoke}
          </Button>
        ) : null}
      </div>
    </EntityPanel>
  );
}

/**
 * The command to run on the target machine, in both shells a target machine
 * plausibly has. The token never becomes an argument: a command line is
 * readable by every process on that machine, and this one is shown once.
 *
 * Two forms rather than one, because `printf %s '…' |` is not a command
 * `cmd.exe` or PowerShell has — a Windows operator following the POSIX line
 * gets a parse error, not a paired machine. PowerShell sets the documented
 * environment variable instead of piping, which keeps the secret out of argv
 * the same way and off the pipeline's newline handling.
 *
 * One step, not three. The install one-liner needs a published raw asset and
 * `setup` needs the consent gate — neither exists yet, and a card that prints a
 * command the binary answers with `Unknown argument` is worse than a card that
 * stays quiet about a step until there is one.
 */
function SetupSteps({
  endpoint,
  token,
  environmentId,
}: {
  readonly endpoint: string | null;
  readonly token: string;
  readonly environmentId: string;
}) {
  const { t } = useI18n();
  const labels = t.environments.entities.pairing;
  const lifecycle = useRuntimeLifecycleQuery(environmentId, true);
  const serviceInstall = lifecycle.data?.manualCommands?.serviceInstall;
  const target = endpoint ?? labels.endpointPlaceholder;
  const posix = `printf %s '${token}' | mangostudio-runtime connect --hub ${target} --token -`;
  const powershell = `$env:MANGOSTUDIO_RUNTIME_TOKEN='${token}'; mangostudio-runtime connect --hub ${target}`;

  return (
    <CommandGroup title={labels.tokenIssued}>
      <Callout tone="warning">{labels.tokenOnce}</Callout>
      <CopyLine label={labels.stepConnect} value={posix} />
      <CopyLine label={labels.stepConnectPowerShell} value={powershell} />
      {serviceInstall ? (
        <>
          <CopyLine label={labels.stepService} value={serviceInstall} />
          <p className="text-xs text-fg-muted">{labels.serviceHint}</p>
        </>
      ) : null}
    </CommandGroup>
  );
}
