/**
 * What retained propagation and removal backups currently cost on disk.
 *
 * A directory quietly holding copies of skill trees should never be a mystery
 * disk consumer the user has to discover, so the size and the retention rule
 * sit in plain sight rather than in a settings screen nobody opens.
 *
 * Pinned sets get their own list. Nothing evicts them — each holds the last
 * remaining copy of something — so without a way to see and purge them the
 * answer to "why is this directory large" would be missing exactly where it
 * matters most.
 *
 * Each row offers both ways out, because the wizard's own undo button is gone
 * the moment the wizard closes. A set that can only be deleted is a copy of
 * someone's skill that the app will hold onto and never hand back.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { purgeBackup, undoPropagation } from '../api';
import { formatBytes } from '../format';
import { backupUsageQueryOptions, libraryKeys } from '../queries';

export function BackupUsage() {
  const { t } = useI18n();
  const l = t.library;
  const queryClient = useQueryClient();
  const query = useQuery(backupUsageQueryOptions());
  // A pinned set is the last remaining copy of something, and the purge is not
  // undoable by anything. One stray click must not be the whole interaction —
  // the removal that created this set demanded an explicit acknowledgement, and
  // destroying its only backup deserves no less.
  const [confirming, setConfirming] = useState<string | null>(null);
  const purge = useMutation({
    mutationFn: (backupId: string) => purgeBackup(backupId),
    onSettled: () => setConfirming(null),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: libraryKeys.backups() }),
  });
  // Restore needs no confirmation to match the purge: it puts content back and
  // refuses any destination that changed since the apply, so the worst outcome
  // is a no-op the row reports. Restoring does not consume the set — the copy
  // stays retained until the user purges it.
  const restore = useMutation({
    mutationFn: (backupId: string) => undoPropagation(backupId),
    // The resource is on disk again, so the matrix that said it was gone is
    // now wrong; the set's own size and pinning can move with it.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: libraryKeys.all }),
  });
  const usage = query.data;

  // Nothing retained is nothing to disclose; a zero row is just noise.
  if (!usage || usage.setCount === 0) return null;

  const pinned = usage.sets.filter((set) => set.pinned);

  return (
    <div className="space-y-1.5" data-testid="backup-usage">
      <p className="text-[11px] text-on-surface-variant/60">
        {formatMessage(l.backups.usage, {
          count: String(usage.setCount),
          size: formatBytes(usage.sizeBytes),
        })}{' '}
        {formatMessage(l.backups.retention, {
          count: String(usage.retentionCount),
          size: formatBytes(usage.retentionBytes),
        })}
      </p>

      {pinned.length > 0 && (
        <div className="space-y-1" data-testid="pinned-backups">
          <p className="text-[11px] text-tertiary">
            {formatMessage(l.backups.pinned, {
              count: String(pinned.length),
              size: formatBytes(usage.pinnedSizeBytes),
            })}
          </p>
          <ul className="space-y-1">
            {pinned.map((set) => (
              <li
                key={set.backupId}
                className="flex flex-wrap items-center gap-2 text-[11px]"
                data-testid="pinned-backup-row"
              >
                <span className="break-all font-mono text-on-surface-variant/70">
                  {set.backupId}
                </span>
                <span className="text-on-surface-variant/60">{formatBytes(set.sizeBytes)}</span>
                {set.lastCopyResourceKeys.length > 0 && (
                  <span className="text-on-surface-variant/60">
                    {set.lastCopyResourceKeys.join(', ')}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => restore.mutate(set.backupId)}
                  disabled={restore.isPending}
                  className="inline-flex items-center gap-1 text-primary hover:underline disabled:opacity-50"
                  data-testid="restore-backup"
                >
                  <Undo2 size={11} />
                  {restore.isPending && restore.variables === set.backupId
                    ? l.backups.restoring
                    : l.backups.restore}
                </button>
                {confirming === set.backupId ? (
                  <span className="inline-flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => purge.mutate(set.backupId)}
                      disabled={purge.isPending}
                      className="inline-flex items-center gap-1 font-semibold text-error hover:underline disabled:opacity-50"
                      data-testid="purge-backup-confirm"
                    >
                      <Trash2 size={11} />
                      {l.backups.purgeConfirm}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirming(null)}
                      className="text-on-surface-variant/70 hover:underline"
                      data-testid="purge-backup-cancel"
                    >
                      {l.backups.purgeCancel}
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirming(set.backupId)}
                    disabled={purge.isPending}
                    className="inline-flex items-center gap-1 text-error hover:underline disabled:opacity-50"
                    data-testid="purge-backup"
                  >
                    <Trash2 size={11} />
                    {l.backups.purge}
                  </button>
                )}
                {/*
                  Keyed to the row that was actually purged. A failed purge that
                  says nothing is indistinguishable from one that worked, and the
                  set is still on disk counting against the retention budget.
                */}
                {purge.isError && purge.variables === set.backupId && (
                  <span className="text-error" data-testid="purge-backup-error">
                    {l.backups.purgeError}
                  </span>
                )}
                {/*
                  Keyed to the row the manifest names, not to the last row
                  clicked. A restore that put nothing back — every destination
                  changed after the removal — looks exactly like one that worked
                  unless the count is stated.
                */}
                {restore.data?.backupId === set.backupId && (
                  <span className="text-on-surface-variant/70" data-testid="restore-backup-result">
                    {formatMessage(l.backups.restored, {
                      count: String(restore.data.restored.length),
                    })}
                    {restore.data.skipped.length > 0 &&
                      ` ${formatMessage(l.result.undoSkipped, {
                        count: String(restore.data.skipped.length),
                      })}`}
                  </span>
                )}
                {restore.isError && restore.variables === set.backupId && (
                  <span className="text-error" data-testid="restore-backup-error">
                    {l.backups.restoreError}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-on-surface-variant/50">{l.backups.pinnedHint}</p>
        </div>
      )}
    </div>
  );
}
