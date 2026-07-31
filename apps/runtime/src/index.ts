export { RuntimeProtocolClient, type RuntimeRequestOptions } from './client';
export {
  PathAccessError,
  RuntimeRemoteError,
  RuntimeServiceError,
  RuntimeToolArgumentError,
} from './errors';
export {
  type RuntimeHandlerContext,
  RuntimeHost,
  type RuntimeMethodHandler,
} from './host';
export { createLocalRuntimeManifest } from './manifest';
export type * from './methods';
export { createRuntimeMethodHandlers } from './registry';
export { createLocalRuntimeHost } from './runtime';
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
  createInProcessPortPair,
  type InProcessPortPair,
  type RuntimeFramePort,
} from './transport';
export {
  connectInProcessRuntime,
  type InProcessRuntimeConnection,
} from './transports/in-process';
