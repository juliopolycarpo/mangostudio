import type {
  LibraryCoverage,
  LibraryInstance,
  LibraryResourceRef,
} from '@mangostudio/shared/library';
import { LIBRARY_TARGET_DEFINITIONS } from '@mangostudio/shared/library';

export function resolveLibraryCoverage(
  ref: LibraryResourceRef,
  instances: readonly LibraryInstance[]
): LibraryCoverage[] {
  const presentLocationIds = new Set(instances.map((instance) => instance.locationId));

  return LIBRARY_TARGET_DEFINITIONS.map((target) => {
    const present = target.reads[ref.kind].filter((id) => presentLocationIds.has(id));
    if (present.length === 0) {
      return {
        targetId: target.id,
        state: 'absent',
        shadowedLocationIds: [],
      };
    }

    const [effectiveLocationId, ...shadowedLocationIds] = present;
    return {
      targetId: target.id,
      state: shadowedLocationIds.length > 0 ? 'shadowed' : 'present',
      effectiveLocationId,
      shadowedLocationIds,
    };
  });
}
