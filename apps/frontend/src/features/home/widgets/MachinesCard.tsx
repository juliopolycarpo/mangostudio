/**
 * Every machine the account can run a turn on, one line each.
 *
 * Read-only on purpose. `/environments` owns adding, renaming, connecting and
 * removing a machine, and each of those is a dialog with a confirm step behind
 * it; a dashboard that mounted them would be that page wearing a card. This
 * answers "what do I have and is it up" and hands the rest over through the
 * header link.
 *
 * Reads the environment list the runner selector already holds, so it costs no
 * request and never triggers a probe. Faults sort first — the machine that is
 * broken is the only reason to look at this before you need it.
 */

import type { Environment, EnvironmentConnectionState } from '@mangostudio/shared/environments';
import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { SectionCard } from '@/components/ui/SectionCard';
import { StatusDot, type StatusDotTone } from '@/components/ui/StatusDot';
import { useEnvironmentEntitiesQuery } from '@/features/environments/queries';
import { environmentScopeRoute } from '@/features/environments/use-environment-scope';
import { useI18n } from '@/hooks/use-i18n';
import { HubSkeletonLines } from './HubSkeletonLines';

const NO_ENVIRONMENTS: readonly Environment[] = [];

const STATE_TONE: Readonly<Record<EnvironmentConnectionState, StatusDotTone>> = {
  connected: 'success',
  connecting: 'warning',
  disconnected: 'neutral',
  error: 'error',
};

/** Worst first, then connected, then the idle rest; alphabetical inside each. */
const STATE_RANK: Readonly<Record<EnvironmentConnectionState, number>> = {
  error: 0,
  connecting: 1,
  connected: 2,
  disconnected: 3,
};

export function MachinesCard() {
  const { t } = useI18n();
  const labels = t.home.machines;
  const entityLabels = t.environments.entities;
  const { data, isPending, isError } = useEnvironmentEntitiesQuery();
  const environments = data ?? NO_ENVIRONMENTS;
  // Sorts the whole environment list; the status pushes that change arrive over
  // a socket, not on every render of the dashboard around it.
  const ordered = useMemo(() => sortByAttention(environments), [environments]);

  if (isError) return null;

  return (
    <SectionCard
      label={labels.label}
      tone={cardTone(ordered)}
      action={
        <Link
          to="/environments"
          className="micro-label text-primary/80 transition-colors hover:text-primary"
        >
          {labels.open}
        </Link>
      }
    >
      {isPending && ordered.length === 0 ? <HubSkeletonLines /> : null}

      {ordered.length > 0 ? (
        <ul className="space-y-1.5" data-testid="home-machines">
          {ordered.map((environment) => (
            <li key={environment.id}>
              <Link
                {...environmentScopeRoute(environment.id)}
                className="flex min-w-0 items-center gap-2 text-xs transition-colors hover:text-on-surface"
                data-environment-id={environment.id}
              >
                <StatusDot
                  tone={STATE_TONE[environment.status.state]}
                  pulse={environment.status.state === 'connecting'}
                />
                <span className="min-w-0 flex-1 truncate text-on-surface">{environment.name}</span>
                <span className="shrink-0 font-mono text-[10px] text-on-surface-variant/60">
                  {entityLabels.transport[environment.transportKind]}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-on-surface-variant/80">
                  {entityLabels.status[environment.status.state]}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </SectionCard>
  );
}

/**
 * Enabled machines only: a disabled one is a row nobody can act on, and this
 * card's whole job is naming the ones a turn could land on.
 */
function sortByAttention(environments: readonly Environment[]): readonly Environment[] {
  return environments
    .filter((environment) => environment.enabled)
    .sort(
      (left, right) =>
        STATE_RANK[left.status.state] - STATE_RANK[right.status.state] ||
        left.name.localeCompare(right.name)
    );
}

function cardTone(environments: readonly Environment[]): StatusDotTone {
  if (environments.some((environment) => environment.status.state === 'error')) return 'error';
  return environments.some((environment) => environment.status.state === 'connected')
    ? 'success'
    : 'neutral';
}
