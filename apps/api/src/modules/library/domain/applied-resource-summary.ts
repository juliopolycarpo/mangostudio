import type {
  LibraryTargetId,
  PropagationApplied,
  PropagationPreview,
  ResourceKind,
} from '@mangostudio/shared/library';

export interface AppliedResourceSummary {
  readonly kind: ResourceKind;
  readonly slug: string;
  /** Every agent the written locations serve, deduplicated and in preview order. */
  readonly targets: readonly LibraryTargetId[];
  /**
   * The machine this resource landed on, or `null` when it landed on several.
   *
   * One apply can span machines, and each resource in it can span a different
   * subset — so the environment is per resource, not per apply. `null` rather
   * than the first of them: a row scoped to one machine when the write touched
   * three is a filter that quietly lies.
   */
  readonly environmentId: string | null;
}

/**
 * One row per resource an apply actually wrote, naming the agents it reached.
 *
 * The applied rows name *locations*, and a location can serve several agents —
 * a shared config directory two vendors both read. The preview is what knows
 * that mapping, so the two are joined here rather than re-deriving the location
 * registry after the write.
 *
 * Resources appear in the order the preview listed them, so two identical
 * applies produce identical feed rows.
 */
export function summarizeAppliedResources(
  preview: PropagationPreview,
  applied: readonly PropagationApplied[]
): AppliedResourceSummary[] {
  const writtenLocations = new Map<string, Set<string>>();
  for (const row of applied) {
    const locations = writtenLocations.get(row.resourceKey);
    if (locations) locations.add(destinationKey(row.environmentId, row.locationId));
    else
      writtenLocations.set(
        row.resourceKey,
        new Set([destinationKey(row.environmentId, row.locationId)])
      );
  }

  const summaries: AppliedResourceSummary[] = [];
  for (const entry of preview.entries) {
    const locations = writtenLocations.get(entry.resourceKey);
    if (!locations) continue;

    const targets = new Set<LibraryTargetId>();
    const environments = new Set<string>();
    for (const destination of entry.destinations) {
      if (!locations.has(destinationKey(destination.environmentId, destination.locationId)))
        continue;
      environments.add(destination.environmentId);
      for (const targetId of destination.targetIds) targets.add(targetId);
    }

    const [onlyEnvironment] = environments;
    summaries.push({
      kind: entry.ref.kind,
      slug: entry.ref.slug,
      targets: [...targets],
      environmentId: environments.size === 1 && onlyEnvironment ? onlyEnvironment : null,
    });
  }

  return summaries;
}

function destinationKey(environmentId: string, locationId: string): string {
  return `${environmentId}\0${locationId}`;
}
