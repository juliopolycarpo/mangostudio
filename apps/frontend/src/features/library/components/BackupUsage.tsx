/**
 * What retained propagation and removal backups currently cost on disk.
 *
 * A directory quietly holding copies of skill trees should never be a mystery
 * disk consumer the user has to discover, so the size and the retention rule
 * sit in plain sight rather than in a settings screen nobody opens.
 *
 * Summary only. The sets themselves — what each holds, what wrote it, and the
 * way back from it — need columns a strip pinned under the coverage matrix
 * cannot carry, so they live at `/library/backups` and this line is the way in.
 * Listing them here instead would put the widest row in the app inside a
 * footnote.
 */

import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowRight } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { formatBytes } from '../format';
import { backupUsageQueryOptions } from '../queries';

export function BackupUsage() {
  const { t } = useI18n();
  const l = t.library;
  const query = useQuery(backupUsageQueryOptions());
  const usage = query.data;

  // Nothing retained is nothing to disclose; a zero row is just noise, and a
  // link to an empty manager is a worse invitation than no link.
  if (!usage || usage.setCount === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="backup-usage">
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
      <Link
        to="/library/backups"
        className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
        data-testid="manage-backups"
      >
        {l.backups.manage}
        <ArrowRight size={11} />
      </Link>
    </div>
  );
}
