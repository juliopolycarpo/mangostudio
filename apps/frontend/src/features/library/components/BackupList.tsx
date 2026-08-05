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
import { Pin, Server, Timer, Trash2, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useEnvironmentEntitiesQuery } from '@/features/environments/queries';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { purgeBackup, undoPropagation } from '../api';
import { formatBytes, formatRelativeTime } from '../format';
import { backupUsageQueryOptions, libraryKeys } from '../queries';
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
        <h2 className="font-semibold text-base text-on-surface">{l.backups.title}</h2>
        <p className="text-on-surface text-sm">{l.backups.description}</p>
        <p className="text-[11px] text-on-surface-variant/60">
          {formatMessage(l.backups.usage, {
            count: String(usage.setCount),
            size: formatBytes(usage.sizeBytes),
          })}{' '}
          {formatMessage(l.backups.retention, {
            count: String(usage.retentionCount),
            size: formatBytes(usage.retentionBytes),
          })}{' '}
          {l.backups.retentionPerMachine}
        </p>
        {usage.unreachableEnvironmentIds.length > 0 && (
          <p className="text-[11px] text-on-surface-variant/60" data-testid="backup-unreachable">
            {formatMessage(l.backups.unreachable, {
              machines: usage.unreachableEnvironmentIds.map(nameOf).join(', '),
            })}
          </p>
        )}
        {/*
          Pinned bytes are charged against the budget first and never evicted,
          so they are why retention can feel tighter than the numbers above
          suggest. Stating them is what makes the eviction badges add up.
        */}
        {pinnedCount > 0 && (
          <p className="text-[11px] text-tertiary" data-testid="backup-pinned-summary">
            {formatMessage(l.backups.pinned, {
              count: String(pinnedCount),
              size: formatBytes(usage.pinnedSizeBytes),
            })}{' '}
            {l.backups.pinnedHint}
          </p>
        )}
      </div>

      {usage.sets.length === 0 && (
        <p className="text-on-surface-variant/70 text-sm" data-testid="backup-list-empty">
          {l.backups.empty}
        </p>
      )}

      {machines.map(([environmentId, sets]) => (
        <section
          key={environmentId}
          className="space-y-2"
          data-testid="backup-machine"
          data-environment-id={environmentId}
        >
          <h3 className="flex items-center gap-1.5 font-label font-semibold text-[10px] text-on-surface-variant/70 uppercase tracking-widest">
            <Server size={11} aria-hidden="true" />
            {nameOf(environmentId)}
            <span className="font-normal normal-case tracking-normal text-on-surface-variant/50">
              {formatMessage(l.backups.usage, {
                count: String(sets.length),
                size: formatBytes(sets.reduce((total, set) => total + set.sizeBytes, 0)),
              })}
            </span>
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

      <p className="text-[11px] text-on-surface-variant/50">{l.backups.bulkHint}</p>
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
      className="space-y-2 rounded-xl border border-outline-variant/15 bg-surface-container-high p-3"
      data-testid="backup-row"
      data-backup-id={set.backupId}
      data-operation={set.operation}
      data-availability={set.availability}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
        <span className="text-on-surface" data-testid="backup-created">
          <span className="text-on-surface-variant/50">{l.backups.columnCreated} </span>
          {formatRelativeTime(set.createdAtMs, locale)}
        </span>
        {/*
          Only the machine knows what a set holds, so a row assembled from the
          hub's index omits the cell entirely. Printing "0 entries" there would
          state as fact the one thing an index row cannot know.
        */}
        {set.availability === 'available' && (
          <span className="text-on-surface" data-testid="backup-contents">
            <span className="text-on-surface-variant/50">{l.backups.columnContents} </span>
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
        <span className="text-on-surface-variant/70" data-testid="backup-size">
          <span className="text-on-surface-variant/50">{l.backups.columnSize} </span>
          {formatBytes(set.sizeBytes)}
        </span>
        <span className="text-on-surface-variant/70" data-testid="backup-origin">
          <span className="text-on-surface-variant/50">{l.backups.columnOrigin} </span>
          {l.backups.origin[set.operation]}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="break-all font-mono text-on-surface-variant/50">{set.backupId}</span>
        {set.pinned && (
          <span
            className="inline-flex items-center gap-1 text-tertiary"
            data-testid="backup-pinned"
          >
            <Pin size={11} />
            {l.backups.pinnedBadge}
          </span>
        )}
        {/*
          Retention evicts on the next apply, so a set is named before it goes
          rather than missed afterwards. Never both badges: a pinned set sits
          outside every automatic eviction path.
        */}
        {set.evictsNext && (
          <span
            className="inline-flex items-center gap-1 text-error"
            data-testid="backup-evicts-next"
            title={l.backups.evictsNextHint}
          >
            <Timer size={11} />
            {l.backups.evictsNext}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <button
          type="button"
          onClick={onRestore}
          disabled={restorePending || blockedReason !== null}
          className="inline-flex items-center gap-1 text-primary hover:underline disabled:opacity-50"
          data-testid="restore-backup"
          title={
            blockedReason ?? (set.operation === 'unknown' ? l.backups.undoUnknownHint : undefined)
          }
        >
          <Undo2 size={11} />
          {restorePending ? l.backups.restoring : undoLabel(set.operation, l.backups)}
        </button>

        {confirming ? (
          <span className="inline-flex items-center gap-2">
            <button
              type="button"
              onClick={onPurge}
              disabled={purgePending}
              className="inline-flex items-center gap-1 font-semibold text-error hover:underline disabled:opacity-50"
              data-testid="purge-backup-confirm"
            >
              <Trash2 size={11} />
              {l.backups.purgeConfirm}
            </button>
            <button
              type="button"
              onClick={onCancelConfirm}
              className="text-on-surface-variant/70 hover:underline"
              data-testid="purge-backup-cancel"
            >
              {l.backups.purgeCancel}
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={onConfirm}
            disabled={purgePending}
            className="inline-flex items-center gap-1 text-error hover:underline disabled:opacity-50"
            data-testid="purge-backup"
          >
            <Trash2 size={11} />
            {l.backups.purge}
          </button>
        )}

        {/*
          Restored and removed are counted apart, never summed into one "put
          back". Undoing a propagation set deletes the paths that apply created,
          and reporting that as content restored would describe a deletion as a
          recovery. A restore that touched nothing at all — every destination
          changed after the apply — also looks exactly like one that worked
          unless the counts are stated.
        */}
        {result && (
          <span className="text-on-surface-variant/70" data-testid="restore-backup-result">
            {formatMessage(l.result.undone, {
              restored: String(result.restored.length),
              removed: String(result.removed.length),
            })}
            {result.skipped.length > 0 &&
              ` ${formatMessage(l.result.undoSkipped, { count: String(result.skipped.length) })}`}
          </span>
        )}
        {restoreFailed && (
          <span className="text-error" data-testid="restore-backup-error">
            {l.backups.restoreError}
          </span>
        )}
        {/*
          A failed purge that says nothing is indistinguishable from one that
          worked, and the set is still on disk counting against the budget.
        */}
        {purgeFailed && (
          <span className="text-error" data-testid="purge-backup-error">
            {l.backups.purgeError}
          </span>
        )}
      </div>

      {blockedReason !== null && (
        <p className="text-[11px] text-on-surface-variant/70" data-testid="backup-unavailable">
          {blockedReason}
        </p>
      )}

      {set.operation === 'unknown' && blockedReason === null && (
        <p className="text-[11px] text-on-surface-variant/50" data-testid="backup-unknown-hint">
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
