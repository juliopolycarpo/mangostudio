/**
 * Why a write cannot happen, in a sentence.
 *
 * The API returns a stable code and never free text, so the translation is
 * where the consequence gets stated — which also means a code added to the
 * contract before its wording lands must degrade to the code itself rather
 * than a blank line.
 */

import type { PropagationBlockedReason } from '@mangostudio/shared/library';
import { Ban } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';

export function BlockedReason({
  reason,
  action,
}: {
  readonly reason: PropagationBlockedReason;
  readonly action?: React.ReactNode;
}) {
  const { t } = useI18n();
  const messages = t.library.blockedReason as Record<string, string | undefined>;

  return (
    <span
      className="inline-flex items-center gap-1.5 text-[11px] text-on-surface-variant/70"
      data-testid="blocked-reason"
      data-reason={reason}
    >
      <Ban size={11} className="shrink-0 text-error/70" />
      <span>{messages[reason] ?? reason}</span>
      {action}
    </span>
  );
}
