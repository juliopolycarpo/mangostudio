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

  const acknowledgedAtMs = deps.now();
  await deps.repository.upsert(userId, profileId, {
    resourceKey: request.resourceKey,
    divergenceKey,
    contentHashes,
    acknowledgedAtMs,
  });
  return { resourceKey: request.resourceKey, contentHashes, acknowledgedAtMs };
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
 * Which of these resources the user has already accepted as divergent, dropping
 * acknowledgements whose content has moved on. Pruning here rather than on a
 * schedule keeps "the flag returns when the content changes again" true without
 * a background job that could lag behind the next scan.
 */
export async function acknowledgedResourceKeys(
  userId: string,
  resources: readonly LibraryResource[],
  overrides: Partial<DivergenceAckDeps> = {}
): Promise<ReadonlySet<string>> {
  const deps = resolveDeps(overrides);
  const profileId = resolveActiveProfileId({ userId });
  const byKey = new Map(resources.map((resource) => [resource.key, resource] as const));
  const records = await deps.repository.listFor(userId, profileId, [...byKey.keys()]);

  const current = new Set<string>();
  const expired: string[] = [];
  for (const record of records) {
    const resource = byKey.get(record.resourceKey);
    if (resource && record.divergenceKey === divergenceKeyFor(readableContentHashes(resource))) {
      current.add(record.resourceKey);
    } else {
      expired.push(record.resourceKey);
    }
  }
  await deps.repository.remove(userId, profileId, expired);
  return current;
}

function normalizeHashes(contentHashes: readonly string[]): string[] {
  return [...new Set(contentHashes)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
}
