import type { LibraryLocationSettings } from '@mangostudio/shared/app-settings';
import type {
  AgentCliStatus,
  RuntimeId,
  RuntimeStatus,
  VersionManagerId,
  VersionManagerStatus,
} from '@mangostudio/shared/environments';
import type {
  ConsumerVersionRequirement,
  MinimumRuntimeVersion,
} from '@mangostudio/shared/environments/detection';
import type {
  ExternalAgentAckResult,
  ExternalAgentCancelParams,
  ExternalAgentCloseParams,
  ExternalAgentDiscoverParams,
  ExternalAgentDiscoverResult,
  ExternalAgentEventEnvelope,
  ExternalAgentListSessionsParams,
  ExternalAgentListSessionsResult,
  ExternalAgentOpenParams,
  ExternalAgentOpenResult,
  ExternalAgentRefreshAccountUsageParams,
  ExternalAgentRefreshAccountUsageResult,
  ExternalAgentRespondParams,
  ExternalAgentStartReviewParams,
  ExternalAgentStartReviewResult,
  ExternalAgentSteerParams,
  ExternalAgentSteerResult,
  ExternalAgentTurnParams,
  ExternalAgentTurnResult,
} from '@mangostudio/shared/external-agents';
import type {
  LibraryBackupSet,
  LibraryInstance,
  LibraryLocationId,
  LibraryLocationStatus,
  LibraryResourceRef,
  LibraryTargetId,
  LibraryUndoResult,
  LibraryUnreadableEntry,
  PropagationApply,
  RemovalApply,
  ResourceKind,
} from '@mangostudio/shared/library';
import type {
  McpElicitationAction,
  McpElicitationField,
  McpPromptDescriptor,
  McpResourceDescriptor,
  McpToolDescriptor,
  McpTransport,
} from '@mangostudio/shared/mcp';
import type { RuntimeHealthReport } from '@mangostudio/shared/runtime-home';
import type {
  RuntimePathFilter,
  RuntimePathPolicyParams,
  RuntimeShellKind,
} from '@mangostudio/shared/runtime-protocol';
import type {
  ListDirectoryResponse,
  WorkdirValidationReason,
} from '@mangostudio/shared/workspaces';
import type { RuntimeSettingsSourcesResult } from './services/library/settings-sources';
import type {
  PreparedPropagationAdaptation,
  PreparedPropagationOperation,
  PreparedRemovalOperation,
} from './services/library/write-shapes';

export const RUNTIME_ABSENT_HASH = 'absent';

export type {
  ExternalAgentAckResult,
  ExternalAgentCancelParams,
  ExternalAgentCloseParams,
  ExternalAgentDiscoverParams,
  ExternalAgentDiscoverResult,
  ExternalAgentEventEnvelope,
  ExternalAgentListSessionsParams,
  ExternalAgentListSessionsResult,
  ExternalAgentOpenParams,
  ExternalAgentOpenResult,
  ExternalAgentRefreshAccountUsageParams,
  ExternalAgentRefreshAccountUsageResult,
  ExternalAgentRespondParams,
  ExternalAgentStartReviewParams,
  ExternalAgentStartReviewResult,
  ExternalAgentSteerParams,
  ExternalAgentSteerResult,
  ExternalAgentTurnParams,
  ExternalAgentTurnResult,
} from '@mangostudio/shared/external-agents';

/** Topic carrying ordered, semantic vendor-agent events to the hub. */
export const RUNTIME_EXTERNAL_AGENT_TOPIC = 'external-agent.event' as const;
export type RuntimeExternalAgentEvent = ExternalAgentEventEnvelope;

export interface RuntimeBeforeSnapshot {
  readonly exists: boolean;
  readonly contentBase64?: string;
  readonly hash?: string;
}

export interface RuntimeMutationSnapshot {
  readonly path: string;
  readonly op: 'create' | 'delete' | 'edit' | 'move';
  readonly movedTo?: string;
  readonly before: RuntimeBeforeSnapshot;
  readonly afterHash: string;
}

export interface RuntimeMutationResult<T> {
  readonly result: T;
  readonly mutations: readonly RuntimeMutationSnapshot[];
}

/**
 * Path policy the hub decided for a call, carried by every filesystem method.
 * Schema-first in `@mangostudio/shared/runtime-protocol`, because it is a wire
 * shape rather than a runtime-local one; re-exported here so the filesystem
 * methods below read as one contract.
 */
export type { RuntimePathFilter, RuntimePathPolicyParams };

/**
 * How a file's bytes are rendered into the string the model receives. `text`
 * decodes as UTF-8 and refuses anything holding a NUL byte; `hex` and `base64`
 * transcode the bytes verbatim, which is the only way a binary file can enter
 * the freshness ledger and so the only way it can be overwritten through the
 * read-before-write guard. Absent means `text`.
 *
 * The tuple is the source of truth and the union is derived from it: the hub
 * needs the values at runtime for its argument check and its JSON-schema `enum`,
 * and a union written separately would let a view added here compile cleanly
 * while the hub silently refused it.
 */
export const RUNTIME_READ_FILE_VIEWS = ['text', 'hex', 'base64'] as const;
export type RuntimeReadFileView = (typeof RUNTIME_READ_FILE_VIEWS)[number];

export interface RuntimeReadFileParams extends RuntimePathPolicyParams {
  readonly chatId: string;
  readonly inputPath: string;
  readonly resolvedPath: string;
  readonly startLine?: number;
  readonly maxLines?: number;
  /** Absent means `text`; the line window applies to `text` only. */
  readonly view?: RuntimeReadFileView;
}

export interface RuntimeReadFileResult {
  readonly content: string;
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly totalLines: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly truncated: boolean;
  /**
   * Echoed only for a byte view, so a `text` result keeps the shape it has
   * always had and the model can tell a hex dump from file content.
   */
  readonly view?: Exclude<RuntimeReadFileView, 'text'>;
}

interface RuntimeMutationParams extends RuntimePathPolicyParams {
  readonly chatId: string;
  readonly captureSnapshot: boolean;
}

export interface RuntimeWriteFileParams extends RuntimeMutationParams {
  readonly inputPath: string;
  readonly resolvedPath: string;
  readonly content: string;
}

export interface RuntimeWriteFileResult {
  readonly path: string;
  readonly bytesWritten: number;
  readonly created: boolean;
  readonly sha256: string;
}

export interface RuntimeCreateFileParams extends RuntimeMutationParams {
  readonly inputPath: string;
  readonly resolvedPath: string;
  readonly content: string;
}

export interface RuntimeCreateFileResult {
  readonly path: string;
  readonly bytesWritten: number;
  readonly sha256: string;
}

export interface RuntimeEditFileParams extends RuntimeMutationParams {
  readonly inputPath: string;
  readonly resolvedPath: string;
  readonly oldString: string;
  readonly newString: string;
  readonly replaceAll?: boolean;
}

export interface RuntimeEditFileResult {
  readonly path: string;
  readonly replacements: number;
  readonly sha256: string;
  readonly firstChangedLine: number;
}

export interface RuntimeReplaceRangeParams extends RuntimeMutationParams {
  readonly inputPath: string;
  readonly resolvedPath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
}

export interface RuntimeReplaceRangeResult {
  readonly path: string;
  readonly replacedLines: number;
  readonly newTotalLines: number;
  readonly sha256: string;
}

export interface RuntimeDeleteFileParams extends RuntimeMutationParams {
  readonly inputPath: string;
  readonly resolvedPath: string;
}

export interface RuntimeDeleteFileResult {
  readonly path: string;
  readonly deleted: true;
}

export interface RuntimeMoveFileParams extends RuntimeMutationParams {
  readonly inputFrom: string;
  readonly inputTo: string;
  readonly resolvedFrom: string;
  readonly resolvedTo: string;
}

export interface RuntimeMoveFileResult {
  readonly from: string;
  readonly to: string;
  readonly moved: true;
}

export interface RuntimeListDirectoryParams extends RuntimePathPolicyParams {
  readonly inputPath: string;
  readonly resolvedPath: string;
}

export interface RuntimeListDirectoryResult {
  readonly path: string;
  readonly entries: ReadonlyArray<{
    readonly name: string;
    readonly type: 'file' | 'directory';
  }>;
}

export interface RuntimeGlobParams extends RuntimePathPolicyParams {
  readonly pattern: string;
  readonly cwd: string;
  readonly maxResults: number;
  readonly includeDotfiles: boolean;
  readonly absolute: boolean;
}

export interface RuntimeGlobResult {
  readonly pattern: string;
  readonly cwd: string;
  readonly matches: readonly string[];
  readonly truncated: boolean;
}

export interface RuntimeGrepParams extends RuntimePathPolicyParams {
  readonly pattern: string;
  readonly inputPath: string;
  readonly resolvedPath: string;
  readonly glob?: string;
  readonly caseInsensitive: boolean;
  readonly maxResults: number;
  readonly maxMatchesPerFile: number;
  readonly maxFileSizeBytes: number;
  readonly includeDotfiles: boolean;
}

export interface RuntimeGrepResult {
  readonly pattern: string;
  readonly path: string;
  readonly matches: ReadonlyArray<{
    readonly file: string;
    readonly line: number;
    readonly text: string;
  }>;
  readonly filesScanned: number;
  readonly truncated: boolean;
}

export interface RuntimePatchHunkLine {
  readonly type: 'context' | 'add' | 'delete';
  readonly content: string;
  readonly ending: '' | '\n' | '\r\n';
}

export interface RuntimePatchHunk {
  readonly marker?: string;
  readonly lines: readonly RuntimePatchHunkLine[];
}

export type RuntimePatchOperation =
  | {
      readonly type: 'add';
      readonly inputPath: string;
      readonly resolvedPath: string;
      readonly content: string;
    }
  | {
      readonly type: 'delete';
      readonly inputPath: string;
      readonly resolvedPath: string;
    }
  | {
      readonly type: 'update';
      readonly inputPath: string;
      readonly resolvedPath: string;
      readonly moveTo?: string;
      readonly resolvedMoveTo?: string;
      readonly hunks: readonly RuntimePatchHunk[];
    };

export interface RuntimeApplyPatchParams extends RuntimeMutationParams {
  readonly operations: readonly RuntimePatchOperation[];
}

export interface RuntimeApplyPatchResult {
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly op: 'add' | 'update' | 'delete' | 'move';
    readonly movedTo?: string;
    readonly sha256?: string;
  }>;
  readonly summary: string;
}

export interface RuntimeShellRunParams {
  readonly kind: RuntimeShellKind;
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly envPolicy?: {
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
  };
}

export interface RuntimeShellResult {
  readonly shell: RuntimeShellKind;
  readonly command: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly termination:
    | { readonly kind: 'exited' }
    | { readonly kind: 'timed_out' }
    | { readonly kind: 'aborted' }
    | { readonly kind: 'signalled'; readonly signal: string };
  readonly durationMs: number;
}

export interface RuntimeGitExecParams {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly acceptedExitCodes?: readonly number[];
}

export interface RuntimeGitExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  /**
   * Git exited, but a surviving helper (credential helper, backgrounded child)
   * still held a pipe open when the capture stopped, so `stdout`/`stderr` may
   * be short of what Git actually wrote. Omitted — not `false` — when the
   * capture drained normally, so an older peer that has never heard of this
   * field is read the same way as a complete capture.
   */
  readonly incomplete?: boolean;
}

/**
 * Params for both `gh.exec` and `gh.mutate`.
 *
 * One shape, two methods. The split is not about what a call looks like — it is
 * about what consent it needs, and the gate decides that from the method name
 * alone (see `consent-gate.ts`), so the read/write line has to be drawn between
 * two methods rather than between two values of one parameter.
 */
export interface RuntimeGhExecParams {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly acceptedExitCodes?: readonly number[];
}

export interface RuntimeGhExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  /**
   * `gh` exited, but a surviving child (it runs git, and git runs credential
   * helpers) still held a pipe open when the capture stopped, so the captured
   * text may be short of what `gh` actually wrote. Omitted rather than `false`
   * on a clean drain, so an older peer that never learned the field reads the
   * same as a complete capture.
   */
  readonly incomplete?: boolean;
}

export interface RuntimeSnapshotCaptureParams {
  readonly path: string;
}

export interface RuntimeSnapshotHashParams {
  readonly path: string;
}

export interface RuntimeSnapshotHashResult {
  readonly hash: string | null;
}

export interface RuntimeSnapshotRevertParams {
  readonly chatId: string;
  /** When set, every revert path must stay inside this root after symlink resolution. */
  readonly containmentRoot?: string;
  readonly expected: readonly {
    readonly path: string;
    readonly afterHash: string;
    /**
     * Hash this path holds once the revert has completed, when the caller can
     * derive it. Supplying it lets a retry after a revert whose bookkeeping
     * failed recognise its own finished work instead of reporting a conflict.
     */
    readonly revertedHash?: string;
  }[];
  readonly operations: readonly (
    | { readonly type: 'create'; readonly path: string }
    | {
        readonly type: 'restore';
        readonly path: string;
        readonly contentBase64: string;
      }
    | {
        readonly type: 'move';
        readonly path: string;
        readonly movedTo: string;
        readonly contentBase64: string;
      }
  )[];
}

export interface RuntimeWorkspaceBrowseParams {
  readonly path?: string;
}

export type RuntimeWorkspaceBrowseResult = ListDirectoryResponse;

export type RuntimeWorkspaceValidateResult =
  | { readonly ok: true; readonly resolvedPath: string }
  | { readonly ok: false; readonly reason: WorkdirValidationReason };

export interface RuntimeWorkspaceValidateParams {
  readonly path: string;
  readonly requireAbsolute?: boolean;
}

export interface RuntimeWorkspaceResolveContainedParams {
  readonly root: string;
  /** Root-relative path, in either separator style; the runtime applies its own. */
  readonly path: string;
}

export interface RuntimeWorkspaceResolveContainedResult {
  /** Root-relative canonical path, or null when nothing exists at that location. */
  readonly relativePath: string | null;
}

export interface RuntimeSnapshotRevertResult {
  readonly revertedFiles: number;
}

/**
 * Connection config for one MCP server, derived hub-side from its row. Secrets
 * travel separately in {@link RuntimeMcpSecrets} so nothing here is sensitive —
 * this half is what may be logged, echoed, or persisted for diagnostics.
 */
export interface RuntimeMcpServerConfig {
  readonly id: string;
  readonly slug: string;
  readonly transport: McpTransport;
  readonly command: string | null;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly url: string | null;
  readonly timeoutMs: number | null;
}

/**
 * Credentials the hub's secret store holds for a server, delivered on connect
 * and kept in memory by the session for as long as it lives. The runtime never
 * writes them anywhere: not to disk, not to a log line, not to an audit record.
 */
export interface RuntimeMcpSecrets {
  /** stdio: secret child environment variables, merged over the row's `env`. */
  readonly env?: Readonly<Record<string, string>>;
  /** http: auth headers sent with every request on the session. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** Feature areas a server advertised during the MCP initialize handshake. */
export interface RuntimeMcpServerCapabilities {
  readonly tools: boolean;
  readonly resources: boolean;
  readonly prompts: boolean;
}

/**
 * Structural, SDK-free view of one tool-result content block. `image`/`audio`
 * data and `resource` blobs stay base64-encoded exactly as the server returned
 * them; consumers decide what to persist or inline.
 */
export type RuntimeMcpContentBlock =
  | { readonly type: 'text'; readonly text: string; readonly truncated?: true }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string }
  | { readonly type: 'audio'; readonly data: string; readonly mimeType: string }
  | {
      readonly type: 'resource';
      readonly uri: string;
      readonly mimeType?: string;
      readonly text?: string;
      /** Set when {@link text} was shortened to fit the runtime frame cap. */
      readonly textTruncated?: true;
      readonly blob?: string;
    }
  | { readonly type: 'unknown'; readonly blockType: string; readonly mimeType?: string };

/** Tool call outcome: flattened text for the model plus the structured blocks. */
export interface RuntimeMcpCallResult {
  /** Text and text-resource blocks joined with blank lines, capped. */
  readonly contentText: string;
  readonly isError: boolean;
  /** Content block types the server returned (`text`, `image`, `resource`, …). */
  readonly rawContentKinds: readonly string[];
  readonly content: readonly RuntimeMcpContentBlock[];
}

/** One `resources/read` content entry; binary payloads stay base64 in `blob`. */
export interface RuntimeMcpResourceContents {
  readonly uri: string;
  readonly mimeType?: string;
  readonly text?: string;
  readonly blob?: string;
}

/** A resolved prompt, with each message's content flattened to plain text. */
export interface RuntimeMcpPromptResult {
  readonly description?: string;
  readonly messages: ReadonlyArray<{
    readonly role: 'user' | 'assistant';
    readonly text: string;
  }>;
}

export interface RuntimeMcpConnectParams {
  readonly config: RuntimeMcpServerConfig;
  readonly secrets?: RuntimeMcpSecrets;
}

export interface RuntimeMcpConnectResult {
  readonly capabilities: RuntimeMcpServerCapabilities;
}

export interface RuntimeMcpServerParams {
  readonly serverId: string;
}

export interface RuntimeMcpListToolsResult {
  readonly tools: readonly McpToolDescriptor[];
}

export interface RuntimeMcpCallToolParams extends RuntimeMcpServerParams {
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
  /**
   * Hub-minted correlation id for the call. Elicitation events echo it back so
   * the hub can route a server's mid-call question to the tool call that
   * caused it — the key is part of this method's contract, not a detail.
   */
  readonly toolCallId?: string;
  readonly timeoutMs?: number;
}

export interface RuntimeMcpListResourcesResult {
  readonly resources: readonly McpResourceDescriptor[];
}

export interface RuntimeMcpReadResourceParams extends RuntimeMcpServerParams {
  readonly uri: string;
}

export interface RuntimeMcpReadResourceResult {
  readonly contents: readonly RuntimeMcpResourceContents[];
}

export interface RuntimeMcpListPromptsResult {
  readonly prompts: readonly McpPromptDescriptor[];
}

export interface RuntimeMcpGetPromptParams extends RuntimeMcpServerParams {
  readonly promptName: string;
  readonly args?: Readonly<Record<string, string>>;
}

/** The hub's answer to one `mcp.elicitation` event, keyed by its request id. */
export interface RuntimeMcpElicitResponseParams {
  readonly requestId: string;
  readonly action: McpElicitationAction;
  readonly content?: Readonly<Record<string, string | number | boolean | string[]>>;
}

export interface RuntimeMcpAckResult {
  readonly ok: true;
}

/** Topic carrying a server's mid-tool-call form request up to the hub. */
export const RUNTIME_MCP_ELICITATION_TOPIC = 'mcp.elicitation' as const;

/** Topic carrying out-of-band session state (drops, tool-list invalidations). */
export const RUNTIME_MCP_SESSION_TOPIC = 'mcp.session' as const;

export interface RuntimeMcpElicitationEvent {
  readonly requestId: string;
  readonly serverId: string;
  readonly serverSlug: string;
  readonly toolCallId: string;
  readonly message: string;
  readonly fields: readonly McpElicitationField[];
}

export interface RuntimeMcpSessionEvent {
  readonly serverId: string;
  /** `closed`: the session dropped. `tool-list-changed`: caches are stale. */
  readonly change: 'closed' | 'tool-list-changed';
}

/**
 * Bounds a probe's spawns on the machine that runs them. The budget belongs
 * with the spawns rather than on the hub, where a timer would only be racing
 * the transport; the hub's own `timeoutMs` sits above these values so a dead
 * link and an over-running probe are still distinguishable.
 */
export interface RuntimeProbeBudget {
  readonly probeTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
  readonly maxConcurrency?: number;
}

interface RuntimeProbeParams {
  readonly budget?: RuntimeProbeBudget;
  /**
   * Variables merged over this host's own environment. The hub pins the
   * MangoStudio library directories here for its own machine — they are
   * product configuration, not a property of a host — and pins nothing for
   * anyone else's, where its paths would name nothing.
   */
  readonly pathEnv?: { readonly env?: Readonly<Record<string, string>> };
}

export interface RuntimeProbeRuntimesParams extends RuntimeProbeParams {
  readonly ids?: readonly RuntimeId[];
  /** Hub policy: which ids this release can offer an install recipe for. */
  readonly installable?: Readonly<Partial<Record<RuntimeId, boolean>>>;
  readonly minimumVersions?: Readonly<Partial<Record<RuntimeId, MinimumRuntimeVersion>>>;
  /** Per-consumer floors — a feature that needs a newer runtime than the generic minimum. */
  readonly consumerMinimumVersions?: Readonly<
    Partial<Record<RuntimeId, readonly ConsumerVersionRequirement[]>>
  >;
}

export interface RuntimeProbeRuntimesResult {
  readonly statuses: readonly RuntimeStatus[];
}

export interface RuntimeProbeVersionManagersParams extends RuntimeProbeParams {
  readonly ids?: readonly VersionManagerId[];
  /**
   * Latest published patch per major, keyed by major as a string because a
   * JSON object cannot key on a number. The hub fetches it: reaching the
   * network is its policy, and a runtime on a locked-down host may have none.
   */
  readonly latestByMajor?: Readonly<Record<string, string>>;
}

export interface RuntimeProbeVersionManagersResult {
  readonly statuses: readonly VersionManagerStatus[];
}

export interface RuntimeProbeAgentClisParams extends RuntimeProbeParams {
  readonly targetIds?: readonly LibraryTargetId[];
  readonly installable?: Readonly<Partial<Record<LibraryTargetId, boolean>>>;
  /**
   * What the hub is, for the `mangostudio` target. `executablePath` is sent
   * only when this host *is* the hub's machine; elsewhere the runtime answers
   * with its own. Config home reaches the runtime through `pathEnv` like every
   * other configured MangoStudio path.
   */
  readonly self: {
    readonly version: string;
    readonly executablePath?: string;
  };
}

export interface RuntimeProbeAgentClisResult {
  readonly statuses: readonly AgentCliStatus[];
}

/** Topic carrying one install run's output up to the hub, keyed by run id. */
export const RUNTIME_INSTALL_OUTPUT_TOPIC = 'install.output' as const;

export interface RuntimeInstallOutputEvent {
  readonly stream: 'stdout' | 'stderr' | 'system';
  readonly line: string;
  /** Marks the frame that closes the stream; its `line` is empty. */
  readonly end?: true;
}

export interface RuntimeInstallRunParams {
  /** Hub-minted run id. It is the stream key, so it is part of the contract. */
  readonly runId: string;
  /** Already built by the hub from a code-defined recipe; never interpolated here. */
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** Where this machine keeps the run's log; the hub's own path means nothing here. */
  readonly logPath: string;
  readonly outputLimitBytes?: number;
}

export interface RuntimeInstallRunResult {
  readonly exitCode: number | null;
  readonly status: 'succeeded' | 'failed' | 'cancelled' | 'timed-out' | 'spawn-failed';
  readonly truncated: boolean;
  readonly finishedAt: number;
  readonly durationMs: number;
}

export interface RuntimeInstallCancelParams {
  readonly runId: string;
}

/**
 * Topic carrying one terminal session's output up to the hub, keyed by
 * session id. Never emitted before the hub has called `terminal.attach` on
 * that session, so an older hub that cannot decode the payload never sees it.
 */
export const RUNTIME_TERMINAL_OUTPUT_TOPIC = 'terminal.output' as const;

/**
 * One frame on `terminal.output`. `data` is base64 because the event envelope
 * is JSON; at most `TERMINAL_CHUNK_MAX_BYTES` raw bytes per frame. `dropped`
 * is a marker for bytes discarded when the in-flight window and the pending
 * buffer were both full. `exit` rides the frame that ends the stream.
 */
export type RuntimeTerminalOutputEvent =
  | { readonly kind: 'data'; readonly data: string }
  | { readonly kind: 'dropped'; readonly bytes: number }
  | { readonly kind: 'exit'; readonly exitCode: number | null; readonly signal: string | null };

export type RuntimeTerminalSessionStatus = 'running' | 'exited';

export interface RuntimeTerminalOpenParams {
  /** Hub-minted session id. It is the stream key, so it is part of the contract. */
  readonly sessionId: string;
  /** Omitted: the login shell when it is one this runtime offers, else the first available. */
  readonly shell?: RuntimeShellKind;
  /** Omitted: the runtime user's home. `~` expands like `shell.run`. */
  readonly cwd?: string;
  readonly cols: number;
  readonly rows: number;
  /** Variables layered over the sanitized host env. Never secrets; the hub does not hold any to send. */
  readonly env?: Readonly<Record<string, string>>;
  readonly envPolicy?: RuntimeShellRunParams['envPolicy'];
  /** Omitted: `TERMINAL_SCROLLBACK_MAX_BYTES`, which is also the hard ceiling this is clamped to. */
  readonly scrollbackBytes?: number;
}

export interface RuntimeTerminalOpenResult {
  readonly sessionId: string;
  readonly shell: RuntimeShellKind;
  readonly cwd: string;
  readonly pid: number;
}

export interface RuntimeTerminalAttachParams {
  readonly sessionId: string;
}

/**
 * Attaching replays what the session kept and starts the live stream. The
 * in-flight window is re-based by the attach: whatever was unacknowledged for a
 * previous viewer is owed nothing by this one, and the replay below is charged
 * to the window instead, because the viewer acks replayed bytes exactly as it
 * acks live ones.
 */
export interface RuntimeTerminalAttachResult {
  readonly sessionId: string;
  /** Base64 of the last `scrollbackBytes` (default, and hard ceiling: `TERMINAL_SCROLLBACK_MAX_BYTES`) bytes of output. */
  readonly scrollback: string;
  readonly status: RuntimeTerminalSessionStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly cols: number;
  readonly rows: number;
}

export interface RuntimeTerminalDetachParams {
  readonly sessionId: string;
}

export interface RuntimeTerminalWriteParams {
  readonly sessionId: string;
  /** Base64 of the keystrokes; at most `TERMINAL_CLIENT_MESSAGE_MAX_BYTES` raw. */
  readonly data: string;
}

export interface RuntimeTerminalResizeParams {
  readonly sessionId: string;
  readonly cols: number;
  readonly rows: number;
}

export interface RuntimeTerminalAckParams {
  readonly sessionId: string;
  /** Raw output bytes the viewer has consumed since its last ack. */
  readonly bytes: number;
}

export interface RuntimeTerminalCloseParams {
  readonly sessionId: string;
}

export interface RuntimeTerminalSessionSummary {
  readonly sessionId: string;
  readonly shell: RuntimeShellKind;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly status: RuntimeTerminalSessionStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly attached: boolean;
  readonly pid: number;
}

export interface RuntimeTerminalListResult {
  readonly sessions: readonly RuntimeTerminalSessionSummary[];
}

/**
 * Variables merged over this host's own environment for library path
 * resolution. The hub pins configured MangoStudio directories here for its own
 * machine and pins nothing for anyone else's.
 */
export interface RuntimeLibraryPathEnvParams {
  readonly env?: Readonly<Record<string, string>>;
  readonly workspaceRoot?: string;
}

export interface RuntimeLibraryScanParams {
  /**
   * Enabled/disabled map per scope. The hub resolves the user's settings; this
   * host only needs the boolean map to know which locations to open.
   */
  readonly locationSettings: LibraryLocationSettings;
  readonly force?: boolean;
  readonly kinds?: readonly ResourceKind[];
  readonly locationPathOverrides?: Readonly<Partial<Record<LibraryLocationId, string>>>;
  readonly pathEnv?: RuntimeLibraryPathEnvParams;
}

export interface RuntimeLibraryScanEntry {
  readonly ref: LibraryResourceRef;
  readonly instance: LibraryInstance;
  readonly whitespaceHash?: string;
}

export interface RuntimeLibraryScanResult {
  readonly entries: readonly RuntimeLibraryScanEntry[];
  readonly unreadableEntries: readonly LibraryUnreadableEntry[];
}

export interface RuntimeLibraryReadParams {
  readonly path: string;
  /**
   * Location the scan found this instance in. The root that contains the read
   * is resolved here, from this host's own `PathEnv` — the hub names *which*
   * location, never where it is. A hub-supplied root would be a guess about
   * someone else's filesystem, and a root derived from the instance path
   * contains that path by construction, which is no containment at all.
   */
  readonly locationId: LibraryLocationId;
  readonly pathEnv?: RuntimeLibraryPathEnvParams;
  readonly maxBytes?: number;
  readonly truncateOversize?: boolean;
}

export interface RuntimeLibraryReadResult {
  readonly content: string;
  readonly truncated: boolean;
  readonly sizeBytes: number;
  /** Set when the path is outside the location root or otherwise refused. */
  readonly denied?: true;
  readonly reason?: string;
}

/**
 * Reads a whole directory resource so it can be written on another machine.
 *
 * `library.read` answers with one file's text for the detail view; a skill is a
 * tree, and the destination's `library.apply` cannot reach a source directory
 * that lives on a different host. The bytes travel base64 in the frame, bounded
 * by the same caps a scan enforces.
 */
export interface RuntimeLibraryReadTreeParams {
  /** Absolute directory path on this host, as the scan reported it. */
  readonly path: string;
  readonly locationId: LibraryLocationId;
  readonly pathEnv?: RuntimeLibraryPathEnvParams;
}

export interface RuntimeLibraryTreeFile {
  /** Posix-separated path relative to the resource root. */
  readonly relativePath: string;
  readonly contentBase64: string;
}

export interface RuntimeLibraryReadTreeResult {
  readonly files: readonly RuntimeLibraryTreeFile[];
  /** Set when the path is outside the location root or otherwise refused. */
  readonly denied?: true;
  readonly reason?: string;
}

export interface RuntimeLibraryLocationsParams {
  readonly pathEnv?: RuntimeLibraryPathEnvParams;
}

export interface RuntimeLibraryLocationsResult {
  readonly locations: readonly LibraryLocationStatus[];
}

export interface RuntimeLibrarySettingsSourcesParams {
  readonly pathEnv?: RuntimeLibraryPathEnvParams;
}

export interface RuntimeLibraryBackupEnvelope {
  /** Absolute backup root on this host. Hub-supplied; never invented here. */
  readonly backupRoot: string;
  readonly retentionCount?: number;
  readonly retentionBytes?: number;
  readonly pathEnv?: RuntimeLibraryPathEnvParams;
  readonly backupId?: string;
  /**
   * Which environment the hub is writing to, echoed back on every result row
   * and stamped into the backup manifest.
   *
   * The id is a hub concept — this host has no way to know what it was filed
   * under — so it travels with the request rather than being resolved here.
   * Absent means Local, which is what every backup written before environments
   * existed was.
   */
  readonly environmentId?: string;
}

/**
 * The write operations are the engines' own shapes, encoded.
 *
 * Declaring them twice — once here for the wire, once in the engine — meant
 * every crossing needed a cast, and a field added to one half compiled cleanly
 * while being dropped in transit. The engine module owns the shape because it
 * is the thing that acts on it; the only wire-specific difference is that bytes
 * travel as a key into `contents` rather than as a buffer.
 */
export type RuntimeLibraryApplyAdaptation = PreparedPropagationAdaptation;

export type RuntimeLibraryApplyOperation = Omit<
  PreparedPropagationOperation,
  'contents' | 'files'
> & {
  /** Key into `RuntimeLibraryApplyParams.contents`. Absent for directories. */
  readonly contentRef?: string;
  /**
   * A transferred directory tree, each file naming its payload in `contents`.
   *
   * Present only when the source lives on another machine — a same-machine
   * directory apply keeps naming `sourceDir`, so nothing about that path
   * changed. Sharing the `contents` map means a skill fanned out to several
   * destinations carries its files once, exactly as file resources do.
   */
  readonly files?: readonly { readonly relativePath: string; readonly contentRef: string }[];
};

export interface RuntimeLibraryApplyParams extends RuntimeLibraryBackupEnvelope {
  readonly operations: readonly RuntimeLibraryApplyOperation[];
  /**
   * Base64 payloads keyed by content hash, referenced by `contentRef`.
   *
   * Shared rather than inlined per operation because propagation fans one
   * resource out across destinations: N destinations of the same bytes used to
   * put N base64 copies in a single frame, and two 2 MiB resources across five
   * locations already exceeded `RUNTIME_MAX_FRAME_BYTES`.
   */
  readonly contents?: Readonly<Record<string, string>>;
}

export type RuntimeLibraryApplyResult = PropagationApply;

export type RuntimeLibraryRemoveOperation = PreparedRemovalOperation;

export interface RuntimeLibraryRemoveParams extends RuntimeLibraryBackupEnvelope {
  readonly operations: readonly RuntimeLibraryRemoveOperation[];
  readonly lastCopyResourceKeys?: readonly string[];
}

export type RuntimeLibraryRemoveResult = RemovalApply;

/**
 * Reads this host's backup store. No bounds are enforced — the retention values
 * only decide which sets `evictsNext` marks, so a listing never costs the user a
 * backup it did not warn about first.
 */
export interface RuntimeLibraryBackupsParams {
  readonly backupRoot: string;
  readonly retentionCount?: number;
  readonly retentionBytes?: number;
}

export interface RuntimeLibraryBackupsResult {
  readonly sets: readonly LibraryBackupSet[];
}

/**
 * Deletes named sets and trims the store to its bounds, on the machine holding
 * the bytes.
 *
 * Separate from `library.backups` because it is a write: the consent gate has
 * to be able to refuse it on a readonly machine while still letting that
 * machine's history be listed.
 */
export interface RuntimeLibraryGcParams {
  readonly backupRoot: string;
  readonly retentionCount?: number;
  readonly retentionBytes?: number;
  /** Sets the user asked to delete by name. Purging a missing set is not an error. */
  readonly purgeBackupIds?: readonly string[];
}

export interface RuntimeLibraryGcResult {
  readonly purged: readonly string[];
  /** Sets retention took, so the hub can drop their index rows in the same pass. */
  readonly pruned: readonly string[];
}

export interface RuntimeLibraryUndoParams {
  readonly backupRoot: string;
  readonly backupId: string;
  /**
   * Resolves the registry roots the manifest's paths have to sit inside. No
   * retention bounds travel: undo restores and removes, it never prunes.
   */
  readonly pathEnv?: RuntimeLibraryPathEnvParams;
}

export type RuntimeLibraryUndoResult = LibraryUndoResult;

/** Opens one bounded runtime-binary transfer. Bytes travel in sequential calls. */
export interface RuntimeUpdateBeginParams {
  readonly version: string;
  readonly digest: string;
  readonly totalBytes: number;
  /**
   * Source commit these bytes were built from, for a rolling channel; `null` or
   * absent for a stable one, where the version already names the build.
   *
   * The absent case is not "leave what is recorded alone": the slot config is
   * written by merge, so an update that omitted this left the *previous*
   * commit next to the new binary. Stale provenance reads as confident and
   * wrong, where missing provenance at least reads as missing — so a slot's
   * recorded commit is replaced or cleared by every update, never inherited.
   */
  readonly sourceSha?: string | null;
}

export interface RuntimeUpdateBeginResult {
  readonly sessionId: string;
  readonly maxChunkBytes: number;
}

export interface RuntimeUpdateChunkParams {
  readonly sessionId: string;
  readonly seq: number;
  readonly bytesBase64: string;
}

export interface RuntimeUpdateChunkResult {
  readonly acceptedBytes: number;
  readonly receivedBytes: number;
}

export interface RuntimeUpdateCommitParams {
  readonly sessionId: string;
}

export interface RuntimeUpdateCommitResult {
  readonly version: string;
  readonly digest: string;
  /** Manual means the new bytes are current but this process keeps serving the old inode. */
  readonly restart: 'scheduled' | 'manual';
}

export interface RuntimeMethodMap {
  'fs.read-file': {
    readonly params: RuntimeReadFileParams;
    readonly result: RuntimeReadFileResult;
  };
  'fs.write-file': {
    readonly params: RuntimeWriteFileParams;
    readonly result: RuntimeMutationResult<RuntimeWriteFileResult>;
  };
  'fs.create-file': {
    readonly params: RuntimeCreateFileParams;
    readonly result: RuntimeMutationResult<RuntimeCreateFileResult>;
  };
  'fs.edit-file': {
    readonly params: RuntimeEditFileParams;
    readonly result: RuntimeMutationResult<RuntimeEditFileResult>;
  };
  'fs.replace-range': {
    readonly params: RuntimeReplaceRangeParams;
    readonly result: RuntimeMutationResult<RuntimeReplaceRangeResult>;
  };
  'fs.delete-file': {
    readonly params: RuntimeDeleteFileParams;
    readonly result: RuntimeMutationResult<RuntimeDeleteFileResult>;
  };
  'fs.move-file': {
    readonly params: RuntimeMoveFileParams;
    readonly result: RuntimeMutationResult<RuntimeMoveFileResult>;
  };
  'fs.list-directory': {
    readonly params: RuntimeListDirectoryParams;
    readonly result: RuntimeListDirectoryResult;
  };
  'fs.glob': {
    readonly params: RuntimeGlobParams;
    readonly result: RuntimeGlobResult;
  };
  'fs.grep': {
    readonly params: RuntimeGrepParams;
    readonly result: RuntimeGrepResult;
  };
  'fs.apply-patch': {
    readonly params: RuntimeApplyPatchParams;
    readonly result: RuntimeMutationResult<RuntimeApplyPatchResult>;
  };
  'shell.run': {
    readonly params: RuntimeShellRunParams;
    readonly result: RuntimeShellResult;
  };
  'git.exec': {
    readonly params: RuntimeGitExecParams;
    readonly result: RuntimeGitExecResult;
  };
  /** Read-only `gh` subcommands; refuses a write subcommand structurally. */
  'gh.exec': {
    readonly params: RuntimeGhExecParams;
    readonly result: RuntimeGhExecResult;
  };
  /** Mutating `gh` subcommands; needs shell consent on top of git. */
  'gh.mutate': {
    readonly params: RuntimeGhExecParams;
    readonly result: RuntimeGhExecResult;
  };
  'snapshot.capture': {
    readonly params: RuntimeSnapshotCaptureParams;
    readonly result: RuntimeBeforeSnapshot;
  };
  'snapshot.hash': {
    readonly params: RuntimeSnapshotHashParams;
    readonly result: RuntimeSnapshotHashResult;
  };
  'snapshot.revert': {
    readonly params: RuntimeSnapshotRevertParams;
    readonly result: RuntimeSnapshotRevertResult;
  };
  'workspace.browse': {
    readonly params: RuntimeWorkspaceBrowseParams;
    readonly result: RuntimeWorkspaceBrowseResult;
  };
  'workspace.validate': {
    readonly params: RuntimeWorkspaceValidateParams;
    readonly result: RuntimeWorkspaceValidateResult;
  };
  'workspace.resolve-contained': {
    readonly params: RuntimeWorkspaceResolveContainedParams;
    readonly result: RuntimeWorkspaceResolveContainedResult;
  };
  'mcp.connect': {
    readonly params: RuntimeMcpConnectParams;
    readonly result: RuntimeMcpConnectResult;
  };
  'mcp.list-tools': {
    readonly params: RuntimeMcpServerParams;
    readonly result: RuntimeMcpListToolsResult;
  };
  'mcp.call-tool': {
    readonly params: RuntimeMcpCallToolParams;
    readonly result: RuntimeMcpCallResult;
  };
  'mcp.list-resources': {
    readonly params: RuntimeMcpServerParams;
    readonly result: RuntimeMcpListResourcesResult;
  };
  'mcp.read-resource': {
    readonly params: RuntimeMcpReadResourceParams;
    readonly result: RuntimeMcpReadResourceResult;
  };
  'mcp.list-prompts': {
    readonly params: RuntimeMcpServerParams;
    readonly result: RuntimeMcpListPromptsResult;
  };
  'mcp.get-prompt': {
    readonly params: RuntimeMcpGetPromptParams;
    readonly result: RuntimeMcpPromptResult;
  };
  'mcp.elicit-response': {
    readonly params: RuntimeMcpElicitResponseParams;
    readonly result: RuntimeMcpAckResult;
  };
  'mcp.disconnect': {
    readonly params: RuntimeMcpServerParams;
    readonly result: RuntimeMcpAckResult;
  };
  'external-agent.discover': {
    readonly params: ExternalAgentDiscoverParams;
    readonly result: ExternalAgentDiscoverResult;
  };
  'external-agent.open': {
    readonly params: ExternalAgentOpenParams;
    readonly result: ExternalAgentOpenResult;
  };
  'external-agent.turn': {
    readonly params: ExternalAgentTurnParams;
    readonly result: ExternalAgentTurnResult;
  };
  'external-agent.respond': {
    readonly params: ExternalAgentRespondParams;
    readonly result: ExternalAgentAckResult;
  };
  'external-agent.steer': {
    readonly params: ExternalAgentSteerParams;
    readonly result: ExternalAgentSteerResult;
  };
  /**
   * A vendor-native review, started on an already-open session. It produces the
   * same ordered event stream a turn does — there is no second event path.
   */
  'external-agent.start-review': {
    readonly params: ExternalAgentStartReviewParams;
    readonly result: ExternalAgentStartReviewResult;
  };
  'external-agent.cancel': {
    readonly params: ExternalAgentCancelParams;
    readonly result: ExternalAgentAckResult;
  };
  'external-agent.close': {
    readonly params: ExternalAgentCloseParams;
    readonly result: ExternalAgentAckResult;
  };
  'external-agent.refresh-account-usage': {
    readonly params: ExternalAgentRefreshAccountUsageParams;
    readonly result: ExternalAgentRefreshAccountUsageResult;
  };
  'external-agent.list-sessions': {
    readonly params: ExternalAgentListSessionsParams;
    readonly result: ExternalAgentListSessionsResult;
  };
  'probing.runtimes': {
    readonly params: RuntimeProbeRuntimesParams;
    readonly result: RuntimeProbeRuntimesResult;
  };
  'probing.version-managers': {
    readonly params: RuntimeProbeVersionManagersParams;
    readonly result: RuntimeProbeVersionManagersResult;
  };
  'probing.agent-clis': {
    readonly params: RuntimeProbeAgentClisParams;
    readonly result: RuntimeProbeAgentClisResult;
  };
  'install.run': {
    readonly params: RuntimeInstallRunParams;
    readonly result: RuntimeInstallRunResult;
  };
  'install.cancel': {
    readonly params: RuntimeInstallCancelParams;
    readonly result: { readonly ok: true };
  };
  'terminal.open': {
    readonly params: RuntimeTerminalOpenParams;
    readonly result: RuntimeTerminalOpenResult;
  };
  'terminal.attach': {
    readonly params: RuntimeTerminalAttachParams;
    readonly result: RuntimeTerminalAttachResult;
  };
  'terminal.detach': {
    readonly params: RuntimeTerminalDetachParams;
    readonly result: { readonly ok: true };
  };
  'terminal.write': {
    readonly params: RuntimeTerminalWriteParams;
    readonly result: { readonly ok: true };
  };
  'terminal.resize': {
    readonly params: RuntimeTerminalResizeParams;
    readonly result: { readonly ok: true };
  };
  'terminal.ack': {
    readonly params: RuntimeTerminalAckParams;
    readonly result: { readonly ok: true };
  };
  'terminal.close': {
    readonly params: RuntimeTerminalCloseParams;
    readonly result: { readonly ok: true };
  };
  'terminal.list': {
    readonly params: Record<string, never>;
    readonly result: RuntimeTerminalListResult;
  };
  'library.scan': {
    readonly params: RuntimeLibraryScanParams;
    readonly result: RuntimeLibraryScanResult;
  };
  'library.read': {
    readonly params: RuntimeLibraryReadParams;
    readonly result: RuntimeLibraryReadResult;
  };
  'library.read-tree': {
    readonly params: RuntimeLibraryReadTreeParams;
    readonly result: RuntimeLibraryReadTreeResult;
  };
  'library.locations': {
    readonly params: RuntimeLibraryLocationsParams;
    readonly result: RuntimeLibraryLocationsResult;
  };
  'library.settings-sources': {
    readonly params: RuntimeLibrarySettingsSourcesParams;
    readonly result: RuntimeSettingsSourcesResult;
  };
  'library.apply': {
    readonly params: RuntimeLibraryApplyParams;
    readonly result: RuntimeLibraryApplyResult;
  };
  'library.remove': {
    readonly params: RuntimeLibraryRemoveParams;
    readonly result: RuntimeLibraryRemoveResult;
  };
  'library.undo': {
    readonly params: RuntimeLibraryUndoParams;
    readonly result: RuntimeLibraryUndoResult;
  };
  'library.backups': {
    readonly params: RuntimeLibraryBackupsParams;
    readonly result: RuntimeLibraryBackupsResult;
  };
  'library.gc': {
    readonly params: RuntimeLibraryGcParams;
    readonly result: RuntimeLibraryGcResult;
  };
  'runtime.health': {
    readonly params: Record<string, never>;
    readonly result: RuntimeHealthReport;
  };
  'runtime.update.begin': {
    readonly params: RuntimeUpdateBeginParams;
    readonly result: RuntimeUpdateBeginResult;
  };
  'runtime.update.chunk': {
    readonly params: RuntimeUpdateChunkParams;
    readonly result: RuntimeUpdateChunkResult;
  };
  'runtime.update.commit': {
    readonly params: RuntimeUpdateCommitParams;
    readonly result: RuntimeUpdateCommitResult;
  };
}

export type RuntimeMethod = keyof RuntimeMethodMap;
