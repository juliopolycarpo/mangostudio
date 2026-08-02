/**
 * Where one agent CLI actually exists, once there is more than one machine.
 *
 * The overview card already says whether the agent works; with several
 * environments configured, "works" is not a single fact. These chips answer
 * "on which of them" in the width a card has, and the Health tab's comparison
 * is where the same question gets a whole table.
 *
 * Environments that do not report their toolchains are left out rather than
 * shown as absent — a machine that will not answer has not said no.
 */

import type { Environment } from '@mangostudio/shared/environments';
import type { LibraryTargetId } from '@mangostudio/shared/library';
import { useQueries } from '@tanstack/react-query';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { agentCliStatusesQueryOptions } from '../queries';

interface AgentPresenceChipsProps {
  readonly targetId: LibraryTargetId;
  readonly environments: readonly Environment[];
}

export function AgentPresenceChips({ targetId, environments }: AgentPresenceChipsProps) {
  const { t } = useI18n();
  const reporting = environments.filter(
    (environment) => environment.status.manifest?.features.probing !== false
  );
  const results = useQueries({
    queries: reporting.map((environment) => ({
      ...agentCliStatusesQueryOptions(environment.id),
      // Presence is a summary of what the tabs already fetch; it must never be
      // the thing that wakes a sleeping remote machine up.
      enabled: environment.status.state === 'connected',
    })),
  });

  const chips = reporting
    .map((environment, index) => {
      const statuses = results[index]?.data;
      if (!statuses) return null;
      const present = Boolean(statuses.find((status) => status.targetId === targetId)?.effective);
      return { environment, present };
    })
    .filter((chip): chip is { environment: Environment; present: boolean } => chip !== null);

  if (chips.length < 2) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="agent-presence-chips">
      {chips.map(({ environment, present }) => (
        <span
          key={environment.id}
          data-testid="agent-presence-chip"
          data-environment-id={environment.id}
          data-present={present}
          title={formatMessage(t.environments.scope.presenceOn, { environment: environment.name })}
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
            present
              ? 'border-primary/30 bg-primary/10 text-primary'
              : 'border-outline-variant/20 text-on-surface-variant/60'
          }`}
        >
          {environment.name}
          <span aria-hidden="true">{present ? '✓' : '✗'}</span>
        </span>
      ))}
    </div>
  );
}
