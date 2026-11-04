import {
  type CanaryNpmPublication,
  type RegistryClient,
  verifyCanaryNpmPublication,
} from './canary-publication';
import {
  type CanaryReleaseClient,
  type CanaryReleaseExpectation,
  type CanaryReleasePublication,
  verifyCanaryReleasePublication,
} from './canary-release';
import { type CanaryTagAncestry, planCanaryTagUpdates } from './canary-tags';
import type { DistributionManifest } from './distribution-manifest';
import { MAIN_PACKAGE, NPM_PLATFORMS, platformPackageName } from './npm-pack';
import { isValidSemver, normalizeVersion } from './release-version';

/** Complete paginated release reads, in addition to the selected release's integrity boundary. */
export interface CanaryPublicationAuditGitHub extends CanaryReleaseClient {
  list(path: string): Promise<readonly unknown[]>;
}

export interface CanaryPublicationAuditDependencies {
  readonly registry: RegistryClient;
  readonly github: CanaryPublicationAuditGitHub;
  readonly ancestry: CanaryTagAncestry;
}

interface PublishedCanary {
  readonly releaseId: number;
  readonly tag: string;
  readonly version: string;
  readonly sourceSha: string;
  readonly relation: 'selected' | 'ancestor' | 'descendant' | 'diverged';
}

export interface CanaryPublicationAudit {
  readonly sourceSha: string;
  readonly version: string;
  readonly decision: 'noop' | 'publish';
  readonly reason:
    'already-complete' | 'superseded' | 'tag-recovery' | 'partial-publication' | 'new-publication';
  readonly needed: {
    readonly npm: boolean;
    readonly packages: readonly string[];
    readonly tags: readonly string[];
    readonly github: boolean;
  };
  readonly supersededBy: { readonly version: string; readonly sourceSha: string } | null;
  readonly receipts: {
    readonly npm: CanaryNpmPublication;
    readonly github: CanaryReleasePublication;
    readonly publishedCanaries: readonly PublishedCanary[];
  };
}

/**
 * Audit actual publication bytes and current channel owners before any mutation.
 * A no-op requires all seven selected npm packages and the exact complete selected
 * GitHub release. A unanimously newer channel can supersede that complete version;
 * mixed owners must pass fresh ordering guards and recover forward instead.
 * The caller authenticates both expected inputs and repeats this audit inside each
 * publisher job, because successful preparation outputs can outlive a failed-job retry.
 * @example const audit = await auditCanaryPublication(manifest, expectedRelease, dependencies);
 */
export async function auditCanaryPublication(
  manifest: DistributionManifest,
  expectedRelease: CanaryReleaseExpectation,
  dependencies: CanaryPublicationAuditDependencies
): Promise<CanaryPublicationAudit> {
  if (
    manifest.sourceSha !== expectedRelease.sourceSha ||
    manifest.packageVersion !== expectedRelease.version
  ) {
    throw new Error(
      `Canary audit identity mismatch: expected release ${expectedRelease.sourceSha}@${expectedRelease.version}; received manifest ${manifest.sourceSha}@${manifest.packageVersion}`
    );
  }
  const npm = await verifyCanaryNpmPublication(manifest, dependencies.registry);
  const names = [...NPM_PLATFORMS.map(platformPackageName), MAIN_PACKAGE];
  const identities = [...npm.present.map((entry) => entry.name), ...npm.missing];
  if (
    identities.length !== names.length ||
    new Set(identities).size !== names.length ||
    identities.some((name) => !names.includes(name))
  ) {
    throw new Error(
      `Invalid npm audit receipt: expected exactly seven selected package identities; received ${JSON.stringify(identities)}`
    );
  }
  const github = await verifyCanaryReleasePublication(expectedRelease, dependencies.github);
  const publishedCanaries = await inspectPublishedCanaries(expectedRelease, dependencies);
  const receipts = { npm, github, publishedCanaries };
  const complete =
    npm.present.length === names.length && npm.missing.length === 0 && github.state === 'complete';
  const owners = names.map((name) => npm.canary[name]);
  const unanimous =
    owners.length === names.length &&
    owners.every((owner) => typeof owner === 'string' && owner === owners[0]);
  const noNeeds = { npm: false, packages: [], tags: [], github: false } as const;
  if (complete && unanimous && owners[0] === manifest.packageVersion) {
    return {
      sourceSha: manifest.sourceSha,
      version: manifest.packageVersion,
      decision: 'noop',
      reason: 'already-complete',
      needed: noNeeds,
      supersededBy: null,
      receipts,
    };
  }
  if (complete && unanimous && typeof owners[0] === 'string') {
    const ownerVersion = owners[0];
    const ownerSha = await resolveCanaryTag(`v${ownerVersion}`, dependencies.github, true);
    if (ownerSha !== null) {
      const relation =
        ownerSha === manifest.sourceSha
          ? 'identical'
          : await dependencies.ancestry.compare(manifest.sourceSha, ownerSha);
      if (relation === 'ahead') {
        return {
          sourceSha: manifest.sourceSha,
          version: manifest.packageVersion,
          decision: 'noop',
          reason: 'superseded',
          needed: noNeeds,
          supersededBy: { version: ownerVersion, sourceSha: ownerSha },
          receipts,
        };
      }
      if (relation !== 'behind') {
        throw new Error(
          `Unproven superseding canary ${ownerVersion}: expected a strict descendant or ancestor of ${manifest.sourceSha}; received ${ownerSha} (${relation})`
        );
      }
    }
  }
  // Every write path includes this fresh check, including missing selected versions:
  // publishing the missing package itself moves its canary tag.
  const plan = await planCanaryTagUpdates(manifest, npm.canary, dependencies.ancestry);
  for (const published of publishedCanaries) {
    if (published.relation === 'descendant' || published.relation === 'diverged') {
      throw new Error(
        `Canary publication would move GitHub backwards or across branches: selected ${manifest.sourceSha}, published ${published.tag} at ${published.sourceSha} (${published.relation}); expected selected source to equal or descend from every published canary`
      );
    }
  }
  const needed = {
    npm: npm.missing.length > 0 || plan.updates.length > 0,
    packages: npm.missing,
    tags: plan.updates,
    github: github.state !== 'complete',
  };
  const reason =
    npm.missing.length === 0 && github.state === 'complete'
      ? 'tag-recovery'
      : npm.present.length > 0 || github.state !== 'absent'
        ? 'partial-publication'
        : 'new-publication';
  return {
    sourceSha: manifest.sourceSha,
    version: manifest.packageVersion,
    decision: 'publish',
    reason,
    needed,
    supersededBy: null,
    receipts,
  };
}

async function inspectPublishedCanaries(
  expected: CanaryReleaseExpectation,
  dependencies: CanaryPublicationAuditDependencies
): Promise<PublishedCanary[]> {
  const releases = await dependencies.github.list(
    `repos/${expected.repository}/releases?per_page=100`
  );
  if (!Array.isArray(releases))
    throw new Error(
      `Invalid canary release listing: expected complete release array; received ${JSON.stringify(releases)}`
    );
  const seenIds = new Set<number>();
  const seenTags = new Set<string>();
  const result: PublishedCanary[] = [];
  for (const value of releases) {
    const release = object(value, 'published release');
    if (typeof release.tag_name !== 'string' || typeof release.draft !== 'boolean') {
      throw new Error(
        `Invalid published release identity: expected tag_name string and draft boolean; received ${JSON.stringify(release)}`
      );
    }
    const tag = release.tag_name;
    if (
      release.draft ||
      tag.startsWith('protocol-') ||
      !(tag.includes('-canary') || tag === 'canary' || tag.startsWith('canary-'))
    )
      continue;
    const id = release.id;
    if (
      typeof id !== 'number' ||
      !Number.isSafeInteger(id) ||
      id < 1 ||
      seenIds.has(id) ||
      seenTags.has(tag) ||
      release.prerelease !== true ||
      release.immutable !== true ||
      release.url !== `https://api.github.com/repos/${expected.repository}/releases/${id}` ||
      release.html_url !== `https://github.com/${expected.repository}/releases/tag/${tag}`
    ) {
      throw new Error(
        `Invalid published canary ${tag}: expected unique immutable pre-release in ${expected.repository}; received ${JSON.stringify(release)}`
      );
    }
    const sourceSha = await resolveCanaryTag(tag, dependencies.github);
    if (sourceSha === null)
      throw new Error(`Unproven published canary ${tag}: expected existing full tag source`);
    const version = tag.slice(1);
    if (sourceSha === expected.sourceSha && version !== expected.version) {
      throw new Error(
        `Invalid published canary source alias ${tag}: expected identical source version ${expected.version}; received ${sourceSha}`
      );
    }
    const relation =
      sourceSha === expected.sourceSha
        ? 'selected'
        : await publishedRelation(sourceSha, expected.sourceSha, dependencies.ancestry);
    result.push({ releaseId: id, tag, version, sourceSha, relation });
    seenIds.add(id);
    seenTags.add(tag);
  }
  return result;
}

async function publishedRelation(
  source: string,
  selected: string,
  ancestry: CanaryTagAncestry
): Promise<PublishedCanary['relation']> {
  const comparison = await ancestry.compare(source, selected);
  if (comparison === 'ahead') return 'ancestor';
  if (comparison === 'behind') return 'descendant';
  if (comparison === 'diverged') return 'diverged';
  throw new Error(
    `Unproven published canary ancestry: expected ahead/behind/diverged for distinct sources ${source}...${selected}; received ${comparison}`
  );
}

async function resolveCanaryTag(
  tag: string,
  github: CanaryReleaseClient,
  allowAbsent = false
): Promise<string | null> {
  const version = tag.startsWith('v') ? tag.slice(1) : '';
  const match = /-canary\.(g0\d{6}|[0-9a-f]{7})$/.exec(version);
  if (!isValidSemver(version) || normalizeVersion(version) !== version || !match?.[1]) {
    throw new Error(
      `Invalid published canary tag ${JSON.stringify(tag)}: expected canonical v<version>-canary.<sha7>`
    );
  }
  const prefix = match[1].startsWith('g') ? match[1].slice(1) : match[1];
  const resolved = await github.resolveTag(tag);
  if (allowAbsent && resolved.status === 404) return null;
  if (
    resolved.status !== 200 ||
    typeof resolved.body !== 'string' ||
    !/^[0-9a-f]{40}$/.test(resolved.body) ||
    !resolved.body.startsWith(prefix)
  ) {
    throw new Error(
      `Unproven published canary tag ${tag}: expected HTTP200 full commit SHA with prefix ${prefix}; received status=${resolved.status} body=${JSON.stringify(resolved.body)}`
    );
  }
  return resolved.body;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid ${label}: expected object; received ${JSON.stringify(value)}`);
  return value as Record<string, unknown>;
}
