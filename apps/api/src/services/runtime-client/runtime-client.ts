import {
  type ExternalAgentAckResult,
  type ExternalAgentCancelParams,
  type ExternalAgentCloseParams,
  type ExternalAgentDiscoverParams,
  type ExternalAgentDiscoverResult,
  type ExternalAgentEventEnvelope,
  type ExternalAgentListSessionsParams,
  type ExternalAgentListSessionsResult,
  type ExternalAgentOpenParams,
  type ExternalAgentOpenResult,
  type ExternalAgentRefreshAccountUsageParams,
  type ExternalAgentRefreshAccountUsageResult,
  type ExternalAgentRespondParams,
  type ExternalAgentStartReviewParams,
  type ExternalAgentStartReviewResult,
  type ExternalAgentSteerParams,
  type ExternalAgentSteerResult,
  type ExternalAgentTurnParams,
  type ExternalAgentTurnResult,
  FileNotReadError,
  GrepPatternError,
  PartialReadError,
  PathAccessError,
  RUNTIME_EXTERNAL_AGENT_TOPIC,
  type RuntimeApplyPatchParams,
  type RuntimeApplyPatchResult,
  type RuntimeBeforeSnapshot,
  type RuntimeCapabilityManifest,
  RuntimeConsentDeniedError,
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
  type RuntimeLibraryApplyParams,
  type RuntimeLibraryApplyResult,
  type RuntimeLibraryBackupsParams,
  type RuntimeLibraryBackupsResult,
  type RuntimeLibraryGcParams,
  type RuntimeLibraryGcResult,
  type RuntimeLibraryLocationsParams,
  type RuntimeLibraryLocationsResult,
  type RuntimeLibraryReadParams,
  type RuntimeLibraryReadResult,
  type RuntimeLibraryReadTreeParams,
  type RuntimeLibraryReadTreeResult,
  type RuntimeLibraryRemoveParams,
  type RuntimeLibraryRemoveResult,
  type RuntimeLibraryScanParams,
  type RuntimeLibraryScanResult,
  type RuntimeLibrarySettingsSourcesParams,
  type RuntimeLibraryUndoParams,
  type RuntimeLibraryUndoResult,
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
  type RuntimeSettingsSourcesResult,
  type RuntimeShellResult,
  type RuntimeShellRunParams,
  type RuntimeSnapshotCaptureParams,
  RuntimeSnapshotConflictError,
  type RuntimeSnapshotHashParams,
  type RuntimeSnapshotHashResult,
  type RuntimeSnapshotRevertParams,
  type RuntimeSnapshotRevertResult,
  type RuntimeUpdateBeginParams,
  type RuntimeUpdateBeginResult,
  type RuntimeUpdateChunkParams,
  type RuntimeUpdateChunkResult,
  type RuntimeUpdateCommitParams,
  type RuntimeUpdateCommitResult,
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
import { ExternalAgentEventEnvelopeSchema } from '@mangostudio/shared/external-agents';
import type {
  RuntimeEventFrame,
  RuntimePathPolicyParams,
} from '@mangostudio/shared/runtime-protocol';
import Value from 'typebox/value';
import { createDiagnosticLogger } from '../../lib/logger';
import { McpConnectionError } from '../mcp/types';
import { ToolArgumentError } from '../tools/arg-parsing';
import { ToolExecutionTimedOutError } from '../tools/execution-timeout';
import { createTargetPaths, type TargetPaths } from './target-paths';

const logger = createDiagnosticLogger('runtime-client');

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

/** Vendor-agent sessions run on the target machine and are addressed by hub-minted session ids. */
interface RuntimeExternalAgentsClient {
  discover(
    params: ExternalAgentDiscoverParams,
    options?: RuntimeRequestOptions
  ): Promise<ExternalAgentDiscoverResult>;
  open(
    params: ExternalAgentOpenParams,
    options?: RuntimeRequestOptions
  ): Promise<ExternalAgentOpenResult>;
  turn(
    params: ExternalAgentTurnParams,
    options?: RuntimeRequestOptions
  ): Promise<ExternalAgentTurnResult>;
  respond(
    params: ExternalAgentRespondParams,
    options?: RuntimeRequestOptions
  ): Promise<ExternalAgentAckResult>;
  steer(
    params: ExternalAgentSteerParams,
    options?: RuntimeRequestOptions
  ): Promise<ExternalAgentSteerResult>;
  /** A vendor-native review, delivered on the session's own event stream. */
  startReview(
    params: ExternalAgentStartReviewParams,
    options?: RuntimeRequestOptions
  ): Promise<ExternalAgentStartReviewResult>;
  cancel(
    params: ExternalAgentCancelParams,
    options?: RuntimeRequestOptions
  ): Promise<ExternalAgentAckResult>;
  close(
    params: ExternalAgentCloseParams,
    options?: RuntimeRequestOptions
  ): Promise<ExternalAgentAckResult>;
  refreshAccountUsage(
    params: ExternalAgentRefreshAccountUsageParams,
    options?: RuntimeRequestOptions
  ): Promise<ExternalAgentRefreshAccountUsageResult>;
  /** The vendor's own conversation history on that machine, one page at a time. */
  listSessions(
    params: ExternalAgentListSessionsParams,
    options?: RuntimeRequestOptions
  ): Promise<ExternalAgentListSessionsResult>;
  /** Subscribes only to validated semantic events for one hub-owned session. */
  onEvent(sessionId: string, listener: (event: ExternalAgentEventEnvelope) => void): () => void;
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

interface RuntimeUpdateClient {
  begin(
    params: RuntimeUpdateBeginParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeUpdateBeginResult>;
  chunk(
    params: RuntimeUpdateChunkParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeUpdateChunkResult>;
  commit(
    params: RuntimeUpdateCommitParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeUpdateCommitResult>;
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

interface RuntimeLibraryClient {
  scan(
    params: RuntimeLibraryScanParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeLibraryScanResult>;
  read(
    params: RuntimeLibraryReadParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeLibraryReadResult>;
  readTree(
    params: RuntimeLibraryReadTreeParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeLibraryReadTreeResult>;
  locations(
    params?: RuntimeLibraryLocationsParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeLibraryLocationsResult>;
  settingsSources(
    params?: RuntimeLibrarySettingsSourcesParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeSettingsSourcesResult>;
  apply(
    params: RuntimeLibraryApplyParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeLibraryApplyResult>;
  remove(
    params: RuntimeLibraryRemoveParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeLibraryRemoveResult>;
  undo(
    params: RuntimeLibraryUndoParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeLibraryUndoResult>;
  backups(
    params: RuntimeLibraryBackupsParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeLibraryBackupsResult>;
  gc(
    params: RuntimeLibraryGcParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeLibraryGcResult>;
}

/** Typed API-side facade over the transport-level runtime request multiplexer. */
export class RuntimeClient {
  readonly fs: RuntimeFsClient;
  readonly shell: RuntimeShellClient;
  readonly git: RuntimeGitClient;
  readonly install: RuntimeInstallClient;
  readonly update: RuntimeUpdateClient;
  readonly mcp: RuntimeMcpClient;
  readonly externalAgents: RuntimeExternalAgentsClient;
  readonly probing: RuntimeProbingClient;
  readonly library: RuntimeLibraryClient;
  readonly snapshot: RuntimeSnapshotClient;
  readonly workspace: RuntimeWorkspaceClient;
  private targetPaths?: TargetPaths;
  private unenforcedContainment = false;
  private pathPolicyEnforced = false;

  constructor(
    private readonly protocol: RuntimeProtocolClient,
    private readonly onUnavailable?: () => void,
    /** Named in the warning when this peer turns out not to enforce containment. */
    private readonly environmentId?: string
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
    this.externalAgents = {
      discover: (params, options) => this.request('external-agent.discover', params, options),
      open: (params, options) => this.request('external-agent.open', params, options),
      turn: (params, options) => this.request('external-agent.turn', params, options),
      respond: (params, options) => this.request('external-agent.respond', params, options),
      steer: (params, options) => this.request('external-agent.steer', params, options),
      startReview: (params, options) =>
        this.request('external-agent.start-review', params, options),
      cancel: (params, options) => this.request('external-agent.cancel', params, options),
      close: (params, options) => this.request('external-agent.close', params, options),
      refreshAccountUsage: (params, options) =>
        this.request('external-agent.refresh-account-usage', params, options),
      listSessions: (params, options) =>
        this.request('external-agent.list-sessions', params, options),
      onEvent: (sessionId, listener) =>
        this.protocol.onEvent((frame) => {
          if (frame.topic !== RUNTIME_EXTERNAL_AGENT_TOPIC) return;
          // Every open session adds a listener on this topic, so the cheap
          // session match runs before the envelope validation: a delta stream
          // otherwise pays one full schema check per unrelated subscriber.
          if ((frame.payload as { sessionId?: unknown } | null)?.sessionId !== sessionId) return;
          if (!Value.Check(ExternalAgentEventEnvelopeSchema, frame.payload)) return;
          listener(frame.payload);
        }),
    };
    this.install = {
      run: (params, options) => this.request('install.run', params, options),
      cancel: (params, options) => this.request('install.cancel', params, options),
    };
    this.update = {
      begin: (params, options) => this.request('runtime.update.begin', params, options),
      chunk: (params, options) => this.request('runtime.update.chunk', params, options),
      commit: (params, options) => this.request('runtime.update.commit', params, options),
    };
    this.probing = {
      runtimes: (params, options) => this.request('probing.runtimes', params, options),
      versionManagers: (params, options) =>
        this.request('probing.version-managers', params, options),
      agentClis: (params, options) => this.request('probing.agent-clis', params, options),
    };
    this.library = {
      scan: (params, options) => this.request('library.scan', params, options),
      read: (params, options) => this.request('library.read', params, options),
      readTree: (params, options) => this.request('library.read-tree', params, options),
      locations: (params = {}, options) => this.request('library.locations', params, options),
      settingsSources: (params = {}, options) =>
        this.request('library.settings-sources', params, options),
      // Hub callers should pass an explicit timeoutMs (60_000 matches library reads).
      apply: (params, options) => this.request('library.apply', params, options),
      remove: (params, options) => this.request('library.remove', params, options),
      undo: (params, options) => this.request('library.undo', params, options),
      backups: (params, options) => this.request('library.backups', params, options),
      gc: (params, options) => this.request('library.gc', params, options),
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
   * Whether this peer says it re-checks the paths this hub names against the
   * policy the call carried. False for any runtime that predates the
   * declaration — the hub cannot read enforcement into silence.
   */
  get enforcesPathPolicy(): boolean {
    return this.protocol.manifest.enforcesPathPolicy === true;
  }

  /** One health truth: same payload as `mangostudio-runtime health --json`. */
  health(options?: RuntimeRequestOptions) {
    return this.request('runtime.health', {}, options);
  }

  /**
   * Replaces the handshake manifest after a consent change (see
   * {@link RuntimeProtocolClient.replaceManifest}).
   */
  replaceManifest(manifest: RuntimeCapabilityManifest): void {
    this.protocol.replaceManifest(manifest);
    this.targetPaths = undefined;
    this.pathPolicyEnforced = false;
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
    this.noteUnenforcedContainment(method, params);
    try {
      return await this.protocol.request(method, params, options);
    } catch (error) {
      if (error instanceof RuntimeRemoteError && error.code === 'RUNTIME_UNAVAILABLE') {
        this.onUnavailable?.();
      }
      throw translateRuntimeError(error);
    }
  }

  /**
   * Records that this hub sent a containment root to a peer that never said it
   * would honour one.
   *
   * `pathPolicy` is optional on the wire so a hub can keep talking to a runtime
   * built before the field existed, and that tolerance has no failure mode of
   * its own — the older peer accepts the field, ignores it, and answers exactly
   * like a peer that enforced it. What the hub loses is the enforcement, and
   * silently. So the send site is where the gap is observable, and this is it:
   * every path a restricted chat can take to the filesystem goes through
   * {@link request}.
   *
   * Once per connection, because the alternative is a line per tool call for a
   * condition that only an upgrade can change. An enforcing peer's manifest is
   * cached the same way, so a connection that enforces never re-derives that
   * fact past the first call.
   */
  private noteUnenforcedContainment(method: RuntimeMethod, params: unknown): void {
    if (this.unenforcedContainment || this.pathPolicyEnforced) return;
    // Every transport awaits the handshake before handing this client out, so
    // the manifest is there — but reading it is what this method is for, and a
    // diagnostic that can throw would fail the call it exists to describe. An
    // unread manifest is also not an answer: silence is not a peer saying no.
    const peer = this.peerIdentity();
    if (!peer) return;
    if (peer.manifest.enforcesPathPolicy === true) {
      this.pathPolicyEnforced = true;
      return;
    }
    if (!containmentRootOf(params)) return;

    this.unenforcedContainment = true;
    logger.warn('containment_unenforced', {
      environmentId: this.environmentId ?? 'unknown',
      runtimeVersion: peer.runtimeVersion,
      method,
    });
  }

  /** Both handshake facts, or nothing when the handshake has not settled. */
  private peerIdentity():
    | { manifest: RuntimeCapabilityManifest; runtimeVersion: string }
    | undefined {
    try {
      return { manifest: this.protocol.manifest, runtimeVersion: this.protocol.runtimeVersion };
    } catch {
      return undefined;
    }
  }
}

/**
 * The containment root a call carries, from either shape that can hold one:
 * the `pathPolicy` every filesystem method mixes in, and `snapshot.revert`'s
 * own top-level field. Absent means the call was never restricted, which is
 * not a gap to report.
 */
function containmentRootOf(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const direct = (params as { containmentRoot?: unknown }).containmentRoot;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const policy = (params as RuntimePathPolicyParams).pathPolicy;
  return policy?.containmentRoot;
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
  if (error.code === 'RUNTIME_DENIED') {
    const missing = error.details?.missing;
    return new RuntimeConsentDeniedError(error.message, {
      capability: detailString(error, 'capability'),
      method: detailString(error, 'method'),
      slot: detailString(error, 'slot'),
      ...(Array.isArray(missing)
        ? { missing: missing.filter((entry): entry is string => typeof entry === 'string') }
        : {}),
    });
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
    case 'consent_denied':
      // Older peers that still emit INTERNAL + details.kind=consent_denied.
      return new RuntimeConsentDeniedError(error.message, {
        capability: detailString(error, 'capability'),
        method: detailString(error, 'method'),
        slot: detailString(error, 'slot'),
      });
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
