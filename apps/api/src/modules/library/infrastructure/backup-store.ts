/**
 * Hub-side backup-store bindings. The durable copies live on the runtime host;
 * this module only supplies hub config defaults and keeps the historical import
 * path for routes and tests.
 */

import {
  assertBackupId as assertBackupIdRuntime,
  type BackupEntry,
  type BackupManifest,
  type BackupStoreDeps,
  backupExistingResource as backupExistingResourceRuntime,
  createBackupId as createBackupIdRuntime,
  createBackupStoreDeps,
  discardBackupSet as discardBackupSetRuntime,
  listBackupSets as listBackupSetsRuntime,
  pruneBackupSets as pruneBackupSetsRuntime,
  purgeBackupSet as purgeBackupSetRuntime,
  readBackupManifest as readBackupManifestRuntime,
  restoreBackupEntry as restoreBackupEntryRuntime,
  writeBackupManifest as writeBackupManifestRuntime,
} from '@mangostudio/runtime';
import { getConfig } from '../../../lib/config';

export type { BackupEntry, BackupManifest, BackupStoreDeps };

/** Hub default: backup root and retention come from hub config, never the runtime. */
export const defaultBackupStoreDeps: BackupStoreDeps = createBackupStoreDeps({
  backupRoot: () => getConfig().library.backupDir,
  retentionCount: () => getConfig().library.backupRetentionCount,
  retentionBytes: () => getConfig().library.backupRetentionBytes,
});

export function createBackupId(deps: BackupStoreDeps = defaultBackupStoreDeps): string {
  return createBackupIdRuntime(deps);
}

export function assertBackupId(backupId: string): void {
  assertBackupIdRuntime(backupId);
}

export function backupExistingResource(
  input: Parameters<typeof backupExistingResourceRuntime>[0],
  deps: BackupStoreDeps = defaultBackupStoreDeps
): Promise<string> {
  return backupExistingResourceRuntime(input, deps);
}

export function writeBackupManifest(
  manifest: BackupManifest,
  deps: BackupStoreDeps = defaultBackupStoreDeps
): Promise<void> {
  return writeBackupManifestRuntime(manifest, deps);
}

export function readBackupManifest(
  backupId: string,
  deps: BackupStoreDeps = defaultBackupStoreDeps
): Promise<BackupManifest | null> {
  return readBackupManifestRuntime(backupId, deps);
}

export function restoreBackupEntry(
  entry: BackupEntry,
  deps: BackupStoreDeps = defaultBackupStoreDeps
): Promise<void> {
  return restoreBackupEntryRuntime(entry, deps);
}

export function discardBackupSet(
  backupId: string,
  deps: BackupStoreDeps = defaultBackupStoreDeps
): Promise<void> {
  return discardBackupSetRuntime(backupId, deps);
}

export function purgeBackupSet(
  backupId: string,
  deps: BackupStoreDeps = defaultBackupStoreDeps
): Promise<boolean> {
  return purgeBackupSetRuntime(backupId, deps);
}

export function pruneBackupSets(
  currentBackupId: string,
  deps: BackupStoreDeps = defaultBackupStoreDeps
): Promise<void> {
  return pruneBackupSetsRuntime(currentBackupId, deps);
}

export function listBackupSets(
  deps: BackupStoreDeps = defaultBackupStoreDeps
): ReturnType<typeof listBackupSetsRuntime> {
  return listBackupSetsRuntime(deps);
}
