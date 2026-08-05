/**
 * Step 1 — which copies go.
 *
 * Every location the preview looked at appears, including the ones with nothing
 * to remove: "there is no copy here" is an answer, and hiding the row leaves the
 * user wondering whether the location was even checked. Nothing is pre-checked,
 * because the safe state is keeping everything.
 *
 * Rows are grouped by machine for the same reason the destination step is: one
 * location label names a different directory on each machine, and a delete form
 * is the last place ambiguity about *where* belongs.
 */

import type {
  LibraryLocationId,
  RemovalLocation,
  RemovalPreview,
  RemovalPreviewEntry,
} from '@mangostudio/shared/library';
import { Server } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { formatRelativeTime, hashPrefix } from '../format';
import {
  eliminatesSelectedContentGroup,
  isRemovable,
  type RemovalDraft,
  removalKey,
} from '../removal';
import { BlockedReason } from './BlockedReason';

interface RemovalLocationStepProps {
  readonly preview: RemovalPreview;
  readonly draft: RemovalDraft;
  readonly environmentName: (environmentId: string) => string;
  readonly onToggle: (
    resourceKey: string,
    environmentId: string,
    locationId: LibraryLocationId
  ) => void;
}

/** Copies per machine, in the order the preview reported them. */
function byEnvironment(locations: readonly RemovalLocation[]): [string, RemovalLocation[]][] {
  const grouped = new Map<string, RemovalLocation[]>();
  for (const location of locations) {
    const existing = grouped.get(location.environmentId);
    if (existing) existing.push(location);
    else grouped.set(location.environmentId, [location]);
  }
  return [...grouped];
}

export function RemovalLocationStep({
  preview,
  draft,
  environmentName,
  onToggle,
}: RemovalLocationStepProps) {
  const { t } = useI18n();
  const l = t.library;

  return (
    <div className="space-y-4" data-testid="removal-location-step">
      <p className="text-on-surface text-sm">{l.removal.locationsDescription}</p>

      {preview.staleStagedRemovals.length > 0 && (
        <div
          className="space-y-1 rounded-lg border border-tertiary/30 bg-tertiary/5 p-3"
          data-testid="stale-staged-removals"
        >
          <p className="text-tertiary text-xs">{l.removal.staleStaged}</p>
          <ul className="space-y-0.5">
            {preview.staleStagedRemovals.map((leftover) => (
              <li
                key={`${leftover.environmentId}:${leftover.path}`}
                className="break-all font-mono text-[11px] text-on-surface-variant/70"
              >
                {environmentName(leftover.environmentId)} · {leftover.path}
              </li>
            ))}
          </ul>
        </div>
      )}

      {preview.entries.map((entry) => (
        <section key={entry.resourceKey} className="space-y-1.5" data-testid="removal-entry">
          <h3 className="font-label font-semibold text-[10px] text-on-surface-variant/70 uppercase tracking-widest">
            {entry.resourceKey}
          </h3>
          {entry.locations.length === 0 ? (
            <p className="text-on-surface-variant text-xs">{l.removal.noLocations}</p>
          ) : (
            byEnvironment(entry.locations).map(([environmentId, locations]) => (
              <div
                key={environmentId}
                className="space-y-1.5"
                data-testid="removal-machine"
                data-environment-id={environmentId}
              >
                <p className="flex items-center gap-1.5 font-semibold text-on-surface text-xs">
                  <Server size={11} aria-hidden="true" />
                  {environmentName(environmentId)}
                </p>
                {locations.map((location) => (
                  <RemovalRow
                    key={`${location.environmentId}:${location.locationId}`}
                    entry={entry}
                    location={location}
                    draft={draft}
                    onToggle={onToggle}
                  />
                ))}
              </div>
            ))
          )}
        </section>
      ))}
    </div>
  );
}

function RemovalRow({
  entry,
  location,
  draft,
  onToggle,
}: {
  readonly entry: RemovalPreviewEntry;
  readonly location: RemovalLocation;
  readonly draft: RemovalDraft;
  readonly onToggle: (
    resourceKey: string,
    environmentId: string,
    locationId: LibraryLocationId
  ) => void;
}) {
  const { t, locale } = useI18n();
  const l = t.library;
  const removable = isRemovable(location);
  const checked = draft.removing.has(
    removalKey(entry.resourceKey, location.environmentId, location.locationId)
  );
  const eliminatesGroup = eliminatesSelectedContentGroup(entry, location, draft);

  return (
    <label
      className={`flex items-start gap-2 rounded-lg border p-2.5 ${
        removable
          ? 'cursor-pointer border-outline-variant/15 bg-surface-container-high'
          : 'cursor-not-allowed border-outline-variant/10 bg-surface-container/40 opacity-70'
      }`}
      data-testid="removal-row"
      data-environment-id={location.environmentId}
      data-location-id={location.locationId}
      data-operation={location.operation}
    >
      <input
        type="checkbox"
        checked={checked && removable}
        // Nothing else can be removed here, and the apply route rejects the
        // attempt outright, so the control is disabled rather than merely warned about.
        disabled={!removable}
        onChange={() => onToggle(entry.resourceKey, location.environmentId, location.locationId)}
        className="mt-0.5 size-3.5 accent-error"
      />
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="block break-all font-mono text-on-surface text-xs">
          {location.path ?? location.locationId}
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-on-surface-variant/60">
          {location.contentHash && (
            <span>
              {formatMessage(l.removal.version, {
                hash: `${hashPrefix(location.contentHash)}…`,
              })}
            </span>
          )}
          {location.modifiedAtMs !== undefined && (
            <span>
              {formatMessage(l.detail.modified, {
                when: formatRelativeTime(location.modifiedAtMs, locale),
              })}
            </span>
          )}
          {location.operation === 'absent' && <span>{l.removal.absent}</span>}
        </span>

        {/*
          Divergent copies are not interchangeable, and the minority version is
          often the newest work. Saying so is the whole point of the row.
        */}
        {eliminatesGroup && checked && removable && (
          <span className="block text-[11px] text-tertiary" data-testid="eliminates-group">
            {formatMessage(l.removal.eliminatesGroup, {
              hash: `${hashPrefix(location.contentHash ?? '')}…`,
            })}
          </span>
        )}

        {location.blockedReason && (
          <span className="block">
            <BlockedReason reason={location.blockedReason} />
          </span>
        )}
      </span>
    </label>
  );
}
