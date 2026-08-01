export type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-protocol';
export { RuntimeProtocolClient, type RuntimeRequestOptions } from './client';
export {
  PathAccessError,
  RuntimeRemoteError,
  RuntimeServiceError,
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
  RUNTIME_MCP_ELICITATION_TOPIC,
  RUNTIME_MCP_SESSION_TOPIC,
} from './methods';
export {
  createRuntimeMethodHandlers,
  type RuntimeMethodRegistry,
  type RuntimeMethodRegistryOptions,
} from './registry';
export { createLocalRuntimeHost } from './runtime';
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
export {
  assertFresh,
  assertFreshContent,
  assertLineNumbersCurrent,
  clearFileFreshness,
  FileNotReadError,
  forgetFile,
  type ObservedLineRange,
  PartialReadError,
  readFreshFile,
  recordFileEdit,
  recordFileRead,
  rekeyFile,
  StaleFileError,
  StaleLineNumbersError,
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
  READ_FILE_MAX_BYTES,
  readFileWithObservedMtime,
} from './services/fs-utils';
export {
  buildGitArgv,
  buildGitEnvironment,
  execGit,
  GitExecutionError,
} from './services/git';
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
