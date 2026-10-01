/**
 * Divergence acknowledgements: the way a user says "these copies should differ".
 *
 * Sometimes Cursor's copy of a skill genuinely ought to diverge from Claude's,
 * and a matrix that keeps flagging it trains people to ignore the flag. An
 * acknowledgement silences one specific divergence — it is keyed by the exact
 * set of content hashes accepted, so editing any copy retires it and the
 * resource starts reporting divergent again.
 */

import { createHash } from 'node:crypto';
import {
  type LibraryDivergenceAck,
  type LibraryDivergenceAckRequest,
  type LibraryResource,
  parseResourceKey,
} from '@mangostudio/shared/library';
import { getDb } from '../../../db/database';
import {
  assertRequestedProfileId,
  ProfileMismatchError,
  resolveActiveProfileId,
} from '../../../lib/profile-context';
import { LibraryRequestError } from '../domain/library-request-error';
import {
  createDivergenceAckRepository,
  type DivergenceAckRepository,
} from '../infrastructure/divergence-ack-repository';
import { discoverLibraryResources } from './library-discovery';

export interface DivergenceAckDeps {
  repository: DivergenceAckRepository;
  /** Forced, for the same reason preview forces: acking stale state is worse than not acking. */
  discover(userId: string, resource: LibraryResource['ref']): Promise<LibraryResource[]>;
  now(): number;
}

/** Resolved per call so importing this module never opens the database. */
function resolveDeps(overrides: Partial<DivergenceAckDeps>): DivergenceAckDeps {
  return {
    repository: overrides.repository ?? createDivergenceAckRepository(),
    discover:
      overrides.discover ??
      (async (userId, ref) => {
        const scan = await discoverLibraryResources(getDb(), userId, {
          force: true,
          kinds: [ref.kind],
        });
        return scan.resources;
      }),
    now: overrides.now ?? Date.now,
  };
}

function activeProfileId(userId: string, requested?: string) {
  try {
    return assertRequestedProfileId(requested, { userId });
  } catch (error) {
    if (error instanceof ProfileMismatchError) {
      throw new LibraryRequestError(400, error.message);
    }
    throw error;
  }
}

/** Stable digest of an accepted divergence, independent of hash order. */
export function divergenceKeyFor(contentHashes: readonly string[]): string {
  return createHash('sha256')
    .update(`mangostudio/library/divergence\0${normalizeHashes(contentHashes).join('\n')}`)
    .digest('hex');
}

/**
 * The distinct versions a user is being asked to accept. Copies the scanner
 * could not read carry no content and are not part of the divergence.
 */
export function readableContentHashes(resource: LibraryResource): string[] {
  return normalizeHashes(
    resource.instances.flatMap((instance) => (instance.valid ? [instance.contentHash] : []))
  );
}

export async function listDivergenceAcks(
  userId: string,
  overrides: Partial<DivergenceAckDeps> = {}
): Promise<LibraryDivergenceAck[]> {
  const deps = resolveDeps(overrides);
  const profileId = resolveActiveProfileId({ userId });
  const records = await deps.repository.list(userId, profileId);
  return records.map((record) => ({
    resourceKey: record.resourceKey,
    contentHashes: record.contentHashes,
    acknowledgedAtMs: record.acknowledgedAtMs,
  }));
}

/**
 * Records a divergence acknowledgement after checking it against the hub's own
 * disk.
 *
 * The scan is the hub host's, which is the Local environment's disk: this
 * verifies a request that names no environment (`POST /library/divergence/acks`).
 * A divergence reviewed across machines is recorded by
 * {@link recordDivergenceAck} from the hashes the preview read through each
 * machine's own runtime, never from this rescan.
 *
 * @example
 * await acknowledgeDivergence(userId, { resourceKey: 'skill:gh', contentHashes: [a, b] });
 */
export async function acknowledgeDivergence(
  userId: string,
  request: LibraryDivergenceAckRequest,
  overrides: Partial<DivergenceAckDeps> = {}
): Promise<LibraryDivergenceAck> {
  const deps = resolveDeps(overrides);
  const profileId = activeProfileId(userId, request.profileId);
  const ref = parseResourceKey(request.resourceKey);
  if (!ref) {
    throw new LibraryRequestError(422, `Invalid library resource key: "${request.resourceKey}".`);
  }

  const resources = await deps.discover(userId, ref);
  const resource = resources.find((candidate) => candidate.key === request.resourceKey);
  if (!resource) {
    throw new LibraryRequestError(404, `Library resource "${request.resourceKey}" was not found.`);
  }

  const contentHashes = readableContentHashes(resource);
  if (contentHashes.length < 2) {
    throw new LibraryRequestError(
      422,
      `Library resource "${request.resourceKey}" is not divergent.`
    );
  }
  // Accepting a divergence the client never saw would mute a version the user
  // has not looked at, so a rescan that disagrees rejects rather than records.
  const divergenceKey = divergenceKeyFor(contentHashes);
  if (divergenceKeyFor(request.contentHashes) !== divergenceKey) {
    throw new LibraryRequestError(
      409,
      `Library resource "${request.resourceKey}" changed since it was reviewed. Rescan and try again.`
    );
  }

  return storeAcknowledgement(deps, userId, profileId, request.resourceKey, contentHashes);
}

/**
 * The hashes recorded here were read through a machine's runtime, which the hub
 * does not control, so what it persists is bounded: a runtime that reports
 * transport-sized strings must not turn into database growth. Real digests are
 * 64 hex characters; the cap leaves room without trusting the peer.
 */
const MAX_ACK_HASHES = 64;
const MAX_ACK_HASH_LENGTH = 128;

function assertBoundedHashes(resourceKey: string, contentHashes: readonly string[]): void {
  if (contentHashes.length > MAX_ACK_HASHES) {
    throw new LibraryRequestError(
      422,
      `Library resource "${resourceKey}" reports too many versions to acknowledge: expected at most ${MAX_ACK_HASHES} distinct content hashes, received ${contentHashes.length}.`
    );
  }
  const oversized = contentHashes.find((hash) => hash.length > MAX_ACK_HASH_LENGTH);
  if (oversized !== undefined) {
    throw new LibraryRequestError(
      422,
      `Library resource "${resourceKey}" reports a content hash of ${oversized.length} characters: expected at most ${MAX_ACK_HASH_LENGTH}, starting "${oversized.slice(0, 16)}".`
    );
  }
}

/**
 * Records an acknowledgement for versions that were already verified: the apply
 * path acknowledges the source groups its own forced preview just built from
 * every selected machine's runtime, and that preview is pinned to the request by
 * token and state hash. Rescanning the hub here would answer with the wrong
 * machine's files, so this takes the reviewed hashes as they are and only checks
 * what can be known without a scan: a well-formed key and at least two distinct
 * versions.
 *
 * @example
 * await recordDivergenceAck(userId, { resourceKey: 'skill:gh', contentHashes: [a, b] });
 */
export async function recordDivergenceAck(
  userId: string,
  request: LibraryDivergenceAckRequest,
  overrides: Partial<DivergenceAckDeps> = {}
): Promise<LibraryDivergenceAck> {
  const deps = resolveDeps(overrides);
  const profileId = activeProfileId(userId, request.profileId);
  if (!parseResourceKey(request.resourceKey)) {
    throw new LibraryRequestError(422, `Invalid library resource key: "${request.resourceKey}".`);
  }
  const contentHashes = normalizeHashes(request.contentHashes);
  if (contentHashes.length < 2) {
    throw new LibraryRequestError(
      422,
      `Library resource "${request.resourceKey}" is not divergent: expected at least 2 distinct content hashes, received ${contentHashes.length}.`
    );
  }
  assertBoundedHashes(request.resourceKey, contentHashes);
  return await storeAcknowledgement(deps, userId, profileId, request.resourceKey, contentHashes);
}

async function storeAcknowledgement(
  deps: DivergenceAckDeps,
  userId: string,
  profileId: string,
  resourceKey: string,
  contentHashes: string[]
): Promise<LibraryDivergenceAck> {
  const acknowledgedAtMs = deps.now();
  await deps.repository.upsert(userId, profileId, {
    resourceKey,
    divergenceKey: divergenceKeyFor(contentHashes),
    contentHashes,
    acknowledgedAtMs,
  });
  return { resourceKey, contentHashes, acknowledgedAtMs };
}

export async function forgetDivergenceAck(
  userId: string,
  resourceKey: string,
  overrides: Partial<DivergenceAckDeps> = {}
): Promise<void> {
  const deps = resolveDeps(overrides);
  const profileId = resolveActiveProfileId({ userId });
  await deps.repository.remove(userId, profileId, [resourceKey]);
}

/**
 * The distinct readable versions of each resource across every copy handed in.
 * Callers pass one entry per machine holding the resource; the divergence a
 * user accepts is the union of all of them, so a resource listed twice is one
 * resource, not two competing ones.
 */
function readableHashesByKey(resources: readonly LibraryResource[]): Map<string, string[]> {
  const hashes = new Map<string, string[]>();
  for (const resource of resources) {
    hashes.set(resource.key, [
      ...(hashes.get(resource.key) ?? []),
      ...readableContentHashes(resource),
    ]);
  }
  return new Map([...hashes].map(([key, found]) => [key, normalizeHashes(found)] as const));
}

export interface AcknowledgedKeysOptions {
  /**
   * False when a machine in scope could not be scanned. Its copies are missing
   * from `resources`, so a hash set that looks changed may only be incomplete,
   * and one that looks unchanged may hide a new version: no acknowledgement is
   * honoured for this answer, and none is deleted either.
   */
  readonly complete?: boolean;
}

/**
 * Which of these resources the user has already accepted as divergent, dropping
 * acknowledgements whose content has moved on. Pruning here rather than on a
 * schedule keeps "the flag returns when the content changes again" true without
 * a background job that could lag behind the next scan.
 *
 * `resources` may hold several entries per key, one per machine scanned; they
 * are compared as one merged set of versions.
 *
 * @example
 * const kept = await acknowledgedResourceKeys(userId, [onLocal, onRemote]);
 */
export async function acknowledgedResourceKeys(
  userId: string,
  resources: readonly LibraryResource[],
  overrides: Partial<DivergenceAckDeps> = {},
  options: AcknowledgedKeysOptions = {}
): Promise<ReadonlySet<string>> {
  const deps = resolveDeps(overrides);
  const profileId = resolveActiveProfileId({ userId });
  const complete = options.complete !== false;
  const hashesByKey = readableHashesByKey(resources);
  const records = await deps.repository.listFor(userId, profileId, [...hashesByKey.keys()]);

  const current = new Set<string>();
  const expired: string[] = [];
  for (const record of records) {
    const hashes = hashesByKey.get(record.resourceKey);
    if (!hashes || record.divergenceKey !== divergenceKeyFor(hashes)) {
      expired.push(record.resourceKey);
      continue;
    }
    // A match over an incomplete scan proves nothing: the machine that could
    // not answer may hold a version the user never accepted.
    if (complete) current.add(record.resourceKey);
  }
  if (complete) await deps.repository.remove(userId, profileId, expired);
  return current;
}

function normalizeHashes(contentHashes: readonly string[]): string[] {
  return [...new Set(contentHashes)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
}
