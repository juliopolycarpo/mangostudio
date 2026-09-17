/**
 * Hub-side backup-store bindings. The durable copies live on the runtime host;
 * this module only supplies hub config defaults and keeps the historical import
 * path for routes and tests.
 */

import {
  assertBackupId as assertBackupIdEngine,
  type BackupEntry,
  type BackupManifest,
  type BackupStoreDeps,
  backupExistingResource as backupExistingResourceEngine,
  createBackupId as createBackupIdEngine,
  createBackupStoreDeps,
  discardBackupSet as discardBackupSetEngine,
  listBackupSets as listBackupSetsEngine,
  pruneBackupSets as pruneBackupSetsEngine,
  purgeBackupSet as purgeBackupSetEngine,
  readBackupManifest as readBackupManifestEngine,
  restoreBackupEntry as restoreBackupEntryEngine,
  writeBackupManifest as writeBackupManifestEngine,
} from '@mangostudio/shared/library/machine';
import { getConfig } from '../../../lib/config';

export type { BackupEntry, BackupManifest, BackupStoreDeps };

/** Hub default: backup root and retention come from hub config, never the runtime. */
export const defaultBackupStoreDeps: BackupStoreDeps = createBackupStoreDeps({
  backupRoot: () => getConfig().library.backupDir,
  retentionCount: () => getConfig().library.backupRetentionCount,
  retentionBytes: () => getConfig().library.backupRetentionBytes,
});

export function createBackupId(deps: BackupStoreDeps = defaultBackupStoreDeps): string {
  return createBackupIdEngine(deps);
}

export function assertBackupId(backupId: string): void {
  assertBackupIdEngine(backupId);
}

export function backupExistingResource(
  input: Parameters<typeof backupExistingResourceEngine>[0],
  deps: BackupStoreDeps = defaultBackupStoreDeps
): Promise<string> {
  return backupExistingResourceEngine(input, deps);
}

export function writeBackupManifest(
  manifest: BackupManifest,
  deps: BackupStoreDeps = defaultBackupStoreDeps
): Promise<void> {
  return writeBackupManifestEngine(manifest, deps);
}

export function readBackupManifest(
  backupId: string,
  deps: BackupStoreDeps = defaultBackupStoreDeps
): Promise<BackupManifest | null> {
  return readBackupManifestEngine(backupId, deps);
}

export function restoreBackupEntry(
  entry: BackupEntry,
  deps: BackupStoreDeps = defaultBackupStoreDeps
): Promise<void> {
  return restoreBackupEntryEngine(entry, deps);
}

export function discardBackupSet(
  backupId: string,
  deps: BackupStoreDeps = defaultBackupStoreDeps
): Promise<void> {
  return discardBackupSetEngine(backupId, deps);
}

export function purgeBackupSet(
  backupId: string,
  deps: BackupStoreDeps = defaultBackupStoreDeps
): Promise<boolean> {
  return purgeBackupSetEngine(backupId, deps);
}

export function pruneBackupSets(
  currentBackupId: string,
  deps: BackupStoreDeps = defaultBackupStoreDeps
): Promise<void> {
  return pruneBackupSetsEngine(currentBackupId, deps);
}

export function listBackupSets(
  deps: BackupStoreDeps = defaultBackupStoreDeps
): ReturnType<typeof listBackupSetsEngine> {
  return listBackupSetsEngine(deps);
}
