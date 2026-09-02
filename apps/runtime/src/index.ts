export type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-protocol';
export { RuntimeProtocolClient, type RuntimeRequestOptions } from './client';
export { CONSENT_DENIED_KIND, RUNTIME_METHOD_CAPABILITIES } from './consent-gate';
export {
  createSlotConsentSource,
  type RuntimeConsentSource,
  staticConsentSource,
} from './consent-source';
export {
  LIBRARY_BACKUP_MISSING_KIND,
  PathAccessError,
  RuntimeConsentDeniedError,
  RuntimeRemoteError,
  RuntimeServiceError,
  RuntimeServiceManagementError,
  RuntimeToolArgumentError,
} from './errors';
export {
  type RuntimeEventInput,
  type RuntimeHandlerContext,
  RuntimeHost,
  type RuntimeMethodHandler,
} from './host';
export { livenessIntervalFor, startProtocolLiveness } from './liveness';
export { createLocalRuntimeManifest } from './manifest';
export type * from './methods';
export {
  RUNTIME_ABSENT_HASH,
  RUNTIME_EXTERNAL_AGENT_TOPIC,
  RUNTIME_INSTALL_OUTPUT_TOPIC,
  RUNTIME_MCP_ELICITATION_TOPIC,
  RUNTIME_MCP_SESSION_TOPIC,
  RUNTIME_READ_FILE_VIEWS,
  RUNTIME_TERMINAL_OUTPUT_TOPIC,
} from './methods';
export {
  createRuntimeMethodHandlers,
  type RuntimeMethodRegistry,
  type RuntimeMethodRegistryOptions,
} from './registry';
export { createLocalRuntimeHost, createSlotRuntimeHost, type SlotRuntimeHost } from './runtime';
export {
  RUNTIME_SETUP_PENDING_MESSAGE,
  RUNTIME_SETUP_PENDING_SIGNATURE,
} from './runtime-home';
export {
  bearerToken,
  isLoopbackHostname,
  parseListenAddress,
  type RuntimeServeHandle,
  type RuntimeServeListen,
  type RuntimeServeOptions,
  serveRuntime,
  tokensEqual,
} from './serve';
export type * from './services/external-agents/adapter';
export { createSingleUserHostExternalAgentIsolation } from './services/external-agents/isolation';
export {
  assertExternalAgentAdapterConformance,
  ExternalAgentAdapterRegistry,
} from './services/external-agents/registry';
export {
  ExternalAgentSessionSupervisor,
  type ExternalAgentSupervisorOptions,
} from './services/external-agents/supervisor';
export {
  assertFresh,
  assertFreshContent,
  assertLineNumbersCurrent,
  clearFileFreshness,
  FileNotReadError,
  type FileReadObservation,
  forgetFile,
  type ObservedLineRange,
  PartialReadError,
  readFreshFile,
  recordFileEdit,
  recordFileRead,
  rekeyFile,
  StaleFileError,
  StaleLineNumbersError,
  UnobservedLineNumbersError,
  withPathLocks,
} from './services/file-freshness';
export { GrepPatternError } from './services/fs/grep';
export {
  countTotalLines,
  findWindowByteRange,
  looksBinary,
  READ_FILE_MAX_LINE_CHARS,
  READ_FILE_MAX_MAX_LINES,
  READ_FILE_MAX_START_LINE,
  READ_FILE_MAX_WINDOW_BYTES,
  READ_FILE_MIN_MAX_LINES,
} from './services/fs/read-file';
export {
  BINARY_SNIFF_BYTES,
  containsNulByte,
  type ObservedFileRead,
  READ_FILE_MAX_BINARY_VIEW_BYTES,
  READ_FILE_MAX_BYTES,
  readFileWithObservedMtime,
} from './services/fs-utils';
export {
  buildGhArgv,
  buildGhEnvironment,
  execGh,
  GhExecutionError,
  mutateGh,
  summarizeGhSubcommand,
} from './services/gh';
export {
  buildGitArgv,
  buildGitEnvironment,
  execGit,
  GitExecutionError,
} from './services/git';
export { createInstallService } from './services/install';
export {
  assertBackupId,
  assertExpectedResourceEntry,
  type BackupEntry,
  type BackupManifest,
  type BackupStoreDeps,
  backupExistingResource,
  type CachedInstanceDisplay,
  type CachedInstanceHash,
  type ContainedResourcePath,
  type CreateBackupStoreDepsOptions,
  type CreateResourceWriterDepsOptions,
  createBackupId,
  createBackupStoreDeps,
  createLibraryService,
  createLibraryUndoEngineDeps,
  createPropagationWriteEngineDeps,
  createRemovalWriteEngineDeps,
  createResourceWriterDeps,
  type DirectoryResourceWriteInput,
  discardBackupSet,
  type ExecuteLibraryUndoParams,
  type ExecutePropagationWritesParams,
  type ExecuteRemovalWritesParams,
  executeLibraryUndo,
  executePropagationWrites,
  executeRemovalWrites,
  type FileResourceWriteInput,
  findStagedRemovalLeftovers,
  findStagedRemovalsForLocations,
  hashResourceAt,
  LIBRARY_SCAN_CACHE_TTL_MS,
  LibraryBackupMissingError,
  LibraryCache,
  type LibraryHostAdapters,
  type LibraryInstanceReaderFs,
  LibraryReadDeniedError,
  type LibraryReadParams,
  type LibraryReadResult,
  type LibraryScanOptions,
  type LibraryScanTarget,
  type LibraryService,
  type LibraryUndoEngineDeps,
  LibraryWriteError,
  type LibraryWriteFailure,
  libraryCache,
  libraryContentPath,
  libraryService,
  listBackupSets,
  MAX_LIBRARY_CONTENT_BYTES,
  MAX_LIBRARY_FILE_BYTES,
  MAX_LIBRARY_INSTANCE_BYTES,
  MAX_SKILL_ENTRYPOINT_BYTES,
  nodeTreeRemovalFs,
  type PreparedPropagationAdaptation,
  type PreparedPropagationFile,
  type PreparedPropagationOperation,
  type PreparedRemovalOperation,
  type PropagationWriteEngineDeps,
  pruneBackupSets,
  purgeBackupSet,
  type ReadLibraryInstance,
  type ReadLibraryInstancesOptions,
  type ReadLocationInstancesResult,
  type RemovalWriteEngineDeps,
  type ResolvedDestination,
  type ResourceWriteResult,
  type ResourceWriterDeps,
  type ResourceWriterFs,
  type RuntimeSettingsSource,
  type RuntimeSettingsSourcesResult,
  readBackupManifest,
  readLibraryContent,
  readLocationInstances,
  readResourceFile,
  readSettingsSources,
  requireWritableLocation,
  resolveContainedResourcePath,
  resolveLibraryScanTargets,
  resolveResourceDestination,
  restoreBackupEntry,
  type StagedRemoval,
  scanLibraryInstances,
  scanLibraryInstancesForPathEnv,
  stagedRemovalDirectory,
  stageResourceRemoval,
  type TreeRemovalFs,
  writeBackupManifest,
  writeDirectoryResource,
  writeFileResource,
} from './services/library';
export {
  classifyMcpCallFailure,
  connectMcpClient,
  DEFAULT_MCP_TIMEOUT_MS,
  shouldFallBackToSse,
  wrapMcpClient,
} from './services/mcp/client-factory';
export {
  capMcpResultText,
  flattenMcpContent,
  MCP_RESULT_MAX_BYTES,
  MCP_RESULT_TRUNCATION_MARKER,
  normalizeMcpContent,
} from './services/mcp/content-mapping';
export {
  type McpService,
  type McpTransportFactory,
  setMcpTransportFactoryForTest,
} from './services/mcp/service';
export { buildStdioEnv } from './services/mcp/stdio-env';
export {
  type McpClientHandle,
  McpConnectionError,
  type McpElicitationRequest,
  type McpElicitationResult,
  type McpRequestOptions,
  type McpServerCapabilities,
} from './services/mcp/types';
export {
  assertInsideWorkdir,
  isInside,
  isPathPrefix,
  resolveContainmentRoot,
  resolvePathForContainment,
  resolvePathThroughExistingAncestor,
  WorkdirContainmentError,
} from './services/path-containment';
export {
  createRuntimePathEnv,
  NODE_AUTH_SIGNAL_FS,
  NODE_LOCATION_FS_PROBE,
} from './services/probing/host-env';
export {
  createProbingService,
  type ProbingHostAdapters,
  type ProbingService,
  probingService,
} from './services/probing/service';
export { HIDDEN_WINDOW } from './services/process-window';
export {
  findShellExecutable,
  isShellAvailable,
  runShellCommand,
  runShellCommandWithDeps,
  type ShellCommandResult,
  type ShellExecDependencies,
  ShellExecutionError,
  type ShellKind,
} from './services/shell';
export {
  isSecretEnvKey,
  type ShellEnvPolicy,
  sanitizeShellEnv,
} from './services/shell-env';
export {
  captureFileSnapshot,
  hashFileAtPath,
  RuntimeSnapshotConflictError,
} from './services/snapshot';
export {
  createUserServiceManager,
  defaultUserServiceExecDeps,
  isUserServiceAction,
  USER_SERVICE_ACTIONS,
  USER_SERVICE_NO_SESSION_BUS_ERROR,
  type UserServiceAction,
  type UserServiceDefinition,
  type UserServiceExecDeps,
  type UserServiceExecResult,
  type UserServiceIdentity,
  type UserServiceManager,
} from './services/user-service-manager';
export {
  browseWorkspace,
  MAX_WORKSPACE_DIRECTORY_ENTRIES,
  resolveContainedWorkspacePath,
  validateWorkdir,
  WorkspaceBrowserError,
  WorkspaceContainmentError,
} from './services/workspace';
export { resolveWorkspacePath, WorkspacePathError } from './services/workspace-path';
export {
  createInProcessPortPair,
  type InProcessPortPair,
  type RuntimeFramePort,
} from './transport';
export {
  connectInProcessRuntime,
  type InProcessRuntimeConnection,
} from './transports/in-process';
export {
  createStdioFramePort,
  type StdioFramePortClosure,
} from './transports/stdio';
export {
  type ClientWebSocketLike,
  clientWebSocketSink,
  createWebSocketFramePort,
  type ServerWebSocketLike,
  serverWebSocketSink,
  type WebSocketFramePort,
  type WebSocketFramePortClosure,
  type WebSocketFrameSink,
  type WebSocketSendResult,
} from './transports/websocket';
