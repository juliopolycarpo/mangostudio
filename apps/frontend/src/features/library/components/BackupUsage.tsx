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
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { purgeBackup } from '../api';
import { formatBytes } from '../format';
import { backupUsageQueryOptions, libraryKeys } from '../queries';

export function BackupUsage() {
  const { t } = useI18n();
  const l = t.library;
  const queryClient = useQueryClient();
  const query = useQuery(backupUsageQueryOptions());
  const purge = useMutation({
    mutationFn: (backupId: string) => purgeBackup(backupId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: libraryKeys.backups() }),
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
                  onClick={() => purge.mutate(set.backupId)}
                  disabled={purge.isPending}
                  className="inline-flex items-center gap-1 text-error hover:underline disabled:opacity-50"
                  data-testid="purge-backup"
                >
                  <Trash2 size={11} />
                  {l.backups.purge}
                </button>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-on-surface-variant/50">{l.backups.pinnedHint}</p>
        </div>
      )}
    </div>
  );
}
