/**
 * Why a write cannot happen, in a sentence.
 *
 * The API returns a stable code and never free text, so the translation is
 * where the consequence gets stated — which also means a code added to the
 * contract before its wording lands must degrade to the code itself rather
 * than a blank line.
 */

import type { PropagationBlockedReason, RemovalBlockedReason } from '@mangostudio/shared/library';
import { Ban } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';

export function BlockedReason({
  reason,
  action,
}: {
  /** Both flows block for mostly the same reasons, and read the same catalog. */
  readonly reason: PropagationBlockedReason | RemovalBlockedReason;
  readonly action?: React.ReactNode;
}) {
  const { t } = useI18n();
  const messages = t.library.blockedReason as Record<string, string | undefined>;

  return (
    <span
      className="inline-flex items-center gap-1.5 text-fg-muted text-xs"
      data-testid="blocked-reason"
      data-reason={reason}
    >
      <Ban size={ICON_SM} aria-hidden="true" className="shrink-0 text-danger" />
      <span>{messages[reason] ?? reason}</span>
      {action}
    </span>
  );
}
