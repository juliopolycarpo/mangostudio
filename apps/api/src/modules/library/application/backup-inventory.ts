/**
 * The backups page, assembled from every machine that holds one.
 *
 * Two sources, one rule about which wins. The hub-side index is what keeps an
 * offline machine's sets on the page at all; the machine itself is authoritative
 * whenever it can be asked, because it is the only thing that knows what
 * retention did since the last look. So: ask every store the hub can reach,
 * believe it completely for that environment, and fall back to the index rows
 * only for the machines that did not answer.
 *
 * The index is never the restore source. Restore reads the manifest on the
 * machine, always — a row here says a set exists, not what is inside it.
 */

import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type {
  BackupAvailability,
  LibraryBackupSet,
  PropagationBackupSet,
  PropagationBackupUsage,
} from '@mangostudio/shared/library';
import type { RuntimeClient } from '../../../services/runtime-client';
import { getRuntimeClient } from '../../../services/runtime-client';
import { getRuntimeConnectionManager } from '../../../services/runtime-client/runtime-connection-manager';
import { environmentRepository } from '../../environments/infrastructure/environment-repository';
import {
  createLibraryBackupIndex,
  type LibraryBackupIndex,
  type LibraryBackupIndexRow,
} from '../infrastructure/backup-index-repository';
import { backupPolicyFor, backupRetentionPolicy } from '../infrastructure/backup-roots';

/** Matches the other library RPCs: the hub deadline sits above the store walk. */
const BACKUP_REQUEST_TIMEOUT_MS = 60_000;

export interface BackupInventoryDeps {
  index: LibraryBackupIndex;
  /** Environments to consider beyond Local, newest configuration first. */
  environmentIds(userId: string): Promise<string[]>;
  /** True when asking this environment would not have to dial it first. */
  isReachable(userId: string, environmentId: string): boolean;
  client(userId: string, environmentId: string): Promise<RuntimeClient>;
}

function defaultDeps(): BackupInventoryDeps {
  return {
    index: createLibraryBackupIndex(),
    environmentIds: async (userId) =>
      (await environmentRepository.list(userId))
        .filter((environment) => environment.enabled)
        .map((environment) => environment.id),
    isReachable: (userId, environmentId) =>
      getRuntimeConnectionManager().getStatus(userId, environmentId).state === 'connected',
    client: getRuntimeClient,
  };
}

interface EnvironmentBackups {
  readonly environmentId: string;
  readonly sets: readonly LibraryBackupSet[];
}

/**
 * Which machines are worth asking.
 *
 * Local always: it is in-process, and it is the only store that can hold sets
 * written before the index existed. A remote machine is asked when it already
 * has rows (so retention there can be reconciled) or when it happens to be
 * connected (so a store this hub has never indexed is still discovered). A
 * disconnected machine with no history is never dialed just to look.
 */
function environmentsToProbe(
  userId: string,
  configured: readonly string[],
  indexed: ReadonlySet<string>,
  deps: BackupInventoryDeps
): string[] {
  const probe = new Set<string>([LOCAL_ENVIRONMENT_ID]);
  for (const environmentId of configured) {
    if (indexed.has(environmentId) || deps.isReachable(userId, environmentId)) {
      probe.add(environmentId);
    }
  }
  return [...probe];
}

async function readEnvironmentBackups(
  userId: string,
  environmentId: string,
  deps: BackupInventoryDeps
): Promise<EnvironmentBackups | null> {
  try {
    const client = await deps.client(userId, environmentId);
    if (!client.manifest.features.library) return null;
    const policy = backupPolicyFor(client, environmentId);
    const result = await client.library.backups(
      {
        backupRoot: policy.backupRoot,
        retentionCount: policy.retentionCount,
        retentionBytes: policy.retentionBytes,
      },
      { timeoutMs: BACKUP_REQUEST_TIMEOUT_MS }
    );
    return { environmentId, sets: result.sets };
  } catch {
    // Unreachable, refused, or misconfigured — all the same answer here: this
    // machine did not speak for itself, so its index rows stand in and say so.
    // Failing the whole page because one machine is asleep would hide every
    // other machine's backups too.
    return null;
  }
}

function toRow(environmentId: string, set: LibraryBackupSet): PropagationBackupSet {
  const availability: BackupAvailability = set.manifestReadable ? 'available' : 'manifest-missing';
  return { ...set, environmentId, availability };
}

/**
 * An index row for a machine that did not answer. Everything the manifest would
 * have contributed is empty rather than guessed — `availability` is what the row
 * renders instead, and `evictsNext` is false because nothing can be predicted
 * about a retention pass on a disk the hub cannot see.
 */
function toOfflineRow(row: LibraryBackupIndexRow): PropagationBackupSet {
  return {
    backupId: row.backupId,
    createdAtMs: row.createdAtMs,
    sizeBytes: row.sizeBytes,
    entryCount: 0,
    pinned: row.pinned,
    lastCopyResourceKeys: [],
    operation: row.operation,
    resourceKeys: [],
    evictsNext: false,
    manifestReadable: false,
    environmentId: row.environmentId,
    availability: 'environment-offline',
  };
}

export async function describeBackupUsage(
  userId: string,
  overrides: Partial<BackupInventoryDeps> = {}
): Promise<PropagationBackupUsage> {
  const deps = { ...defaultDeps(), ...overrides };
  const indexRows = await deps.index.list(userId);
  const indexed = new Set(indexRows.map((row) => row.environmentId));
  const configured = await deps.environmentIds(userId);

  const answers = await Promise.all(
    environmentsToProbe(userId, configured, indexed, deps).map((environmentId) =>
      readEnvironmentBackups(userId, environmentId, deps)
    )
  );
  const live = new Map(
    answers.filter((answer) => answer !== null).map((a) => [a.environmentId, a])
  );

  const sets: PropagationBackupSet[] = [];
  const unreachableEnvironmentIds: string[] = [];
  const stale: { environmentId: string; backupIds: string[] }[] = [];

  for (const answer of live.values()) {
    for (const set of answer.sets) sets.push(toRow(answer.environmentId, set));
    const present = new Set(answer.sets.map((set) => set.backupId));
    const gone = indexRows
      .filter((row) => row.environmentId === answer.environmentId && !present.has(row.backupId))
      .map((row) => row.backupId);
    if (gone.length > 0) stale.push({ environmentId: answer.environmentId, backupIds: gone });
  }

  for (const row of indexRows) {
    if (live.has(row.environmentId)) continue;
    sets.push(toOfflineRow(row));
    if (!unreachableEnvironmentIds.includes(row.environmentId)) {
      unreachableEnvironmentIds.push(row.environmentId);
    }
  }

  // Two writes, both derived from machines that just spoke: rows for sets the
  // store no longer has are dropped, and everything it does have is recorded —
  // which is also how a store written before the index existed gets backfilled.
  await Promise.all(
    stale.map((entry) => deps.index.forget(userId, entry.environmentId, entry.backupIds))
  );
  await deps.index.record(
    userId,
    [...live.values()].flatMap((answer) =>
      answer.sets.map((set) => ({
        environmentId: answer.environmentId,
        backupId: set.backupId,
        createdAtMs: set.createdAtMs,
        sizeBytes: set.sizeBytes,
        pinned: set.pinned,
        operation: set.operation,
      }))
    )
  );

  sets.sort(
    (left, right) =>
      right.createdAtMs - left.createdAtMs ||
      left.environmentId.localeCompare(right.environmentId) ||
      left.backupId.localeCompare(right.backupId)
  );

  const retention = backupRetentionPolicy();
  return {
    setCount: sets.length,
    sizeBytes: sets.reduce((total, set) => total + set.sizeBytes, 0),
    pinnedSizeBytes: sets
      .filter((set) => set.pinned)
      .reduce((total, set) => total + set.sizeBytes, 0),
    retentionCount: retention.count,
    retentionBytes: retention.bytes,
    sets,
    unreachableEnvironmentIds,
  };
}

/**
 * Deletes one set on the machine that holds it, then drops its index row.
 *
 * The row goes only after the machine confirms, so a purge that could not reach
 * the disk leaves the user looking at a backup that still exists rather than one
 * that silently disappeared from the list while its bytes stayed.
 */
export async function purgeEnvironmentBackup(
  userId: string,
  environmentId: string,
  backupId: string,
  overrides: Partial<BackupInventoryDeps> = {}
): Promise<void> {
  const deps = { ...defaultDeps(), ...overrides };
  const client = await deps.client(userId, environmentId);
  const policy = backupPolicyFor(client, environmentId);
  const result = await client.library.gc(
    {
      backupRoot: policy.backupRoot,
      retentionCount: policy.retentionCount,
      retentionBytes: policy.retentionBytes,
      purgeBackupIds: [backupId],
    },
    { timeoutMs: BACKUP_REQUEST_TIMEOUT_MS }
  );
  await deps.index.forget(userId, environmentId, [...result.purged, ...result.pruned]);
}

/**
 * Records a set an apply or removal just wrote.
 *
 * `sizeBytes` is left at zero: the hub does not measure another machine's disk,
 * and the first listing that reaches the store replaces every number here with
 * what it actually found. What matters now is that the row exists — a set
 * written to a machine that goes offline before the next page load is exactly
 * the case the index is for.
 */
export async function recordWrittenBackup(
  userId: string,
  input: {
    readonly environmentId: string;
    readonly backupId: string;
    readonly operation: 'propagation' | 'removal';
    readonly pinned: boolean;
    readonly createdAtMs: number;
  },
  index: LibraryBackupIndex = createLibraryBackupIndex()
): Promise<void> {
  await index.record(userId, [
    {
      environmentId: input.environmentId,
      backupId: input.backupId,
      createdAtMs: input.createdAtMs,
      sizeBytes: 0,
      pinned: input.pinned,
      operation: input.operation,
    },
  ]);
}
