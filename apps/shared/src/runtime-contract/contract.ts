/**
 * The runtime contract: every method the hub may call on a runtime, what each
 * one needs the machine's owner to have granted, the events a runtime
 * publishes, and the manifest it announces itself with.
 *
 * One definition drives four things — the hub's typed client, the runtime's
 * typed handler map, the parameter validation `serve` runs before a handler
 * sees a payload, and the catalog document a peer in another language can
 * generate from. Adding a method here without a handler in the runtime's
 * registry is a compile error there; adding one without a capability list is a
 * compile error here.
 *
 * ## Schemas
 *
 * The ten `external-agent.*` methods and the seven results below carry real
 * TypeBox schemas, because those shapes already had one. Everything else
 * carries {@link UnsafeObjectSchema}: the type is exact, and the validation is
 * "is a JSON object" — precisely the check the hand-written dispatcher ran.
 * Replacing one with a real schema is a local change; nothing else moves.
 *
 * @example
 * const client = RUNTIME_CONTRACT.client(session);
 * const { text } = await client.request('fs.read-file', { path: 'README.md' });
 */

import { defineContract, type MethodParams, type MethodResult } from '@mangostudio/protocol';
import type { TSchema } from 'typebox';
import {
  ExternalAgentAckResultSchema,
  ExternalAgentCancelParamsSchema,
  ExternalAgentCloseParamsSchema,
  ExternalAgentDiscoverParamsSchema,
  ExternalAgentDiscoverResultSchema,
  ExternalAgentListSessionsParamsSchema,
  ExternalAgentListSessionsResultSchema,
  ExternalAgentOpenParamsSchema,
  ExternalAgentOpenResultSchema,
  ExternalAgentRefreshAccountUsageParamsSchema,
  ExternalAgentRefreshAccountUsageResultSchema,
  ExternalAgentRespondParamsSchema,
  ExternalAgentStartReviewParamsSchema,
  ExternalAgentStartReviewResultSchema,
  ExternalAgentSteerParamsSchema,
  ExternalAgentSteerResultSchema,
  ExternalAgentTurnParamsSchema,
  ExternalAgentTurnResultSchema,
} from '../external-agents/schemas';
import {
  LibraryUndoResultSchema,
  PropagationApplySchema,
  RemovalApplySchema,
  type RuntimeSettingsSourcesResult,
} from '../library';
import type { RuntimeCapabilityAllow } from '../runtime-home';
import { RuntimeHealthReportSchema } from '../runtime-home/schemas';
import { UnsafeObjectSchema } from '../schema-helpers';
import { ListDirectoryResponseSchema } from '../workspaces/schemas';
import { RUNTIME_CONTRACT_EVENTS } from './events';
import { RuntimeCapabilityManifestSchema } from './manifest';
import type * as Methods from './methods';

/** Contract name announced in `hello.capabilities.contracts`. */
export const RUNTIME_CONTRACT_NAME = 'mangostudio.runtime';

/** Contract version announced beside the name; independent of the wire version. */
export const RUNTIME_CONTRACT_VERSION = '1.0.0';

/**
 * What a method needs this machine's owner to have granted.
 *
 * Keyed to the consent file's `allow` set, so naming a capability nobody can
 * grant is a compile error rather than a method that silently answers to
 * nothing.
 */
export type RuntimeMethodCapability = keyof RuntimeCapabilityAllow;

interface RuntimeMethodDefinition<P extends TSchema, R extends TSchema> {
  readonly params: P;
  readonly result: R;
  readonly capabilities: readonly RuntimeMethodCapability[];
  readonly description?: string;
}

/** One row of the method table; the capability list is the consent gate's only source. */
function method<P extends TSchema, R extends TSchema>(
  params: P,
  result: R,
  capabilities: readonly RuntimeMethodCapability[],
  description?: string
): RuntimeMethodDefinition<P, R> {
  return { params, result, capabilities, ...(description !== undefined ? { description } : {}) };
}

const RUNTIME_METHODS = {
  'fs.read-file': method(
    UnsafeObjectSchema<Methods.RuntimeReadFileParams>(),
    UnsafeObjectSchema<Methods.RuntimeReadFileResult>(),
    ['fsRead']
  ),
  'fs.write-file': method(
    UnsafeObjectSchema<Methods.RuntimeWriteFileParams>(),
    UnsafeObjectSchema<Methods.RuntimeMutationResult<Methods.RuntimeWriteFileResult>>(),
    ['fsWrite']
  ),
  'fs.create-file': method(
    UnsafeObjectSchema<Methods.RuntimeCreateFileParams>(),
    UnsafeObjectSchema<Methods.RuntimeMutationResult<Methods.RuntimeCreateFileResult>>(),
    ['fsWrite']
  ),
  'fs.edit-file': method(
    UnsafeObjectSchema<Methods.RuntimeEditFileParams>(),
    UnsafeObjectSchema<Methods.RuntimeMutationResult<Methods.RuntimeEditFileResult>>(),
    ['fsWrite']
  ),
  'fs.replace-range': method(
    UnsafeObjectSchema<Methods.RuntimeReplaceRangeParams>(),
    UnsafeObjectSchema<Methods.RuntimeMutationResult<Methods.RuntimeReplaceRangeResult>>(),
    ['fsWrite']
  ),
  'fs.delete-file': method(
    UnsafeObjectSchema<Methods.RuntimeDeleteFileParams>(),
    UnsafeObjectSchema<Methods.RuntimeMutationResult<Methods.RuntimeDeleteFileResult>>(),
    ['fsWrite']
  ),
  'fs.move-file': method(
    UnsafeObjectSchema<Methods.RuntimeMoveFileParams>(),
    UnsafeObjectSchema<Methods.RuntimeMutationResult<Methods.RuntimeMoveFileResult>>(),
    ['fsWrite']
  ),
  'fs.list-directory': method(
    UnsafeObjectSchema<Methods.RuntimeListDirectoryParams>(),
    UnsafeObjectSchema<Methods.RuntimeListDirectoryResult>(),
    ['fsRead']
  ),
  'fs.glob': method(
    UnsafeObjectSchema<Methods.RuntimeGlobParams>(),
    UnsafeObjectSchema<Methods.RuntimeGlobResult>(),
    ['fsRead']
  ),
  'fs.grep': method(
    UnsafeObjectSchema<Methods.RuntimeGrepParams>(),
    UnsafeObjectSchema<Methods.RuntimeGrepResult>(),
    ['fsRead']
  ),
  'fs.apply-patch': method(
    UnsafeObjectSchema<Methods.RuntimeApplyPatchParams>(),
    UnsafeObjectSchema<Methods.RuntimeMutationResult<Methods.RuntimeApplyPatchResult>>(),
    ['fsWrite']
  ),
  'shell.run': method(
    UnsafeObjectSchema<Methods.RuntimeShellRunParams>(),
    UnsafeObjectSchema<Methods.RuntimeShellResult>(),
    ['shell']
  ),
  'git.exec': method(
    UnsafeObjectSchema<Methods.RuntimeGitExecParams>(),
    UnsafeObjectSchema<Methods.RuntimeGitExecResult>(),
    ['git']
  ),
  'gh.exec': method(
    UnsafeObjectSchema<Methods.RuntimeGhExecParams>(),
    UnsafeObjectSchema<Methods.RuntimeGhExecResult>(),
    ['git'],
    'Read-only `gh` subcommands; refuses a write subcommand structurally.'
  ),
  'gh.mutate': method(
    UnsafeObjectSchema<Methods.RuntimeGhExecParams>(),
    UnsafeObjectSchema<Methods.RuntimeGhExecResult>(),
    ['git', 'shell'],
    'Mutating `gh` subcommands; needs shell consent on top of git.'
  ),
  'snapshot.capture': method(
    UnsafeObjectSchema<Methods.RuntimeSnapshotCaptureParams>(),
    UnsafeObjectSchema<Methods.RuntimeBeforeSnapshot>(),
    ['checkpoints', 'fsRead']
  ),
  'snapshot.hash': method(
    UnsafeObjectSchema<Methods.RuntimeSnapshotHashParams>(),
    UnsafeObjectSchema<Methods.RuntimeSnapshotHashResult>(),
    ['checkpoints', 'fsRead']
  ),
  'snapshot.revert': method(
    UnsafeObjectSchema<Methods.RuntimeSnapshotRevertParams>(),
    UnsafeObjectSchema<Methods.RuntimeSnapshotRevertResult>(),
    ['checkpoints', 'fsWrite']
  ),
  'workspace.browse': method(
    UnsafeObjectSchema<Methods.RuntimeWorkspaceBrowseParams>(),
    ListDirectoryResponseSchema,
    ['fsRead']
  ),
  'workspace.validate': method(
    UnsafeObjectSchema<Methods.RuntimeWorkspaceValidateParams>(),
    UnsafeObjectSchema<Methods.RuntimeWorkspaceValidateResult>(),
    ['fsRead']
  ),
  'workspace.resolve-contained': method(
    UnsafeObjectSchema<Methods.RuntimeWorkspaceResolveContainedParams>(),
    UnsafeObjectSchema<Methods.RuntimeWorkspaceResolveContainedResult>(),
    ['fsRead']
  ),
  'mcp.connect': method(
    UnsafeObjectSchema<Methods.RuntimeMcpConnectParams>(),
    UnsafeObjectSchema<Methods.RuntimeMcpConnectResult>(),
    ['mcp']
  ),
  'mcp.list-tools': method(
    UnsafeObjectSchema<Methods.RuntimeMcpServerParams>(),
    UnsafeObjectSchema<Methods.RuntimeMcpListToolsResult>(),
    ['mcp']
  ),
  'mcp.call-tool': method(
    UnsafeObjectSchema<Methods.RuntimeMcpCallToolParams>(),
    UnsafeObjectSchema<Methods.RuntimeMcpCallResult>(),
    ['mcp']
  ),
  'mcp.list-resources': method(
    UnsafeObjectSchema<Methods.RuntimeMcpServerParams>(),
    UnsafeObjectSchema<Methods.RuntimeMcpListResourcesResult>(),
    ['mcp']
  ),
  'mcp.read-resource': method(
    UnsafeObjectSchema<Methods.RuntimeMcpReadResourceParams>(),
    UnsafeObjectSchema<Methods.RuntimeMcpReadResourceResult>(),
    ['mcp']
  ),
  'mcp.list-prompts': method(
    UnsafeObjectSchema<Methods.RuntimeMcpServerParams>(),
    UnsafeObjectSchema<Methods.RuntimeMcpListPromptsResult>(),
    ['mcp']
  ),
  'mcp.get-prompt': method(
    UnsafeObjectSchema<Methods.RuntimeMcpGetPromptParams>(),
    UnsafeObjectSchema<Methods.RuntimeMcpPromptResult>(),
    ['mcp']
  ),
  'mcp.elicit-response': method(
    UnsafeObjectSchema<Methods.RuntimeMcpElicitResponseParams>(),
    UnsafeObjectSchema<Methods.RuntimeMcpAckResult>(),
    ['mcp']
  ),
  'mcp.disconnect': method(
    UnsafeObjectSchema<Methods.RuntimeMcpServerParams>(),
    UnsafeObjectSchema<Methods.RuntimeMcpAckResult>(),
    ['mcp']
  ),
  'external-agent.discover': method(
    ExternalAgentDiscoverParamsSchema,
    ExternalAgentDiscoverResultSchema,
    ['externalAgents']
  ),
  'external-agent.open': method(ExternalAgentOpenParamsSchema, ExternalAgentOpenResultSchema, [
    'externalAgents',
  ]),
  'external-agent.turn': method(ExternalAgentTurnParamsSchema, ExternalAgentTurnResultSchema, [
    'externalAgents',
  ]),
  'external-agent.respond': method(ExternalAgentRespondParamsSchema, ExternalAgentAckResultSchema, [
    'externalAgents',
  ]),
  'external-agent.steer': method(ExternalAgentSteerParamsSchema, ExternalAgentSteerResultSchema, [
    'externalAgents',
  ]),
  'external-agent.start-review': method(
    ExternalAgentStartReviewParamsSchema,
    ExternalAgentStartReviewResultSchema,
    ['externalAgents'],
    'A vendor-native review on an already-open session; it produces the same ordered event stream a turn does.'
  ),
  'external-agent.cancel': method(ExternalAgentCancelParamsSchema, ExternalAgentAckResultSchema, [
    'externalAgents',
  ]),
  'external-agent.close': method(ExternalAgentCloseParamsSchema, ExternalAgentAckResultSchema, [
    'externalAgents',
  ]),
  'external-agent.refresh-account-usage': method(
    ExternalAgentRefreshAccountUsageParamsSchema,
    ExternalAgentRefreshAccountUsageResultSchema,
    ['externalAgents']
  ),
  'external-agent.list-sessions': method(
    ExternalAgentListSessionsParamsSchema,
    ExternalAgentListSessionsResultSchema,
    ['externalAgents']
  ),
  'probing.runtimes': method(
    UnsafeObjectSchema<Methods.RuntimeProbeRuntimesParams>(),
    UnsafeObjectSchema<Methods.RuntimeProbeRuntimesResult>(),
    ['probing']
  ),
  'probing.version-managers': method(
    UnsafeObjectSchema<Methods.RuntimeProbeVersionManagersParams>(),
    UnsafeObjectSchema<Methods.RuntimeProbeVersionManagersResult>(),
    ['probing']
  ),
  'probing.agent-clis': method(
    UnsafeObjectSchema<Methods.RuntimeProbeAgentClisParams>(),
    UnsafeObjectSchema<Methods.RuntimeProbeAgentClisResult>(),
    ['probing']
  ),
  'install.run': method(
    UnsafeObjectSchema<Methods.RuntimeInstallRunParams>(),
    UnsafeObjectSchema<Methods.RuntimeInstallRunResult>(),
    ['shell']
  ),
  'install.cancel': method(
    UnsafeObjectSchema<Methods.RuntimeInstallCancelParams>(),
    UnsafeObjectSchema<{ readonly ok: true }>(),
    ['shell']
  ),
  'terminal.open': method(
    UnsafeObjectSchema<Methods.RuntimeTerminalOpenParams>(),
    UnsafeObjectSchema<Methods.RuntimeTerminalOpenResult>(),
    ['shell']
  ),
  'terminal.attach': method(
    UnsafeObjectSchema<Methods.RuntimeTerminalAttachParams>(),
    UnsafeObjectSchema<Methods.RuntimeTerminalAttachResult>(),
    ['shell']
  ),
  'terminal.detach': method(
    UnsafeObjectSchema<Methods.RuntimeTerminalDetachParams>(),
    UnsafeObjectSchema<{ readonly ok: true }>(),
    ['shell']
  ),
  'terminal.write': method(
    UnsafeObjectSchema<Methods.RuntimeTerminalWriteParams>(),
    UnsafeObjectSchema<{ readonly ok: true }>(),
    ['shell']
  ),
  'terminal.resize': method(
    UnsafeObjectSchema<Methods.RuntimeTerminalResizeParams>(),
    UnsafeObjectSchema<{ readonly ok: true }>(),
    ['shell']
  ),
  'terminal.ack': method(
    UnsafeObjectSchema<Methods.RuntimeTerminalAckParams>(),
    UnsafeObjectSchema<{ readonly ok: true }>(),
    ['shell']
  ),
  'terminal.close': method(
    UnsafeObjectSchema<Methods.RuntimeTerminalCloseParams>(),
    UnsafeObjectSchema<{ readonly ok: true }>(),
    ['shell']
  ),
  'terminal.list': method(
    UnsafeObjectSchema<Record<string, never>>(),
    UnsafeObjectSchema<Methods.RuntimeTerminalListResult>(),
    ['shell']
  ),
  'library.scan': method(
    UnsafeObjectSchema<Methods.RuntimeLibraryScanParams>(),
    UnsafeObjectSchema<Methods.RuntimeLibraryScanResult>(),
    ['library']
  ),
  'library.read': method(
    UnsafeObjectSchema<Methods.RuntimeLibraryReadParams>(),
    UnsafeObjectSchema<Methods.RuntimeLibraryReadResult>(),
    ['library']
  ),
  'library.read-tree': method(
    UnsafeObjectSchema<Methods.RuntimeLibraryReadTreeParams>(),
    UnsafeObjectSchema<Methods.RuntimeLibraryReadTreeResult>(),
    ['library']
  ),
  'library.locations': method(
    UnsafeObjectSchema<Methods.RuntimeLibraryLocationsParams>(),
    UnsafeObjectSchema<Methods.RuntimeLibraryLocationsResult>(),
    ['library']
  ),
  'library.settings-sources': method(
    UnsafeObjectSchema<Methods.RuntimeLibrarySettingsSourcesParams>(),
    UnsafeObjectSchema<RuntimeSettingsSourcesResult>(),
    ['library']
  ),
  'library.apply': method(
    UnsafeObjectSchema<Methods.RuntimeLibraryApplyParams>(),
    PropagationApplySchema,
    ['library', 'fsWrite']
  ),
  'library.remove': method(
    UnsafeObjectSchema<Methods.RuntimeLibraryRemoveParams>(),
    RemovalApplySchema,
    ['library', 'fsWrite']
  ),
  'library.undo': method(
    UnsafeObjectSchema<Methods.RuntimeLibraryUndoParams>(),
    LibraryUndoResultSchema,
    ['library', 'fsWrite']
  ),
  'library.backups': method(
    UnsafeObjectSchema<Methods.RuntimeLibraryBackupsParams>(),
    UnsafeObjectSchema<Methods.RuntimeLibraryBackupsResult>(),
    ['library']
  ),
  'library.gc': method(
    UnsafeObjectSchema<Methods.RuntimeLibraryGcParams>(),
    UnsafeObjectSchema<Methods.RuntimeLibraryGcResult>(),
    ['library', 'fsWrite']
  ),
  'runtime.health': method(
    UnsafeObjectSchema<Record<string, never>>(),
    RuntimeHealthReportSchema,
    []
  ),
  'runtime.update.begin': method(
    UnsafeObjectSchema<Methods.RuntimeUpdateBeginParams>(),
    UnsafeObjectSchema<Methods.RuntimeUpdateBeginResult>(),
    ['update']
  ),
  'runtime.update.chunk': method(
    UnsafeObjectSchema<Methods.RuntimeUpdateChunkParams>(),
    UnsafeObjectSchema<Methods.RuntimeUpdateChunkResult>(),
    ['update']
  ),
  'runtime.update.commit': method(
    UnsafeObjectSchema<Methods.RuntimeUpdateCommitParams>(),
    UnsafeObjectSchema<Methods.RuntimeUpdateCommitResult>(),
    ['update']
  ),
} as const;

export const RUNTIME_CONTRACT = defineContract({
  name: RUNTIME_CONTRACT_NAME,
  version: RUNTIME_CONTRACT_VERSION,
  description: 'What a MangoStudio hub may ask of a runtime on the machine it manages.',
  methods: RUNTIME_METHODS,
  events: RUNTIME_CONTRACT_EVENTS,
  capabilities: RuntimeCapabilityManifestSchema,
});

/** The method half of the definition, for anything that keys on a method name. */
export type RuntimeMethods = typeof RUNTIME_METHODS;

export type RuntimeMethod = keyof RuntimeMethods & string;

/**
 * Params and result per method, derived from the contract.
 *
 * The hub's facades and the runtime's registry both index this, so a schema
 * change reaches every call site through the typecheck rather than through a
 * second hand-written table.
 */
export type RuntimeMethodMap = {
  readonly [K in RuntimeMethod]: {
    readonly params: MethodParams<RuntimeMethods, K>;
    readonly result: MethodResult<RuntimeMethods, K>;
  };
};
