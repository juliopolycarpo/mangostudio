import { createHash } from 'node:crypto';

import { createCanaryManifestFromDigests } from '../release/stage-canary-assets';
import type { CanaryDistribution } from './canary-promotion';
import type { CanaryValidationReceipt } from './canary-validation';
import type { ApprovedArtifact } from './distribution-artifact';
import { parseDistributionManifest } from './distribution-manifest';
import { createReleaseAssetPlan, selectCanaryAssets } from './release-assets';
import { isValidSemver, normalizeVersion } from './release-version';

/** Durable publication identity; the publisher attests its SHA256SUMS separately from the original builder bundle. */
export interface CanaryPromotionReceipt {
  readonly schemaVersion: 1;
  readonly workflowRevision: string;
  readonly manifestSha256: string;
  readonly distribution: CanaryDistribution;
  readonly qualification: CanaryValidationReceipt;
}

/**
 * Reproduce the complete release asset map from an authenticated builder manifest.
 * The caller verifies both the original bundle's builder provenance and its extracted
 * manifest before calling this function. No binary download or compilation is needed.
 * Example: createCanaryPublicationEvidence(manifestRaw, receipt, verifiedChecksumsBundle).
 */
export function createCanaryPublicationEvidence(
  manifestRaw: string,
  receipt: CanaryPromotionReceipt,
  checksumsBundle: Uint8Array
): {
  readonly expected: {
    readonly repository: string;
    readonly sourceSha: string;
    readonly version: string;
    readonly assets: readonly {
      readonly name: string;
      readonly size: number;
      readonly sha256: string;
    }[];
  };
  readonly generated: ReadonlyMap<string, Uint8Array>;
} {
  const manifest = parseDistributionManifest(manifestRaw);
  const source = receipt.qualification.source;
  // Parse the same persisted contract even for a newly assembled receipt.
  parseCanaryPromotionReceipt(JSON.stringify(receipt), source.repository, manifest.sourceSha);
  if (
    manifest.sourceSha !== source.sourceSha ||
    manifest.dirty ||
    manifest.channel !== 'canary' ||
    manifest.runtimeProfile !== 'shipping' ||
    hash(Buffer.from(manifestRaw)) !== receipt.manifestSha256
  ) {
    throw new Error(
      `Invalid publication manifest: expected clean shipping canary ${source.sourceSha} with SHA256 ${receipt.manifestSha256}`
    );
  }
  const short = source.sourceSha.slice(0, 7);
  const identifier = /^0\d+$/.test(short) ? `g${short}` : short;
  if (
    !isValidSemver(manifest.packageVersion) ||
    normalizeVersion(manifest.packageVersion) !== manifest.packageVersion ||
    !manifest.packageVersion.endsWith(`-canary.${identifier}`)
  )
    throw new Error(
      `Invalid canary publication version: ${manifest.packageVersion}; expected canonical version naming ${source.sourceSha}`
    );
  for (const scope of ['checksums', 'assets', 'npm'] as const) {
    const prefix = `distribution-${scope}-${source.sourceSha.slice(0, 12)}-${manifest.packageVersion}-`;
    const name = receipt.distribution[scope].artifactName;
    if (!name.startsWith(prefix) || !/^[a-f0-9]{12}$/.test(name.slice(prefix.length)))
      throw new Error(
        `Invalid ${scope} artifact name: ${name}; expected exact source/version and content suffix`
      );
  }
  const plan = createReleaseAssetPlan({ version: manifest.packageVersion });
  const selection = selectCanaryAssets(plan);
  const assets = [...selection.archives, ...selection.rawBinaries, ...selection.scripts].map(
    (name) => {
      const file = manifest.files.find((entry) => entry.path === `release-assets/${name}`);
      if (!file)
        throw new Error(
          `Missing approved release asset ${name}: expected manifest file release-assets/${name}`
        );
      return { name, size: file.size, sha256: file.sha256 };
    }
  );
  const generated = new Map<string, Uint8Array>();
  generated.set(
    'canary-manifest.json',
    jsonBytes(
      createCanaryManifestFromDigests({
        version: manifest.packageVersion,
        sourceSha: source.sourceSha,
        builtAt: receipt.distribution.builtAt,
        digests: new Map(assets.map((asset) => [asset.name, asset.sha256])),
      })
    )
  );
  generated.set('promotion.json', jsonBytes(receipt));
  generated.set('promotion-checksums.tar.gz', checksumsBundle);
  for (const [name, bytes] of generated)
    assets.push({ name, size: bytes.byteLength, sha256: hash(bytes) });
  const checksums = `${[...assets]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((asset) => `${asset.sha256}  ${asset.name}`)
    .join('\n')}\n`;
  const checksumBytes = Buffer.from(checksums);
  generated.set('SHA256SUMS', checksumBytes);
  assets.push({ name: 'SHA256SUMS', size: checksumBytes.byteLength, sha256: hash(checksumBytes) });
  return {
    expected: {
      repository: source.repository,
      sourceSha: source.sourceSha,
      version: manifest.packageVersion,
      assets,
    },
    generated,
  };
}

/** Read a persisted receipt before authenticating its publisher signature; values remain untrusted until that verification succeeds. Example: parseCanaryPromotionReceipt(raw, 'owner/repo', sourceSha). */
export function parseCanaryPromotionReceipt(
  raw: string,
  repository: string,
  sourceSha: string
): CanaryPromotionReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error('Invalid promotion receipt: expected JSON object', { cause });
  }
  const receipt = object(parsed, 'promotion receipt');
  const qualification = object(receipt.qualification, 'qualification receipt');
  const source = object(qualification.source, 'qualified source');
  const distribution = object(receipt.distribution, 'approved distribution');
  if (
    receipt.schemaVersion !== 1 ||
    typeof receipt.workflowRevision !== 'string' ||
    !/^[a-f0-9]{40}$/.test(receipt.workflowRevision) ||
    typeof receipt.manifestSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(receipt.manifestSha256) ||
    source.repository !== repository ||
    source.sourceSha !== sourceSha ||
    !/^[a-f0-9]{40}$/.test(sourceSha) ||
    !/^[\w.-]+\/[\w.-]+$/.test(repository)
  ) {
    throw new Error(
      `Invalid promotion receipt: expected schema 1 ${repository}@${sourceSha}, workflow revision and manifest SHA256`
    );
  }
  for (const field of ['runId', 'runAttempt']) positive(source[field], `qualified source ${field}`);
  positive(qualification.builderAttempt, 'builder attempt');
  if (Number(qualification.builderAttempt) > Number(source.runAttempt))
    throw new Error('Invalid builder attempt: expected no later than qualified source attempt');
  if (
    typeof distribution.builtAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(distribution.builtAt) ||
    !Number.isFinite(Date.parse(distribution.builtAt)) ||
    ![distribution.builtAt, distribution.builtAt.replace('Z', '.000Z')].includes(
      new Date(distribution.builtAt).toISOString()
    )
  ) {
    throw new Error(
      `Invalid build completion time: ${distribution.builtAt}; expected canonical UTC ISO timestamp`
    );
  }
  if (
    source.pushBeforeSha !== undefined &&
    (typeof source.pushBeforeSha !== 'string' || !/^[a-f0-9]{40}$/.test(source.pushBeforeSha))
  )
    throw new Error('Invalid push-before SHA: expected full SHA');
  assertJobReceipts(qualification.ciJobs, Number(source.runAttempt));
  const relevance = object(qualification.relevance, 'qualification relevance');
  if (
    typeof relevance.cargo !== 'boolean' ||
    typeof relevance.protocol !== 'boolean' ||
    typeof relevance.reason !== 'string' ||
    relevance.reason.length === 0
  )
    throw new Error('Invalid qualification relevance: expected cargo/protocol booleans and reason');
  if (!Array.isArray(qualification.siblings))
    throw new Error('Invalid qualification siblings: expected receipt array');
  const workflows = new Set<string>();
  for (const value of qualification.siblings) {
    const sibling = object(value, 'sibling receipt');
    if (
      typeof sibling.workflow !== 'string' ||
      !/^[a-z][a-z0-9-]*\.yml$/.test(sibling.workflow) ||
      workflows.has(sibling.workflow)
    )
      throw new Error('Invalid sibling workflow: expected unique workflow filename');
    workflows.add(sibling.workflow);
    if (sibling.result === 'success') {
      positive(sibling.runId, 'sibling run ID');
      positive(sibling.attempt, 'sibling attempt');
      assertJobReceipts(sibling.jobs, Number(sibling.attempt));
    } else if (sibling.result === 'not-triggered') {
      if (
        sibling.runId !== null ||
        sibling.attempt !== null ||
        !Array.isArray(sibling.jobs) ||
        sibling.jobs.length !== 0
      )
        throw new Error('Invalid absent sibling: expected null run/attempt and empty jobs');
    } else
      throw new Error(
        `Invalid sibling result: ${sibling.result}; expected success or not-triggered`
      );
  }
  for (const scope of ['checksums', 'assets', 'npm']) {
    const artifact = object(distribution[scope], `${scope} artifact`);
    for (const field of ['runId', 'runAttempt', 'producerAttempt', 'artifactId'])
      positive(artifact[field], `${scope} ${field}`);
    if (
      artifact.repository !== repository ||
      artifact.sourceSha !== sourceSha ||
      artifact.runId !== source.runId ||
      artifact.runAttempt !== source.runAttempt ||
      artifact.producerAttempt !== qualification.builderAttempt ||
      typeof artifact.artifactName !== 'string' ||
      !artifact.artifactName.startsWith(`distribution-${scope}-${sourceSha.slice(0, 12)}-`) ||
      typeof artifact.digest !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)
    ) {
      throw new Error(
        `Invalid ${scope} approved artifact: expected qualified repository, source, run, attempt and immutable digest`
      );
    }
  }
  return receipt as unknown as CanaryPromotionReceipt;
}

/** Require a publisher's downloaded scope to carry the exact original approved manifest. Example: assertCanaryManifestIdentity(raw, receipt). */
export function assertCanaryManifestIdentity(raw: string, receipt: CanaryPromotionReceipt): void {
  const actual = hash(Buffer.from(raw));
  if (actual !== receipt.manifestSha256)
    throw new Error(
      `Mixed distribution manifest: expected ${receipt.manifestSha256}, received ${actual}; recover original approved bytes`
    );
}

/** Check an immutable pointer without treating a SHA-derived version as byte identity. Example: sameApprovedArtifact(original, candidate). */
export function sameApprovedArtifact(
  original: ApprovedArtifact,
  candidate: ApprovedArtifact
): boolean {
  return [
    'repository',
    'sourceSha',
    'runId',
    'producerAttempt',
    'artifactId',
    'artifactName',
    'digest',
  ].every(
    (key) => original[key as keyof ApprovedArtifact] === candidate[key as keyof ApprovedArtifact]
  );
}

function assertJobReceipts(value: unknown, maxAttempt: number): void {
  if (!Array.isArray(value))
    throw new Error('Invalid qualification jobs: expected job receipt array');
  const ids = new Set<number>();
  const names = new Set<string>();
  for (const entry of value) {
    const job = object(entry, 'qualified job');
    positive(job.id, 'job ID');
    positive(job.attempt, 'job attempt');
    if (
      typeof job.name !== 'string' ||
      !job.name ||
      /[\r\n\0]/.test(job.name) ||
      Number(job.attempt) > maxAttempt ||
      ids.has(Number(job.id)) ||
      names.has(job.name)
    )
      throw new Error(
        'Invalid qualified job: expected unique ID/name and attempt within successful run'
      );
    ids.add(Number(job.id));
    names.add(job.name);
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid ${name}: expected object, received ${JSON.stringify(value)}`);
  return value as Record<string, unknown>;
}
function positive(value: unknown, name: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error(
      `Invalid ${name}: expected positive safe integer, received ${JSON.stringify(value)}`
    );
}
function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}
function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
