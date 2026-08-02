import type {
  AgentCliStatus,
  MinimumRuntimeVersion,
  RuntimeId,
  RuntimeStatus,
  VersionManagerId,
  VersionManagerStatus,
} from '@mangostudio/shared/environments';
import type { LibraryTargetId } from '@mangostudio/shared/library';
import type {
  McpElicitationAction,
  McpElicitationField,
  McpPromptDescriptor,
  McpResourceDescriptor,
  McpToolDescriptor,
  McpTransport,
} from '@mangostudio/shared/mcp';
import type { RuntimeShellKind } from '@mangostudio/shared/runtime-protocol';
import type {
  ListDirectoryResponse,
  WorkdirValidationReason,
} from '@mangostudio/shared/workspaces';

export const RUNTIME_ABSENT_HASH = 'absent';

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

export interface RuntimePathFilter {
  readonly allowedRoots: readonly string[];
  readonly deniedRoots: readonly string[];
  readonly containmentRoot?: string;
}

/**
 * Path policy the hub decided for a call, carried by every filesystem method.
 *
 * The hub owns the decision — which roots a tool may touch, whether the chat is
 * pinned to its working directory — but only this host can tell where a path
 * actually lands, because only this host can follow the symlinks on the way.
 * Omitted when nothing is configured and nothing is restricted.
 */
export interface RuntimePathPolicyParams {
  readonly pathPolicy?: RuntimePathFilter;
}

export interface RuntimeReadFileParams extends RuntimePathPolicyParams {
  readonly chatId: string;
  readonly inputPath: string;
  readonly resolvedPath: string;
  readonly startLine?: number;
  readonly maxLines?: number;
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
   * What the hub is, for the `mangostudio` target. `configHome` and
   * `executablePath` are sent only when this host *is* the hub's machine;
   * elsewhere the runtime answers with its own, which is the honest reading of
   * "what MangoStudio looks like over there".
   */
  readonly self: {
    readonly version: string;
    readonly configHome?: string;
    readonly executablePath?: string;
  };
}

export interface RuntimeProbeAgentClisResult {
  readonly statuses: readonly AgentCliStatus[];
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
}

export type RuntimeMethod = keyof RuntimeMethodMap;
