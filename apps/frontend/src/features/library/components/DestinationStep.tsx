/**
 * Step 2 — where the chosen versions get written.
 *
 * The single most useful thing this step can say is that one location serves
 * two targets. Checking `agents-skills` already satisfies both MangoStudio and
 * Codex; a user who does not know that will also check `codex-skills` and walk
 * away with a second copy they now have to keep in sync.
 *
 * Machines come first in the hierarchy, targets second. `~/.claude/skills` names
 * a different directory on every machine the user has, so a flat list of
 * locations would put several distinct destinations under one label — and the
 * one thing a cross-machine write must never be is ambiguous about where it
 * lands. A machine that cannot be reached is listed and unselectable, with the
 * reason, rather than omitted: absent reads as "you do not have that machine".
 */

import type {
  LibraryLocationId,
  LibraryLocationStatus,
  LibraryTargetId,
  PropagationDestination,
  PropagationPreview,
} from '@mangostudio/shared/library';
import { Link } from '@tanstack/react-router';
import { Server } from 'lucide-react';
import { useMemo } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { hashPrefix } from '../format';
import { destinationKey, destinationsByEnvironment, type WizardDraft } from '../propagation';
import { BlockedReason } from './BlockedReason';

interface DestinationStepProps {
  readonly preview: PropagationPreview;
  readonly draft: WizardDraft;
  readonly locations: readonly LibraryLocationStatus[];
  readonly environmentName: (environmentId: string) => string;
  readonly onToggle: (environmentId: string, locationId: LibraryLocationId) => void;
}

function groupByTarget(
  destinations: readonly PropagationDestination[]
): [LibraryTargetId, PropagationDestination[]][] {
  const groups = new Map<LibraryTargetId, PropagationDestination[]>();
  for (const destination of destinations) {
    const primary = destination.targetIds[0];
    if (primary === undefined) continue;
    const bucket = groups.get(primary);
    if (bucket) bucket.push(destination);
    else groups.set(primary, [destination]);
  }
  return [...groups];
}

export function DestinationStep({
  preview,
  draft,
  locations,
  environmentName,
  onToggle,
}: DestinationStepProps) {
  const { t } = useI18n();
  const l = t.library;
  const machines = useMemo(() => destinationsByEnvironment(preview), [preview]);

  if (machines.length === 0) {
    return (
      <p className="text-on-surface-variant text-sm" data-testid="destination-none">
        {l.destination.none}
      </p>
    );
  }

  return (
    <div className="space-y-4" data-testid="destination-step">
      <p className="text-on-surface text-sm">{l.destination.description}</p>
      {machines.map(([environmentId, machineDestinations]) => (
        <section
          key={environmentId}
          className="space-y-2"
          data-testid="destination-machine"
          data-environment-id={environmentId}
        >
          <h3 className="flex items-center gap-1.5 font-semibold text-on-surface text-xs">
            <Server size={12} aria-hidden="true" />
            {environmentName(environmentId)}
          </h3>
          {groupByTarget(machineDestinations).map(([targetId, group]) => (
            <div key={targetId} className="space-y-1.5">
              <h4 className="font-label font-semibold text-[10px] text-on-surface-variant/70 uppercase tracking-widest">
                {l.targets[targetId]}
              </h4>
              {group.map((destination) => (
                <DestinationRow
                  key={destinationKey(destination.environmentId, destination.locationId)}
                  destination={destination}
                  // Location health is per machine; the status list belongs to
                  // the environment the wizard was opened in, so it only
                  // describes that one.
                  status={
                    destination.environmentId === preview.entries[0]?.destinations[0]?.environmentId
                      ? locations.find((candidate) => candidate.id === destination.locationId)
                      : undefined
                  }
                  checked={draft.destinations.has(
                    destinationKey(destination.environmentId, destination.locationId)
                  )}
                  onToggle={onToggle}
                />
              ))}
            </div>
          ))}
        </section>
      ))}
      {draft.destinations.size === 0 && (
        <p className="text-error text-xs" data-testid="no-destination-selected">
          {l.destination.noneSelected}
        </p>
      )}
    </div>
  );
}

function DestinationRow({
  destination,
  status,
  checked,
  onToggle,
}: {
  readonly destination: PropagationDestination;
  readonly status: LibraryLocationStatus | undefined;
  readonly checked: boolean;
  readonly onToggle: (environmentId: string, locationId: LibraryLocationId) => void;
}) {
  const { t } = useI18n();
  const l = t.library;
  const blocked = destination.blockedReason !== undefined;
  const otherTargets = destination.targetIds.slice(1);

  return (
    <label
      className={`flex items-start gap-2 rounded-lg border p-2.5 ${
        blocked
          ? 'cursor-not-allowed border-outline-variant/10 bg-surface-container/40 opacity-70'
          : 'cursor-pointer border-outline-variant/15 bg-surface-container-high'
      }`}
      data-testid="destination-row"
      data-environment-id={destination.environmentId}
      data-location-id={destination.locationId}
      data-blocked={blocked}
    >
      <input
        type="checkbox"
        checked={checked && !blocked}
        // A blocked destination can never be applied — the apply route rejects
        // it outright — so the checkbox is disabled rather than merely warned about.
        disabled={blocked}
        onChange={() => onToggle(destination.environmentId, destination.locationId)}
        className="mt-0.5 size-3.5 accent-primary"
      />
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="block break-all font-mono text-on-surface text-xs">
          {destination.path ?? destination.locationId}
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-on-surface-variant/60">
          <span>{l.format[destination.toFormat]}</span>
          <span>
            {destination.currentContentHash
              ? formatMessage(l.destination.currentContent, {
                  hash: `${hashPrefix(destination.currentContentHash)}…`,
                })
              : l.destination.empty}
          </span>
          {status?.access === 'read-only' && <span>{l.destination.readOnly}</span>}
        </span>

        {otherTargets.length > 0 && (
          <span className="block text-[11px] text-primary" data-testid="serves-multiple-targets">
            {formatMessage(l.destination.servesMultipleTargets, {
              location: destination.path ?? destination.locationId,
              targets: otherTargets.map((targetId) => l.targets[targetId]).join(', '),
            })}
          </span>
        )}

        {destination.blockedReason && (
          <span className="block">
            <BlockedReason
              reason={destination.blockedReason}
              action={
                // 005 already surfaced an unwritable location; sending the user
                // there is more useful than restating the problem here.
                destination.blockedReason === 'location-unwritable' ? (
                  <Link
                    to="/environments/agents"
                    className="text-primary underline underline-offset-2"
                  >
                    {l.destination.unwritableAction}
                  </Link>
                ) : undefined
              }
            />
          </span>
        )}
      </span>
    </label>
  );
}
