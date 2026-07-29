/**
 * Pure removal-wizard logic: which copies the user has marked to go, whether
 * that is enough to submit, and the payload it turns into.
 *
 * The whole file is written around one asymmetry with propagation. Nothing is
 * checked by default and nothing is ever checked *for* the user, because the
 * safe state here is "keep everything" — a pre-checked destructive form makes
 * the dangerous path the one that requires no effort.
 */

import type {
  LibraryLocationId,
  RemovalDecision,
  RemovalLocation,
  RemovalPreview,
  RemovalPreviewEntry,
} from '@mangostudio/shared/library';

export type RemovalStep = 'locations' | 'confirm' | 'result';

export interface RemovalDraft {
  /** Copies marked to go, keyed by `removalKey`. */
  readonly removing: ReadonlySet<string>;
  /** Resource keys whose final copy the user has explicitly signed off on. */
  readonly acknowledged: ReadonlySet<string>;
}

/** Identity of one planned removal: one resource leaving one location. */
export function removalKey(resourceKey: string, locationId: LibraryLocationId): string {
  return `${resourceKey} ${locationId}`;
}

export function initialRemovalDraft(): RemovalDraft {
  return { removing: new Set(), acknowledged: new Set() };
}

export function isRemovable(location: RemovalLocation): boolean {
  return location.operation === 'remove';
}

/** Every copy the user has marked, ignoring anything the API would refuse. */
export function plannedRemovals(
  preview: RemovalPreview,
  draft: RemovalDraft
): { entry: RemovalPreviewEntry; location: RemovalLocation }[] {
  return preview.entries.flatMap((entry) =>
    entry.locations
      .filter(
        (location) =>
          isRemovable(location) &&
          draft.removing.has(removalKey(entry.resourceKey, location.locationId))
      )
      .map((location) => ({ entry, location }))
  );
}

/**
 * Resources the current selection would leave with no copy anywhere.
 *
 * Decided against `instanceLocationIds` — every location holding a copy,
 * including ones this preview does not offer — rather than against the rows on
 * screen, which is the same rule the API applies. A wizard that decided it from
 * the visible rows would ask for an acknowledgement the API does not want, or
 * worse, fail to ask for one it does.
 */
export function lastCopyEntries(
  preview: RemovalPreview,
  draft: RemovalDraft
): RemovalPreviewEntry[] {
  return preview.entries.filter((entry) => {
    if (entry.instanceLocationIds.length === 0) return false;
    return entry.instanceLocationIds.every((locationId) =>
      draft.removing.has(removalKey(entry.resourceKey, locationId))
    );
  });
}

/** Last-copy removals still waiting for their sign-off; non-empty blocks the apply. */
export function pendingAcknowledgements(
  preview: RemovalPreview,
  draft: RemovalDraft
): RemovalPreviewEntry[] {
  return lastCopyEntries(preview, draft).filter(
    (entry) => !draft.acknowledged.has(entry.resourceKey)
  );
}

/**
 * Marked copies that would take the only copy of their version with them.
 *
 * Never a block. Resolving a divergence by deleting the copy you do not want is
 * legitimate — arguably the most common resolution — and the user only needs to
 * know which of the two things they are doing.
 */
export function eliminatedGroups(
  preview: RemovalPreview,
  draft: RemovalDraft
): { entry: RemovalPreviewEntry; location: RemovalLocation }[] {
  return plannedRemovals(preview, draft).filter(({ location }) => location.eliminatesContentGroup);
}

/** True when nothing is marked, so submitting would remove nothing. */
export function isEmptySelection(preview: RemovalPreview, draft: RemovalDraft): boolean {
  return plannedRemovals(preview, draft).length === 0;
}

/**
 * Turns the draft into the apply payload. Every location the preview offered
 * comes back explicitly removed or kept — a dropped one would leave the
 * response silent about somewhere the user was shown — and anything the preview
 * did not classify removable is kept whatever the checkbox says.
 */
export function buildRemovalDecisions(
  preview: RemovalPreview,
  draft: RemovalDraft
): RemovalDecision[] {
  return preview.entries.map((entry) => ({
    resourceKey: entry.resourceKey,
    locations: entry.locations.map((location) => ({
      locationId: location.locationId,
      action:
        isRemovable(location) &&
        draft.removing.has(removalKey(entry.resourceKey, location.locationId))
          ? ('remove' as const)
          : ('keep' as const),
    })),
  }));
}

/**
 * The acknowledgements to send: only for resources this selection actually
 * zeroes. A stale sign-off for a resource the user has since unchecked would be
 * rejected by the API, and rightly so.
 */
export function acknowledgedLastCopyKeys(preview: RemovalPreview, draft: RemovalDraft): string[] {
  return lastCopyEntries(preview, draft)
    .filter((entry) => draft.acknowledged.has(entry.resourceKey))
    .map((entry) => entry.resourceKey);
}
