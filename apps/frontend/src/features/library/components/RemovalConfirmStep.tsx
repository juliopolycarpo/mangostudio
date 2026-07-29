/**
 * Step 2 — what is about to be deleted, and the one sign-off that is not a
 * per-location checkbox.
 *
 * Removing your only copy of a skill you wrote is recoverable through the
 * backup and nothing else. That is a different category of action from removing
 * a duplicate, so it gets its own acknowledgement rather than being folded into
 * the same list of checkboxes that removed the duplicates.
 */

import type { RemovalPreview } from '@mangostudio/shared/library';
import { TriangleAlert } from 'lucide-react';
import { useMemo } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { hashPrefix } from '../format';
import { eliminatedGroups, lastCopyEntries, plannedRemovals, type RemovalDraft } from '../removal';

interface RemovalConfirmStepProps {
  readonly preview: RemovalPreview;
  readonly draft: RemovalDraft;
  readonly onToggleAcknowledgement: (resourceKey: string) => void;
}

export function RemovalConfirmStep({
  preview,
  draft,
  onToggleAcknowledgement,
}: RemovalConfirmStepProps) {
  const { t } = useI18n();
  const l = t.library;

  const planned = useMemo(() => plannedRemovals(preview, draft), [preview, draft]);
  const lastCopies = useMemo(() => lastCopyEntries(preview, draft), [preview, draft]);
  const eliminated = useMemo(() => eliminatedGroups(preview, draft), [preview, draft]);

  return (
    <div className="space-y-4" data-testid="removal-confirm-step">
      <p className="text-on-surface text-sm">
        {formatMessage(l.removal.confirmDescription, { count: String(planned.length) })}
      </p>

      <ul className="space-y-1">
        {planned.map(({ entry, location }) => (
          <li
            key={`${entry.resourceKey}:${location.locationId}`}
            className="text-xs"
            data-testid="removal-summary-row"
          >
            <span className="text-on-surface">{entry.resourceKey}</span>
            <span className="block break-all font-mono text-[11px] text-on-surface-variant/60">
              {location.path ?? location.locationId}
            </span>
          </li>
        ))}
      </ul>

      {eliminated.length > 0 && (
        <div className="space-y-1 rounded-lg border border-tertiary/30 bg-tertiary/5 p-3">
          <p className="text-tertiary text-xs">{l.removal.eliminatesGroupHeading}</p>
          <ul className="space-y-0.5">
            {eliminated.map(({ entry, location }) => (
              <li
                key={`${entry.resourceKey}:${location.locationId}`}
                className="text-[11px] text-on-surface-variant/70"
              >
                {formatMessage(l.removal.eliminatesGroupRow, {
                  resource: entry.resourceKey,
                  location: location.path ?? location.locationId,
                  hash: `${hashPrefix(location.contentHash ?? '')}…`,
                })}
              </li>
            ))}
          </ul>
        </div>
      )}

      {lastCopies.length > 0 && (
        <div
          className="space-y-2 rounded-lg border border-error/30 bg-error/5 p-3"
          data-testid="last-copy-acknowledgement"
        >
          <p className="flex items-start gap-2 text-error text-xs">
            <TriangleAlert size={14} className="mt-0.5 shrink-0" />
            {l.removal.lastCopyWarning}
          </p>
          {lastCopies.map((entry) => (
            <label
              key={entry.resourceKey}
              className="flex cursor-pointer items-start gap-2 text-xs"
              data-testid="last-copy-row"
              data-resource-key={entry.resourceKey}
            >
              <input
                type="checkbox"
                checked={draft.acknowledged.has(entry.resourceKey)}
                onChange={() => onToggleAcknowledgement(entry.resourceKey)}
                className="mt-0.5 size-3.5 accent-error"
              />
              <span className="text-on-surface">
                {formatMessage(l.removal.lastCopyAcknowledge, { resource: entry.resourceKey })}
              </span>
            </label>
          ))}
        </div>
      )}

      <p className="text-[11px] text-on-surface-variant/60">{l.removal.backupNote}</p>
    </div>
  );
}
