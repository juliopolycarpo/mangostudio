import {
  FileNotReadError,
  GrepPatternError,
  PartialReadError,
  PathAccessError,
  type RuntimeApplyPatchParams,
  type RuntimeApplyPatchResult,
  type RuntimeBeforeSnapshot,
  type RuntimeCapabilityManifest,
  type RuntimeCreateFileParams,
  type RuntimeCreateFileResult,
  type RuntimeDeleteFileParams,
  type RuntimeDeleteFileResult,
  type RuntimeEditFileParams,
  type RuntimeEditFileResult,
  type RuntimeGlobParams,
  type RuntimeGlobResult,
  type RuntimeGrepParams,
  type RuntimeGrepResult,
  type RuntimeListDirectoryParams,
  type RuntimeListDirectoryResult,
  type RuntimeMethod,
  type RuntimeMethodMap,
  type RuntimeMoveFileParams,
  type RuntimeMoveFileResult,
  type RuntimeMutationResult,
  type RuntimeProtocolClient,
  type RuntimeReadFileParams,
  type RuntimeReadFileResult,
  RuntimeRemoteError,
  type RuntimeReplaceRangeParams,
  type RuntimeReplaceRangeResult,
  type RuntimeRequestOptions,
  type RuntimeShellResult,
  type RuntimeShellRunParams,
  type RuntimeSnapshotCaptureParams,
  RuntimeSnapshotConflictError,
  type RuntimeSnapshotHashParams,
  type RuntimeSnapshotHashResult,
  type RuntimeSnapshotRevertParams,
  type RuntimeSnapshotRevertResult,
  type RuntimeWriteFileParams,
  type RuntimeWriteFileResult,
  ShellExecutionError,
  StaleFileError,
  StaleLineNumbersError,
} from '@mangostudio/runtime';
import { ToolArgumentError } from '../tools/arg-parsing';
import { ToolExecutionTimedOutError } from '../tools/execution-timeout';

interface RuntimeFsClient {
  readFile(
    params: RuntimeReadFileParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeReadFileResult>;
  writeFile(
    params: RuntimeWriteFileParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeMutationResult<RuntimeWriteFileResult>>;
  createFile(
    params: RuntimeCreateFileParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeMutationResult<RuntimeCreateFileResult>>;
  editFile(
    params: RuntimeEditFileParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeMutationResult<RuntimeEditFileResult>>;
  replaceRange(
    params: RuntimeReplaceRangeParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeMutationResult<RuntimeReplaceRangeResult>>;
  deleteFile(
    params: RuntimeDeleteFileParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeMutationResult<RuntimeDeleteFileResult>>;
  moveFile(
    params: RuntimeMoveFileParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeMutationResult<RuntimeMoveFileResult>>;
  listDirectory(
    params: RuntimeListDirectoryParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeListDirectoryResult>;
  glob(params: RuntimeGlobParams, options?: RuntimeRequestOptions): Promise<RuntimeGlobResult>;
  grep(params: RuntimeGrepParams, options?: RuntimeRequestOptions): Promise<RuntimeGrepResult>;
  applyPatch(
    params: RuntimeApplyPatchParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeMutationResult<RuntimeApplyPatchResult>>;
}

interface RuntimeShellClient {
  run(params: RuntimeShellRunParams, options?: RuntimeRequestOptions): Promise<RuntimeShellResult>;
}

interface RuntimeSnapshotClient {
  capture(
    params: RuntimeSnapshotCaptureParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeBeforeSnapshot>;
  hash(
    params: RuntimeSnapshotHashParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeSnapshotHashResult>;
  revert(
    params: RuntimeSnapshotRevertParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeSnapshotRevertResult>;
}

/** Typed API-side facade over the transport-level runtime request multiplexer. */
export class RuntimeClient {
  readonly fs: RuntimeFsClient;
  readonly shell: RuntimeShellClient;
  readonly snapshot: RuntimeSnapshotClient;

  constructor(private readonly protocol: RuntimeProtocolClient) {
    this.fs = {
      readFile: (params, options) => this.request('fs.read-file', params, options),
      writeFile: (params, options) => this.request('fs.write-file', params, options),
      createFile: (params, options) => this.request('fs.create-file', params, options),
      editFile: (params, options) => this.request('fs.edit-file', params, options),
      replaceRange: (params, options) => this.request('fs.replace-range', params, options),
      deleteFile: (params, options) => this.request('fs.delete-file', params, options),
      moveFile: (params, options) => this.request('fs.move-file', params, options),
      listDirectory: (params, options) => this.request('fs.list-directory', params, options),
      glob: (params, options) => this.request('fs.glob', params, options),
      grep: (params, options) => this.request('fs.grep', params, options),
      applyPatch: (params, options) => this.request('fs.apply-patch', params, options),
    };
    this.shell = {
      run: (params, options) => this.request('shell.run', params, options),
    };
    this.snapshot = {
      capture: (params, options) => this.request('snapshot.capture', params, options),
      hash: (params, options) => this.request('snapshot.hash', params, options),
      revert: (params, options) => this.request('snapshot.revert', params, options),
    };
  }

  get manifest(): RuntimeCapabilityManifest {
    return this.protocol.manifest;
  }

  get runtimeVersion(): string {
    return this.protocol.runtimeVersion;
  }

  private async request<K extends RuntimeMethod>(
    method: K,
    params: RuntimeMethodMap[K]['params'],
    options?: RuntimeRequestOptions
  ): Promise<RuntimeMethodMap[K]['result']> {
    try {
      return await this.protocol.request(method, params, options);
    } catch (error) {
      throw translateRuntimeError(error);
    }
  }
}

function translateRuntimeError(error: unknown): Error {
  if (!(error instanceof RuntimeRemoteError)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  if (error.code === 'CANCELLED') {
    return new DOMException(error.message, 'AbortError');
  }
  if (error.code === 'TIMEOUT') {
    return new ToolExecutionTimedOutError(error.message);
  }

  const kind = detailString(error, 'kind');
  const resolvedPath = detailString(error, 'resolvedPath') ?? error.message;
  switch (kind) {
    case 'path_access':
      return new PathAccessError(error.message);
    case 'tool_argument':
      return new ToolArgumentError(error.message);
    case 'grep_pattern':
      return new GrepPatternError(error.message);
    case 'file_not_read':
      return withMessage(new FileNotReadError(resolvedPath), error.message);
    case 'partial_read':
      return withMessage(
        new PartialReadError(resolvedPath, detailNumber(error, 'coveredThroughLine')),
        error.message
      );
    case 'stale_file':
      return withMessage(new StaleFileError(resolvedPath), error.message);
    case 'stale_line_numbers':
      return withMessage(
        new StaleLineNumbersError(resolvedPath, detailNumber(error, 'validThroughLine')),
        error.message
      );
    case 'shell_execution':
      return new ShellExecutionError(error.message);
    case 'snapshot_conflict':
      return withMessage(new RuntimeSnapshotConflictError(resolvedPath), error.message);
    default:
      return error;
  }
}

function detailString(error: RuntimeRemoteError, key: string): string | undefined {
  const value = error.details?.[key];
  return typeof value === 'string' ? value : undefined;
}

function detailNumber(error: RuntimeRemoteError, key: string): number {
  const value = error.details?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function withMessage<T extends Error>(error: T, message: string): T {
  error.message = message;
  return error;
}
