import type {
  LibraryContentGroup,
  LibraryDivergence,
  LibraryInstance,
  ResourceKind,
} from '@mangostudio/shared/library';
import { COMPARABLE_RESOURCE_KINDS } from '@mangostudio/shared/library/host';

export interface InstanceComparison {
  readonly instance: LibraryInstance;
  readonly whitespaceHash?: string;
}

export interface DivergenceResult {
  readonly divergence: LibraryDivergence;
  readonly contentGroups: LibraryContentGroup[];
  readonly whitespaceOnlyDivergence: boolean;
}

export function describeDivergence(
  kind: ResourceKind,
  instances: readonly InstanceComparison[]
): DivergenceResult {
  const byHash = new Map<string, string[]>();
  for (const { instance } of instances) {
    if (!instance.contentHash) continue;
    const locationIds = byHash.get(instance.contentHash) ?? [];
    locationIds.push(instance.locationId);
    byHash.set(instance.contentHash, locationIds);
  }

  const contentGroups = Array.from(byHash, ([contentHash, locationIds]) => ({
    contentHash,
    locationIds: locationIds.sort(),
    instanceCount: locationIds.length,
  })).sort(
    (left, right) =>
      right.instanceCount - left.instanceCount || left.contentHash.localeCompare(right.contentHash)
  );

  if (!COMPARABLE_RESOURCE_KINDS.has(kind)) {
    return { divergence: 'not-comparable', contentGroups, whitespaceOnlyDivergence: false };
  }

  const comparableInstanceCount = contentGroups.reduce(
    (count, group) => count + group.instanceCount,
    0
  );
  const divergence =
    comparableInstanceCount <= 1 ? 'single' : contentGroups.length === 1 ? 'uniform' : 'divergent';
  const whitespaceHashes = new Set(
    instances.flatMap(({ whitespaceHash }) => (whitespaceHash ? [whitespaceHash] : []))
  );

  return {
    divergence,
    contentGroups,
    whitespaceOnlyDivergence:
      divergence === 'divergent' &&
      whitespaceHashes.size === 1 &&
      instances.every(({ whitespaceHash }) => whitespaceHash !== undefined),
  };
}
