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
  type RuntimeGitExecParams,
  type RuntimeGitExecResult,
  type RuntimeGlobParams,
  type RuntimeGlobResult,
  type RuntimeGrepParams,
  type RuntimeGrepResult,
  type RuntimeInstallCancelParams,
  type RuntimeInstallRunParams,
  type RuntimeInstallRunResult,
  type RuntimeListDirectoryParams,
  type RuntimeListDirectoryResult,
  type RuntimeMcpAckResult,
  type RuntimeMcpCallResult,
  type RuntimeMcpCallToolParams,
  type RuntimeMcpConnectParams,
  type RuntimeMcpConnectResult,
  type RuntimeMcpElicitResponseParams,
  type RuntimeMcpGetPromptParams,
  type RuntimeMcpListPromptsResult,
  type RuntimeMcpListResourcesResult,
  type RuntimeMcpListToolsResult,
  type RuntimeMcpPromptResult,
  type RuntimeMcpReadResourceParams,
  type RuntimeMcpReadResourceResult,
  type RuntimeMcpServerParams,
  type RuntimeMethod,
  type RuntimeMethodMap,
  type RuntimeMoveFileParams,
  type RuntimeMoveFileResult,
  type RuntimeMutationResult,
  type RuntimeProbeAgentClisParams,
  type RuntimeProbeAgentClisResult,
  type RuntimeProbeRuntimesParams,
  type RuntimeProbeRuntimesResult,
  type RuntimeProbeVersionManagersParams,
  type RuntimeProbeVersionManagersResult,
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
  type RuntimeWorkspaceBrowseParams,
  type RuntimeWorkspaceBrowseResult,
  type RuntimeWorkspaceResolveContainedParams,
  type RuntimeWorkspaceResolveContainedResult,
  type RuntimeWorkspaceValidateParams,
  type RuntimeWorkspaceValidateResult,
  type RuntimeWriteFileParams,
  type RuntimeWriteFileResult,
  ShellExecutionError,
  StaleFileError,
  StaleLineNumbersError,
} from '@mangostudio/runtime';
import type { RuntimeEventFrame } from '@mangostudio/shared/runtime-protocol';
import { McpConnectionError } from '../mcp/types';
import { ToolArgumentError } from '../tools/arg-parsing';
import { ToolExecutionTimedOutError } from '../tools/execution-timeout';
import { createTargetPaths, type TargetPaths } from './target-paths';

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

interface RuntimeGitClient {
  exec(
    params: RuntimeGitExecParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeGitExecResult>;
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

interface RuntimeWorkspaceClient {
  browse(
    params?: RuntimeWorkspaceBrowseParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeWorkspaceBrowseResult>;
  validate(
    params: RuntimeWorkspaceValidateParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeWorkspaceValidateResult>;
  resolveContained(
    params: RuntimeWorkspaceResolveContainedParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeWorkspaceResolveContainedResult>;
}

/**
 * MCP sessions live on the target machine, so every method here addresses one
 * by `serverId` rather than holding a client: the hub owns the rows and the
 * secrets, the runtime owns the connection.
 */
interface RuntimeMcpClient {
  connect(
    params: RuntimeMcpConnectParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeMcpConnectResult>;
  listTools(
    params: RuntimeMcpServerParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeMcpListToolsResult>;
  callTool(
    params: RuntimeMcpCallToolParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeMcpCallResult>;
  listResources(
    params: RuntimeMcpServerParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeMcpListResourcesResult>;
  readResource(
    params: RuntimeMcpReadResourceParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeMcpReadResourceResult>;
  listPrompts(
    params: RuntimeMcpServerParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeMcpListPromptsResult>;
  getPrompt(
    params: RuntimeMcpGetPromptParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeMcpPromptResult>;
  respondToElicitation(
    params: RuntimeMcpElicitResponseParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeMcpAckResult>;
  disconnect(
    params: RuntimeMcpServerParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeMcpAckResult>;
}

/**
 * Install execution on the target machine. The hub keeps the recipe, the audit
 * row and the decision to run at all; only the child process is over there.
 */
interface RuntimeInstallClient {
  run(
    params: RuntimeInstallRunParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeInstallRunResult>;
  cancel(
    params: RuntimeInstallCancelParams,
    options?: RuntimeRequestOptions
  ): Promise<{ readonly ok: true }>;
}

/**
 * Toolchain detection on the target machine. Every method takes what the hub
 * decided — which ids to look for, which of them it could install, which Node
 * releases it knows about — and returns the same status shapes the umbrella has
 * always published, resolved against that machine's PATH rather than the hub's.
 */
interface RuntimeProbingClient {
  runtimes(
    params: RuntimeProbeRuntimesParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeProbeRuntimesResult>;
  versionManagers(
    params: RuntimeProbeVersionManagersParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeProbeVersionManagersResult>;
  agentClis(
    params: RuntimeProbeAgentClisParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeProbeAgentClisResult>;
}

/** Typed API-side facade over the transport-level runtime request multiplexer. */
export class RuntimeClient {
  readonly fs: RuntimeFsClient;
  readonly shell: RuntimeShellClient;
  readonly git: RuntimeGitClient;
  readonly install: RuntimeInstallClient;
  readonly mcp: RuntimeMcpClient;
  readonly probing: RuntimeProbingClient;
  readonly snapshot: RuntimeSnapshotClient;
  readonly workspace: RuntimeWorkspaceClient;
  private targetPaths?: TargetPaths;

  constructor(
    private readonly protocol: RuntimeProtocolClient,
    private readonly onUnavailable?: () => void
  ) {
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
    this.git = {
      exec: (params, options) => this.request('git.exec', params, options),
    };
    this.mcp = {
      connect: (params, options) => this.request('mcp.connect', params, options),
      listTools: (params, options) => this.request('mcp.list-tools', params, options),
      callTool: (params, options) => this.request('mcp.call-tool', params, options),
      listResources: (params, options) => this.request('mcp.list-resources', params, options),
      readResource: (params, options) => this.request('mcp.read-resource', params, options),
      listPrompts: (params, options) => this.request('mcp.list-prompts', params, options),
      getPrompt: (params, options) => this.request('mcp.get-prompt', params, options),
      respondToElicitation: (params, options) =>
        this.request('mcp.elicit-response', params, options),
      disconnect: (params, options) => this.request('mcp.disconnect', params, options),
    };
    this.install = {
      run: (params, options) => this.request('install.run', params, options),
      cancel: (params, options) => this.request('install.cancel', params, options),
    };
    this.probing = {
      runtimes: (params, options) => this.request('probing.runtimes', params, options),
      versionManagers: (params, options) =>
        this.request('probing.version-managers', params, options),
      agentClis: (params, options) => this.request('probing.agent-clis', params, options),
    };
    this.snapshot = {
      capture: (params, options) => this.request('snapshot.capture', params, options),
      hash: (params, options) => this.request('snapshot.hash', params, options),
      revert: (params, options) => this.request('snapshot.revert', params, options),
    };
    this.workspace = {
      browse: (params = {}, options) => this.request('workspace.browse', params, options),
      validate: (params, options) => this.request('workspace.validate', params, options),
      resolveContained: (params, options) =>
        this.request('workspace.resolve-contained', params, options),
    };
  }

  get manifest(): RuntimeCapabilityManifest {
    return this.protocol.manifest;
  }

  /**
   * Path semantics of the target, for the resolution the hub still does before
   * it calls. Read from this client so a caller cannot pair one environment's
   * manifest with another environment's connection.
   */
  get paths(): TargetPaths {
    this.targetPaths ??= createTargetPaths(this.protocol.manifest);
    return this.targetPaths;
  }

  get runtimeVersion(): string {
    return this.protocol.runtimeVersion;
  }

  /**
   * Subscribes to the runtime's `evt` stream. Returns the unsubscribe; the
   * connection dropping clears every listener on its own, so a caller that
   * forgets one leaks nothing past the socket.
   */
  onEvent(listener: (event: RuntimeEventFrame) => void): () => void {
    return this.protocol.onEvent(listener);
  }

  /**
   * Subscribes to transport teardown. MCP handles use this so a dead runtime
   * connection cannot keep returning a handle whose session is already gone.
   */
  onClose(listener: () => void): () => void {
    return this.protocol.onClose(listener);
  }

  private async request<K extends RuntimeMethod>(
    method: K,
    params: RuntimeMethodMap[K]['params'],
    options?: RuntimeRequestOptions
  ): Promise<RuntimeMethodMap[K]['result']> {
    try {
      return await this.protocol.request(method, params, options);
    } catch (error) {
      if (error instanceof RuntimeRemoteError && error.code === 'RUNTIME_UNAVAILABLE') {
        this.onUnavailable?.();
      }
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
    case 'mcp_connection':
      return new McpConnectionError(error.message, { cause: error });
    default:
      // `mcp_call` deliberately stays a RuntimeRemoteError: the turn pipeline
      // classifies it from the `mcpFailure` detail the runtime attached, and
      // wrapping it here would drop that.
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
