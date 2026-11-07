import type {
  LibraryCoverage,
  LibraryInstance,
  LibraryLocationId,
  LibraryResourceRef,
} from '@mangostudio/shared/library';
import { LIBRARY_TARGET_DEFINITIONS } from '@mangostudio/shared/library/host';

/**
 * Resolves observed coverage in each target's precedence order.
 *
 * @example
 * resolveLibraryCoverage(resource.ref, resource.instances, failedLocations);
 */
export function resolveLibraryCoverage(
  ref: LibraryResourceRef,
  instances: readonly LibraryInstance[],
  failedLocations?: ReadonlySet<LibraryLocationId>
): LibraryCoverage[] {
  const presentLocationIds = new Set(instances.map((instance) => instance.locationId));

  return LIBRARY_TARGET_DEFINITIONS.map((target) => {
    const locations = target.reads[ref.kind];
    const present = locations.filter((id) => presentLocationIds.has(id));
    const unscanned = failedLocations && locations.filter((id) => failedLocations.has(id));
    const base = {
      targetId: target.id,
      ...(unscanned?.length && { unscannedLocationIds: unscanned }),
    };
    if (present.length === 0) {
      return {
        ...base,
        state: 'absent',
        shadowedLocationIds: [],
      };
    }

    const [effectiveLocationId, ...shadowedLocationIds] = present;
    const effectiveIsUncertain =
      unscanned?.length &&
      locations
        .slice(0, locations.indexOf(effectiveLocationId))
        .some((id) => unscanned.includes(id));
    return {
      ...base,
      state: shadowedLocationIds.length > 0 ? 'shadowed' : 'present',
      ...(effectiveIsUncertain ? {} : { effectiveLocationId }),
      shadowedLocationIds: effectiveIsUncertain ? [] : shadowedLocationIds,
    };
  });
}
