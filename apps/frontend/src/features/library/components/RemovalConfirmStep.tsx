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

import { Callout } from '@/components/ui/Callout';
import { Checkbox } from '@/components/ui/Checkbox';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_MD } from '@/lib/icon-sizes';

import { hashPrefix, resourceKeyLabel } from '../format';
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
      <p className="text-fg text-sm">
        {formatMessage(l.removal.confirmDescription, { count: String(planned.length) })}
      </p>

      <ul className="space-y-2">
        {planned.map(({ entry, location }) => (
          <li key={`${entry.resourceKey}:${location.locationId}`} data-testid="removal-summary-row">
            <span className="block text-fg text-sm">
              {resourceKeyLabel(entry.resourceKey, l.kinds)}
            </span>
            <span className="block break-all font-mono text-fg-muted text-micro">
              {location.path ?? location.locationId}
            </span>
          </li>
        ))}
      </ul>

      {eliminated.length > 0 && (
        <Callout tone="info" title={l.removal.eliminatesGroupHeading}>
          <ul className="space-y-0.5 text-xs">
            {eliminated.map(({ entry, location }) => (
              <li key={`${entry.resourceKey}:${location.locationId}`}>
                {formatMessage(l.removal.eliminatesGroupRow, {
                  resource: resourceKeyLabel(entry.resourceKey, l.kinds),
                  location: location.path ?? location.locationId,
                  hash: `${hashPrefix(location.contentHash ?? '')}…`,
                })}
              </li>
            ))}
          </ul>
        </Callout>
      )}

      {lastCopies.length > 0 && (
        <Callout
          tone="danger"
          icon={<TriangleAlert size={ICON_MD} />}
          title={l.removal.lastCopyWarning}
          data-testid="last-copy-acknowledgement"
        >
          <div className="space-y-2 pt-1">
            {lastCopies.map((entry) => (
              <label
                key={entry.resourceKey}
                className="flex cursor-pointer items-center gap-2 text-fg text-sm"
                data-testid="last-copy-row"
                data-resource-key={entry.resourceKey}
              >
                <Checkbox
                  checked={draft.acknowledged.has(entry.resourceKey)}
                  onChange={() => onToggleAcknowledgement(entry.resourceKey)}
                />
                <span>
                  {formatMessage(l.removal.lastCopyAcknowledge, {
                    resource: resourceKeyLabel(entry.resourceKey, l.kindsInline),
                  })}
                </span>
              </label>
            ))}
          </div>
        </Callout>
      )}

      <p className="text-fg-muted text-xs">{l.removal.backupNote}</p>
    </div>
  );
}
