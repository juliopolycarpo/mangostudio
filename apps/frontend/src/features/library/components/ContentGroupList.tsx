/**
 * The distinct versions of a resource, most-replicated first.
 *
 * Content groups come before coverage on every screen that shows both, because
 * with no source of truth the first question is "what are my options?" — and
 * `modified` sits next to the replication count precisely because the newest
 * version is often the minority one.
 */

import type { LibraryLocationId, PropagationSourceGroup } from '@mangostudio/shared/library';
import { useI18n } from '@/hooks/use-i18n';
import { hashPrefix } from '../format';
import { ChoiceRow } from './ChoiceRow';

interface ContentGroupListProps {
  readonly groups: readonly PropagationSourceGroup[];
  readonly selectedHash?: string;
  readonly onSelect?: (contentHash: string) => void;
  readonly renderMeta: (group: PropagationSourceGroup) => string;
  readonly locationLabel?: (locationId: LibraryLocationId) => string;
}

export function ContentGroupList({
  groups,
  selectedHash,
  onSelect,
  renderMeta,
  locationLabel,
}: ContentGroupListProps) {
  const { t } = useI18n();
  const l = t.library;

  return (
    <ul className={onSelect ? 'space-y-1' : 'space-y-2'} data-testid="content-group-list">
      {groups.map((group) => {
        const locations = group.locationIds
          .map((locationId) => locationLabel?.(locationId) ?? locationId)
          .join(', ');
        const body = (
          <>
            <span className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium font-mono text-fg text-xs">
                {hashPrefix(group.contentHash)}…
              </span>
              <span className="text-fg-muted text-xs">{renderMeta(group)}</span>
            </span>
            <span className="mt-0.5 block break-all font-mono text-fg-muted text-micro">
              {locations}
            </span>
          </>
        );

        if (!onSelect) {
          return (
            <li
              key={group.contentHash}
              className="rounded-md border border-stroke bg-surface px-3 py-2"
              data-testid="content-group"
              data-content-hash={group.contentHash}
            >
              {body}
            </li>
          );
        }

        return (
          <li
            key={group.contentHash}
            data-testid="content-group"
            data-content-hash={group.contentHash}
          >
            <ChoiceRow
              control="radio"
              name={`group:${group.locationIds.join('|')}`}
              checked={selectedHash === group.contentHash}
              onChange={() => onSelect(group.contentHash)}
              aria-label={l.conflict.adopt}
              data-testid="adopt-group"
            >
              {body}
            </ChoiceRow>
          </li>
        );
      })}
    </ul>
  );
}
