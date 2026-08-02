/**
 * Why a tab has nothing to show about the environment you picked.
 *
 * Two situations that look identical from a spinner and are not: a machine the
 * hub cannot reach right now, and one whose runtime does not answer questions
 * about what is installed on it. The first has a button; the second is not a
 * fault and deliberately does not offer one.
 *
 * Either way the tab stops rendering the last machine's cards. Stale answers
 * under a new name are worse than an empty tab: they are what someone acts on.
 */

import type { Environment } from '@mangostudio/shared/environments';
import { PlugZap, ShieldOff } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { useConnectEnvironmentMutation } from '../queries';

interface EnvironmentScopeNoticeProps {
  readonly environment: Environment;
  readonly reason: 'disconnected' | 'not-permitted';
  /** Which tab's copy to use. Library staleness corrupts write decisions, so its hint is sharper. */
  readonly surface?: 'probing' | 'library';
}

export function EnvironmentScopeNotice({
  environment,
  reason,
  surface = 'probing',
}: EnvironmentScopeNoticeProps) {
  const { t } = useI18n();
  const e = t.environments;
  const connect = useConnectEnvironmentMutation();
  const notPermitted = reason === 'not-permitted';
  const library = surface === 'library';

  const title = notPermitted
    ? library
      ? e.scope.libraryNotPermitted
      : e.scope.notPermitted
    : e.scope.disconnected;
  const hint = notPermitted
    ? library
      ? e.scope.libraryNotPermittedHint
      : e.scope.notPermittedHint
    : library
      ? e.scope.libraryDisconnectedHint
      : e.scope.disconnectedHint;

  return (
    <div
      className="flex flex-col items-center gap-2 rounded-2xl border border-outline-variant/15 bg-surface-container-high py-10 text-center"
      data-testid="environment-scope-notice"
      data-reason={reason}
      data-surface={surface}
    >
      {notPermitted ? (
        <ShieldOff size={26} className="text-on-surface-variant/50" />
      ) : (
        <PlugZap size={26} className="text-warning" />
      )}
      <p className="text-sm font-semibold text-on-surface">
        {formatMessage(title, {
          environment: environment.name,
        })}
      </p>
      <p className="max-w-md text-sm text-on-surface-variant/60">{hint}</p>
      {!notPermitted && (
        <Button
          variant="ghost"
          size="sm"
          disabled={connect.isPending}
          onClick={() => connect.mutate(environment.id)}
        >
          {e.scope.connect}
        </Button>
      )}
    </div>
  );
}
