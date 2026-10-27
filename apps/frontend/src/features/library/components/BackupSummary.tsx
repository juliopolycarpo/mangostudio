/**
 * The one sentence every backup surface leads with: how many sets the app is
 * holding and what they cost, then the rule that trims them.
 *
 * The strip under the matrix and the manager's header both state it, so it is
 * assembled here and nowhere else: the singular form, the byte formatting and
 * the order of the two halves cannot drift between the two.
 */

import type { Messages } from '@mangostudio/shared/i18n';
import type { PropagationBackupUsage } from '@mangostudio/shared/library';

import { formatBytes } from '@/features/environments/format';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { cn } from '@/lib/utils';

/** "3 backups using 4 KiB." — with its own singular, since the repo has no plural rules. */
export function formatBackupUsage(
  labels: Messages['library']['backups'],
  count: number,
  sizeBytes: number
): string {
  const size = formatBytes(sizeBytes);
  return count === 1
    ? formatMessage(labels.usageOne, { size })
    : formatMessage(labels.usage, { count: String(count), size });
}

interface BackupSummaryProps {
  readonly usage: Pick<
    PropagationBackupUsage,
    'setCount' | 'sizeBytes' | 'retentionCount' | 'retentionBytes'
  >;
  /** Adds that the bounds apply to each machine on its own, for the page that groups by machine. */
  readonly perMachine?: boolean;
  readonly className?: string;
}

export function BackupSummary({ usage, perMachine = false, className }: BackupSummaryProps) {
  const { t } = useI18n();
  const labels = t.library.backups;

  return (
    <p className={cn('text-fg-muted text-xs', className)}>
      {formatBackupUsage(labels, usage.setCount, usage.sizeBytes)}{' '}
      {formatMessage(labels.retention, {
        count: String(usage.retentionCount),
        size: formatBytes(usage.retentionBytes),
      })}
      {perMachine ? ` ${labels.retentionPerMachine}` : null}
    </p>
  );
}
