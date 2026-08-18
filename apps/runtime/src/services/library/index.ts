export {
  createPropagationWriteEngineDeps,
  type ExecutePropagationWritesParams,
  executePropagationWrites,
  type PropagationWriteEngineDeps,
} from './apply-writes';
export {
  assertBackupId,
  type BackupEntry,
  type BackupManifest,
  type BackupStoreDeps,
  backupExistingResource,
  type CreateBackupStoreDepsOptions,
  createBackupId,
  createBackupStoreDeps,
  discardBackupSet,
  listBackupSets,
  pruneBackupSets,
  purgeBackupSet,
  readBackupManifest,
  restoreBackupEntry,
  writeBackupManifest,
} from './backup-store';
export {
  type CachedInstanceDisplay,
  type CachedInstanceHash,
  LIBRARY_SCAN_CACHE_TTL_MS,
  LibraryCache,
  libraryCache,
} from './cache';
export {
  type LibraryScanOptions,
  type LibraryScanTarget,
  resolveLibraryScanTargets,
  scanLibraryInstances,
} from './discovery';
export {
  hashResourceAt,
  type LibraryInstanceReaderFs,
  MAX_LIBRARY_FILE_BYTES,
  MAX_LIBRARY_INSTANCE_BYTES,
  MAX_SKILL_ENTRYPOINT_BYTES,
  type ReadLibraryInstance,
  type ReadLibraryInstancesOptions,
  type ReadLocationInstancesResult,
  readLocationInstances,
  readResourceFile,
} from './instance-reader';
export {
  assertExpectedResourceEntry,
  type ContainedResourcePath,
  LibraryWriteError,
  type LibraryWriteFailure,
  resolveContainedResourcePath,
} from './path-safety';
export {
  LibraryReadDeniedError,
  type LibraryReadParams,
  type LibraryReadResult,
  libraryContentPath,
  MAX_LIBRARY_CONTENT_BYTES,
  readLibraryContent,
} from './read';
export {
  createRemovalWriteEngineDeps,
  type ExecuteRemovalWritesParams,
  executeRemovalWrites,
  type RemovalWriteEngineDeps,
} from './remove-writes';
export {
  type CreateResourceWriterDepsOptions,
  createResourceWriterDeps,
  type DirectoryResourceWriteInput,
  type FileResourceWriteInput,
  type ResolvedDestination,
  type ResourceWriteResult,
  type ResourceWriterDeps,
  type ResourceWriterFs,
  requireWritableLocation,
  resolveResourceDestination,
  writeDirectoryResource,
  writeFileResource,
} from './resource-writer';
export {
  createLibraryService,
  type LibraryHostAdapters,
  type LibraryService,
  libraryService,
  scanLibraryInstancesForPathEnv,
} from './service';
export {
  type RuntimeSettingsSource,
  type RuntimeSettingsSourcesResult,
  readSettingsSources,
} from './settings-sources';
export {
  findStagedRemovalLeftovers,
  findStagedRemovalsForLocations,
  nodeTreeRemovalFs,
  type StagedRemoval,
  stagedRemovalDirectory,
  stageResourceRemoval,
  type TreeRemovalFs,
} from './tree-removal';
export {
  createLibraryUndoEngineDeps,
  type ExecuteLibraryUndoParams,
  executeLibraryUndo,
  LibraryBackupMissingError,
  type LibraryUndoEngineDeps,
} from './undo-writes';
export type {
  PreparedPropagationAdaptation,
  PreparedPropagationFile,
  PreparedPropagationOperation,
  PreparedRemovalOperation,
} from './write-shapes';
