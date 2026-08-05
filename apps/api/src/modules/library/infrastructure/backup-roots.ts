/**
 * Where each environment's library backups live, and the bounds they are kept
 * to.
 *
 * 017 made `backupRoot` a method parameter precisely so this decision could be
 * made here rather than baked into the runtime: the Local store honours the
 * user's `library.backup_dir` override and the test redirect, and a remote store
 * has to be resolved against *its* home directory, not the hub's. A runtime that
 * invented `~/.mango/library-backups` for itself would ignore both.
 *
 * Retention is hub policy applied per environment. The bounds are the same
 * numbers everywhere, but each store is trimmed to them on its own disk — one
 * machine filling the budget must never evict another machine's history.
 */

import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { getConfig } from '../../../lib/config';
import type { RuntimeClient } from '../../../services/runtime-client';
import { LibraryRequestError } from '../domain/library-request-error';

/**
 * Default store on a machine the hub does not share a disk with.
 *
 * Deliberately the same shape as the Local default (`~/.mango/library-backups`)
 * so an operator reading one machine's layout has read them all — but resolved
 * through the connection's `TargetPaths`, so a Windows target gets its own
 * separator and its own home rather than the hub's.
 */
const REMOTE_BACKUP_DIR_SEGMENT = '.mango/library-backups';

export interface EnvironmentBackupPolicy {
  readonly environmentId: string;
  readonly backupRoot: string;
  readonly retentionCount: number;
  readonly retentionBytes: number;
}

/**
 * Hub-configured bounds, shared by every environment.
 *
 * Read on each call rather than captured: the config is reloadable and the test
 * harness redirects it, and a captured copy would keep pointing at the real home
 * directory for the life of the process.
 */
export function backupRetentionPolicy(): { count: number; bytes: number } {
  const config = getConfig();
  return {
    count: config.library.backupRetentionCount,
    bytes: config.library.backupRetentionBytes,
  };
}

function resolveBackupRoot(client: RuntimeClient, environmentId: string): string {
  if (environmentId === LOCAL_ENVIRONMENT_ID) return getConfig().library.backupDir;

  const paths = client.paths;
  // `TargetPaths.homeDir` is empty when the peer reported a relative home, which
  // it drops rather than expand. Joining onto it would resolve against the
  // runtime's working directory — a directory the machine's owner never agreed
  // to have backups written into, and one a later `undo` may not find again.
  if (paths.homeDir.length === 0) {
    throw new LibraryRequestError(
      422,
      `Environment "${environmentId}" did not report a usable home directory, so there is nowhere to keep its library backups.`
    );
  }
  return paths.join(paths.homeDir, REMOTE_BACKUP_DIR_SEGMENT);
}

export function backupPolicyFor(
  client: RuntimeClient,
  environmentId: string
): EnvironmentBackupPolicy {
  const retention = backupRetentionPolicy();
  return {
    environmentId,
    backupRoot: resolveBackupRoot(client, environmentId),
    retentionCount: retention.count,
    retentionBytes: retention.bytes,
  };
}
