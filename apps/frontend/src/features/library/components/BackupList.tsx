/**
 * Every retained backup set, with both ways out of each one.
 *
 * The wizard's undo button dies with the wizard, and reopening the app the next
 * day is the normal case for "I shouldn't have deleted that". Until this screen
 * existed only pinned sets had a row, which meant the sets a user might actually
 * want to reclaim disk from — every propagation apply, every removal that left
 * copies elsewhere — could be neither restored nor purged.
 *
 * The undo verb comes from the set's recorded origin and is never guessed. Undo
 * puts content back for a removal set and takes content away for a propagation
 * set that created paths, so one label across both would be a button that
 * silently deletes files on half the list. A set whose manifest predates that
 * record gets the neutral verb and says why.
 *
 * There is no "purge all" and no "restore everything". Each is one misclick
 * across every location the app writes into, and the sets on this list are the
 * last copies of things — the deliberate cost is that reclaiming a lot of disk
 * takes a lot of clicks.
 *
 * Rows are grouped by machine because that is where the bytes are. Two sets from
 * two machines sit on two disks under two separate retention budgets, and a flat
 * list would invite reading one machine's history as the whole picture. A
 * machine that is away keeps its rows — from the hub's index — with restore
 * disabled and the reason stated, which is the whole point of having an index.
 */

import type { PropagationBackupSet, PropagationUndo } from '@mangostudio/shared/library';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Archive, ArrowLeft, Pin, Server, Timer, Trash2, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { EmptyState } from '@/components/ui/EmptyState';
import { formatBytes } from '@/features/environments/format';
import { useEnvironmentEntitiesQuery } from '@/features/environments/queries';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage, formatRelativeTime } from '@/lib/i18n-format';
import { ICON_LG, ICON_MD, ICON_SM } from '@/lib/icon-sizes';
import { purgeBackup, undoPropagation } from '../api';
import { backupUsageQueryOptions, libraryKeys } from '../queries';
import { BackupSummary, formatBackupUsage } from './BackupSummary';
import { InlineNote } from './InlineNote';
import { LibraryPageState } from './LibraryPageState';

/** One set on one machine. Backup ids are minted per store, so neither half identifies a row. */
interface BackupTarget {
  readonly backupId: string;
  readonly environmentId: string;
}

function targetKey(target: BackupTarget): string {
  return `${target.environmentId}\u001f${target.backupId}`;
}

/**
 * Sets per machine, in the order the response put them.
 *
 * The API already sorts newest first across every machine, so preserving
 * insertion order here means the machine with the most recent activity heads the
 * page — which is almost always the one the user just did something on.
 */
function groupByEnvironment(
  sets: readonly PropagationBackupSet[]
): [string, PropagationBackupSet[]][] {
  const grouped = new Map<string, PropagationBackupSet[]>();
  for (const set of sets) {
    const existing = grouped.get(set.environmentId);
    if (existing) existing.push(set);
    else grouped.set(set.environmentId, [set]);
  }
  return [...grouped];
}

export function BackupList() {
  const { t, locale } = useI18n();
  const l = t.library;
  const queryClient = useQueryClient();
  const query = useQuery(backupUsageQueryOptions());
  // Names only. A row whose machine has since been deleted still lists — the
  // bytes outlive the configuration — and falls back to naming the id.
  const environments = useEnvironmentEntitiesQuery().data ?? [];
  const nameOf = (environmentId: string) =>
    environments.find((environment) => environment.id === environmentId)?.name ??
    formatMessage(l.backups.machineUnknown, { id: environmentId });
  // Two clicks on every row, pinned or not. Ordinary sets are purgeable here for
  // the first time, and the asymmetry that used to exist — a confirm only where
  // rows happened to be pinned — was an accident of pinned rows being the only
  // rows, not a considered rule about which copies deserve one.
  const [confirming, setConfirming] = useState<string | null>(null);
  const purge = useMutation({
    mutationFn: (target: BackupTarget) => purgeBackup(target.backupId, target.environmentId),
    onSettled: () => setConfirming(null),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: libraryKeys.backups() }),
  });
  // Restore needs no confirmation to match the purge: it refuses any destination
  // that changed since the apply, so the worst outcome is a no-op the row
  // reports. Restoring does not consume the set — the copy stays retained until
  // the user purges it.
  const restore = useMutation({
    mutationFn: (target: BackupTarget) => undoPropagation(target.backupId, target.environmentId),
    // Resources are back on disk, so the matrix that said they were gone is now
    // wrong; each set's size and pinning can move with it.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: libraryKeys.all }),
  });

  if (query.isPending) return <LibraryPageState variant="loading" />;
  if (query.error) {
    return <LibraryPageState variant="error" onRetry={() => void query.refetch()} />;
  }

  const usage = query.data;
  const pinnedCount = usage.sets.filter((set) => set.pinned).length;
  const machines = groupByEnvironment(usage.sets);
  const pending = (target: BackupTarget) =>
    purge.variables !== undefined && targetKey(purge.variables) === targetKey(target);
  const restoring = (target: BackupTarget) =>
    restore.variables !== undefined && targetKey(restore.variables) === targetKey(target);

  return (
    <div className="space-y-4" data-testid="backup-list">
      <div className="space-y-1">
        {/* Backups span every kind, so they are no tab of the strip above; this
            is the way back to where the sets came from. */}
        <Link
          to="/environments/library/skills"
          className="inline-flex items-center gap-1.5 text-fg-muted text-xs hover:text-fg"
          data-testid="backups-back"
        >
          <ArrowLeft size={ICON_SM} aria-hidden="true" />
          {l.backups.back}
        </Link>
        <h2 className="font-semibold text-base text-fg">{l.backups.title}</h2>
        <p className="text-fg-muted text-sm">{l.backups.description}</p>
        <BackupSummary usage={usage} perMachine />
      </div>

      {usage.unreachableEnvironmentIds.length > 0 && (
        <Callout
          tone="warning"
          title={formatMessage(l.backups.unreachable, {
            machines: usage.unreachableEnvironmentIds.map(nameOf).join(', '),
          })}
          data-testid="backup-unreachable"
        />
      )}
      {/*
        Pinned bytes are charged against the budget first and never evicted,
        so they are why retention can feel tighter than the numbers above
        suggest. Stating them is what makes the eviction badges add up.
      */}
      {pinnedCount > 0 && (
        <Callout
          tone="info"
          title={formatMessage(l.backups.pinned, {
            count: String(pinnedCount),
            size: formatBytes(usage.pinnedSizeBytes),
          })}
          data-testid="backup-pinned-summary"
        >
          {l.backups.pinnedHint}
        </Callout>
      )}

      {usage.sets.length === 0 && (
        <div data-testid="backup-list-empty">
          <EmptyState icon={<Archive size={ICON_LG} />} title={l.backups.empty} />
        </div>
      )}

      {machines.map(([environmentId, sets]) => (
        <section
          key={environmentId}
          className="space-y-2"
          data-testid="backup-machine"
          data-environment-id={environmentId}
        >
          <h3 className="flex items-center gap-2 font-semibold text-fg text-sm">
            <Server size={ICON_MD} aria-hidden="true" className="shrink-0 text-fg-muted" />
            {nameOf(environmentId)}
            {/* One machine's figures are the page's figures, already stated under the
                description; a second copy of them beside the name only repeats it. */}
            {machines.length > 1 && (
              <span className="font-normal text-fg-muted text-xs">
                {formatBackupUsage(
                  l.backups,
                  sets.length,
                  sets.reduce((total, set) => total + set.sizeBytes, 0)
                )}
              </span>
            )}
          </h3>
          <ul className="space-y-2">
            {sets.map((set) => {
              const target = { backupId: set.backupId, environmentId };
              return (
                <BackupRow
                  key={targetKey(target)}
                  set={set}
                  locale={locale}
                  confirming={confirming === targetKey(target)}
                  onConfirm={() => setConfirming(targetKey(target))}
                  onCancelConfirm={() => setConfirming(null)}
                  onPurge={() => purge.mutate(target)}
                  onRestore={() => restore.mutate(target)}
                  purgePending={purge.isPending && pending(target)}
                  purgeFailed={purge.isError && pending(target)}
                  restorePending={restore.isPending && restoring(target)}
                  restoreFailed={restore.isError && restoring(target)}
                  // Keyed to the set the response names, not to the last row
                  // clicked: the answer carries the machine and the id it acted
                  // on, and a restore reported against the wrong row is worse
                  // than none at all. Both halves are needed — backup ids are
                  // minted per store, so two machines can hold the same one.
                  result={
                    restore.data?.backupId === set.backupId &&
                    restore.data.environmentId === environmentId
                      ? restore.data
                      : undefined
                  }
                />
              );
            })}
          </ul>
        </section>
      ))}

      <p className="text-fg-subtle text-xs">{l.backups.bulkHint}</p>
    </div>
  );
}

interface BackupRowProps {
  readonly set: PropagationBackupSet;
  readonly locale: string;
  readonly confirming: boolean;
  readonly onConfirm: () => void;
  readonly onCancelConfirm: () => void;
  readonly onPurge: () => void;
  readonly onRestore: () => void;
  readonly purgePending: boolean;
  readonly purgeFailed: boolean;
  readonly restorePending: boolean;
  readonly restoreFailed: boolean;
  readonly result?: PropagationUndo;
}

function BackupRow({
  set,
  locale,
  confirming,
  onConfirm,
  onCancelConfirm,
  onPurge,
  onRestore,
  purgePending,
  purgeFailed,
  restorePending,
  restoreFailed,
  result,
}: BackupRowProps) {
  const { t } = useI18n();
  const l = t.library;
  // Stated up front rather than discovered on click. A restore reads the
  // manifest on the machine that holds the bytes, so a machine that is away and
  // a set that lost its manifest are both "this button cannot work", and a
  // button that fails on click teaches users their backups are unreliable.
  const blockedReason =
    set.availability === 'environment-offline'
      ? l.backups.unavailableOffline
      : set.availability === 'manifest-missing'
        ? l.backups.unavailableManifest
        : null;

  return (
    <li
      className="space-y-3 rounded-md border border-stroke bg-surface p-4"
      data-testid="backup-row"
      data-backup-id={set.backupId}
      data-operation={set.operation}
      data-availability={set.availability}
    >
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
        <span className="text-fg" data-testid="backup-created">
          <span className="text-fg-subtle">{l.backups.columnCreated} </span>
          {formatRelativeTime(set.createdAtMs, locale)}
        </span>
        {/*
          Only the machine knows what a set holds, so a row assembled from the
          hub's index omits the cell entirely. Printing "0 entries" there would
          state as fact the one thing an index row cannot know.
        */}
        {set.availability === 'available' && (
          <span className="text-fg" data-testid="backup-contents">
            <span className="text-fg-subtle">{l.backups.columnContents} </span>
            {/*
              A v1 manifest carries no resource keys, so the row falls back to the
              entry count rather than printing an empty cell that reads as "this
              backup holds nothing".
            */}
            {set.resourceKeys.length > 0
              ? set.resourceKeys.join(', ')
              : formatMessage(l.backups.contentsUnknown, { count: String(set.entryCount) })}
          </span>
        )}
        <span className="text-fg-muted" data-testid="backup-size">
          <span className="text-fg-subtle">{l.backups.columnSize} </span>
          {formatBytes(set.sizeBytes)}
        </span>
        <span className="text-fg-muted" data-testid="backup-origin">
          <span className="text-fg-subtle">{l.backups.columnOrigin} </span>
          {l.backups.origin[set.operation]}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="break-all font-mono text-fg-subtle text-micro">{set.backupId}</span>
        {set.pinned && (
          <Badge data-testid="backup-pinned">
            <Pin size={ICON_SM} aria-hidden="true" />
            {l.backups.pinnedBadge}
          </Badge>
        )}
        {/*
          Retention evicts on the next apply, so a set is named before it goes
          rather than missed afterwards. Never both badges: a pinned set sits
          outside every automatic eviction path.
        */}
        {set.evictsNext && (
          <Badge
            variant="warning"
            data-testid="backup-evicts-next"
            title={l.backups.evictsNextHint}
          >
            <Timer size={ICON_SM} aria-hidden="true" />
            {l.backups.evictsNext}
          </Badge>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={onRestore}
          disabled={blockedReason !== null}
          loading={restorePending}
          data-testid="restore-backup"
          title={
            blockedReason ?? (set.operation === 'unknown' ? l.backups.undoUnknownHint : undefined)
          }
        >
          <Undo2 size={ICON_MD} />
          {restorePending ? l.backups.restoring : undoLabel(set.operation, l.backups)}
        </Button>

        {confirming ? (
          <>
            <Button
              variant="danger"
              size="sm"
              onClick={onPurge}
              loading={purgePending}
              data-testid="purge-backup-confirm"
            >
              <Trash2 size={ICON_MD} />
              {l.backups.purgeConfirm}
            </Button>
            <Button
              variant="subtle"
              size="sm"
              onClick={onCancelConfirm}
              data-testid="purge-backup-cancel"
            >
              {l.backups.purgeCancel}
            </Button>
          </>
        ) : (
          <Button
            variant="subtle"
            size="sm"
            onClick={onConfirm}
            disabled={purgePending}
            className="text-danger"
            data-testid="purge-backup"
          >
            <Trash2 size={ICON_MD} />
            {l.backups.purge}
          </Button>
        )}
      </div>

      {/*
        Restored and removed are counted apart, never summed into one "put
        back". Undoing a propagation set deletes the paths that apply created,
        and reporting that as content restored would describe a deletion as a
        recovery. A restore that touched nothing at all — every destination
        changed after the apply — also looks exactly like one that worked
        unless the counts are stated.
      */}
      {result && (
        <p className="text-fg-muted text-sm" data-testid="restore-backup-result">
          {formatMessage(l.result.undone, {
            restored: String(result.restored.length),
            removed: String(result.removed.length),
          })}
          {result.skipped.length > 0 &&
            ` ${formatMessage(l.result.undoSkipped, { count: String(result.skipped.length) })}`}
        </p>
      )}
      {restoreFailed && (
        <InlineNote tone="danger" data-testid="restore-backup-error">
          {l.backups.restoreError}
        </InlineNote>
      )}
      {/*
        A failed purge that says nothing is indistinguishable from one that
        worked, and the set is still on disk counting against the budget.
      */}
      {purgeFailed && (
        <InlineNote tone="danger" data-testid="purge-backup-error">
          {l.backups.purgeError}
        </InlineNote>
      )}

      {blockedReason !== null && (
        <p className="text-fg-muted text-xs" data-testid="backup-unavailable">
          {blockedReason}
        </p>
      )}

      {set.operation === 'unknown' && blockedReason === null && (
        <p className="text-fg-subtle text-xs" data-testid="backup-unknown-hint">
          {l.backups.undoUnknownHint}
        </p>
      )}
    </li>
  );
}

/**
 * The verb for undoing one set, decided by what wrote it.
 *
 * `unknown` is a manifest that predates the record and is deliberately not
 * resolved to either verb: undoing it may restore content or remove what was
 * written, and only the neutral label is true of both.
 */
function undoLabel(
  operation: PropagationBackupSet['operation'],
  messages: { undoRemoval: string; undoPropagation: string; undoUnknown: string }
): string {
  switch (operation) {
    case 'removal':
      return messages.undoRemoval;
    case 'propagation':
      return messages.undoPropagation;
    default:
      return messages.undoUnknown;
  }
}
