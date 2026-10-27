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
import { ICON_SM } from '@/lib/icon-sizes';

import { backupUsageQueryOptions } from '../queries';
import { BackupSummary } from './BackupSummary';

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
      <BackupSummary usage={usage} />
      <Link
        to="/environments/library/backups"
        className="inline-flex items-center gap-1 text-accent-fg text-xs hover:underline"
        data-testid="manage-backups"
      >
        {l.backups.manage}
        <ArrowRight size={ICON_SM} aria-hidden="true" />
      </Link>
    </div>
  );
}
