import { ERROR_CODES } from '@mangostudio/shared/errors';
import type {
  McpPortabilityConflictCandidate,
  McpPortabilityDecisionInput,
} from '@mangostudio/shared/mcp';
import { McpServerError } from '../domain/mcp-server';

export interface McpPortabilitySlugOwner {
  id: string;
  name: string;
  slug: string;
}

export interface McpPortabilitySlugPlanEntry {
  key: string;
  name: string;
  slug: string;
  copySlug?: string;
}

type ReplacementSlugBlocker = NonNullable<McpPortabilityConflictCandidate['replaceBlockedBySlug']>;

export function findReplacementSlugBlocker(
  incomingSlug: string,
  target: McpPortabilitySlugOwner,
  existing: readonly McpPortabilitySlugOwner[]
): ReplacementSlugBlocker | undefined {
  if (target.slug === incomingSlug) return undefined;
  const holder = existing.find((server) => server.slug === incomingSlug);
  if (!holder) return undefined;
  return { slug: incomingSlug, holderName: holder.name };
}

export function assertUniquePostApplySlugs(
  existing: readonly McpPortabilitySlugOwner[],
  entries: readonly McpPortabilitySlugPlanEntry[],
  decisions: ReadonlyMap<string, McpPortabilityDecisionInput>
): void {
  const replacedIds = new Set<string>();
  for (const decision of decisions.values()) {
    if (decision.decision === 'replace' && decision.targetServerId) {
      replacedIds.add(decision.targetServerId);
    }
  }

  const slugOwners = new Map<string, string>();
  for (const server of existing) {
    if (!replacedIds.has(server.id)) slugOwners.set(server.slug, server.name);
  }

  for (const entry of entries) {
    const decision = decisions.get(entry.key);
    if (!decision || decision.decision === 'skip') continue;
    const slug = decision.decision === 'copy' ? (entry.copySlug ?? entry.slug) : entry.slug;
    const currentOwner = slugOwners.get(slug);
    if (currentOwner !== undefined) {
      throw new McpServerError(
        `Import decisions for "${currentOwner}" and "${entry.name}" would both use slug "${slug}". Replace the slug owner instead, or import one as a copy.`,
        422,
        ERROR_CODES.VALIDATION
      );
    }
    slugOwners.set(slug, entry.name);
  }
}
