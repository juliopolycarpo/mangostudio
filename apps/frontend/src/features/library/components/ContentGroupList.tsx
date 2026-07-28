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
    <ul className="space-y-1.5" data-testid="content-group-list">
      {groups.map((group) => {
        const locations = group.locationIds
          .map((locationId) => locationLabel?.(locationId) ?? locationId)
          .join(', ');
        const body = (
          <>
            <span className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono font-semibold text-on-surface text-xs">
                {hashPrefix(group.contentHash)}…
              </span>
              <span className="text-[11px] text-on-surface-variant/70">{renderMeta(group)}</span>
            </span>
            <span className="mt-0.5 block break-all text-[11px] text-on-surface-variant/60">
              {locations}
            </span>
          </>
        );

        if (!onSelect) {
          return (
            <li
              key={group.contentHash}
              className="rounded-lg border border-outline-variant/15 bg-surface-container-high p-2.5"
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
            <label
              className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 transition-colors ${
                selectedHash === group.contentHash
                  ? 'border-primary bg-primary/5'
                  : 'border-outline-variant/15 bg-surface-container-high hover:border-outline-variant/30'
              }`}
            >
              <input
                type="radio"
                name={`group:${group.locationIds.join('|')}`}
                checked={selectedHash === group.contentHash}
                onChange={() => onSelect(group.contentHash)}
                aria-label={l.conflict.adopt}
                data-testid="adopt-group"
                className="mt-0.5 size-3.5 accent-primary"
              />
              <span className="min-w-0 flex-1">{body}</span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
