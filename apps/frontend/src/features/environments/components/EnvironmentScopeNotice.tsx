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
import { EmptyState } from '@/components/ui/EmptyState';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_LG } from '@/lib/icon-sizes';
import { useConnectEnvironmentMutation } from '../queries';
import { TOOL_CARD_SURFACE } from './ToolCard';

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
      className={TOOL_CARD_SURFACE}
      data-testid="environment-scope-notice"
      data-reason={reason}
      data-surface={surface}
    >
      <EmptyState
        icon={notPermitted ? <ShieldOff size={ICON_LG} /> : <PlugZap size={ICON_LG} />}
        tone={notPermitted ? 'neutral' : 'warning'}
        title={formatMessage(title, { environment: environment.name })}
        hint={hint}
        action={
          notPermitted ? undefined : (
            <Button
              variant="secondary"
              size="sm"
              disabled={connect.isPending}
              onClick={() => connect.mutate(environment.id)}
            >
              {e.scope.connect}
            </Button>
          )
        }
      />
    </div>
  );
}
