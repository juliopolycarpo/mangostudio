/**
 * What retained propagation backups currently cost on disk.
 *
 * A directory quietly holding copies of skill trees should never be a mystery
 * disk consumer the user has to discover, so the size and the retention rule
 * sit in plain sight rather than in a settings screen nobody opens.
 */

import { useQuery } from '@tanstack/react-query';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { formatBytes } from '../format';
import { backupUsageQueryOptions } from '../queries';

export function BackupUsage() {
  const { t } = useI18n();
  const l = t.library;
  const query = useQuery(backupUsageQueryOptions());
  const usage = query.data;

  // Nothing retained is nothing to disclose; a zero row is just noise.
  if (!usage || usage.setCount === 0) return null;

  return (
    <p className="text-[11px] text-on-surface-variant/60" data-testid="backup-usage">
      {formatMessage(l.backups.usage, {
        count: String(usage.setCount),
        size: formatBytes(usage.sizeBytes),
      })}{' '}
      {formatMessage(l.backups.retention, {
        count: String(usage.retentionCount),
        size: formatBytes(usage.retentionBytes),
      })}
    </p>
  );
}
