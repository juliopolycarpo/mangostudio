/**
 * The runtime contract: every method the hub may call on a runtime, what each
 * one needs the machine's owner to have granted, the events a runtime
 * publishes, and the manifest it announces itself with.
 *
 * One definition drives five things — the hub's typed client, the runtime's
 * typed handler map, the parameter validation `serve` runs before a handler
 * sees a payload, the result validation it runs outside production, and the
 * catalog document a peer in another language is built from. Adding a method
 * here without a handler in the runtime's registry is a compile error there;
 * adding one without a capability list is a compile error here.
 *
 * ## Schemas
 *
 * Every method carries a real TypeBox schema, and every shape it names is
 * declared once in `methods/` and derived with `Static<>`. That is what makes
 * `catalog.json` worth generating: the catalog is only as good as the schemas
 * in it, and a peer built from a catalog of `{ "type": "object" }` would have
 * been told nothing at all.
 *
 * The schemas are deliberately open — no `additionalProperties: false` — so a
 * newer hub can send a member an older runtime has never heard of and be
 * ignored rather than refused. Closing them would make every additive change a
 * breaking one.
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
import { RuntimeSettingsSourcesResultSchema } from '../library/settings-sources';
import type { RuntimeCapabilityAllow } from '../runtime-home';
import { RuntimeHealthReportSchema } from '../runtime-home/schemas';
import { RUNTIME_CONTRACT_EVENTS } from './events';
import { RuntimeCapabilityManifestSchema } from './manifest';
import * as Methods from './methods';

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
  'fs.read-file': method(Methods.RuntimeReadFileParamsSchema, Methods.RuntimeReadFileResultSchema, [
    'fsRead',
  ]),
  'fs.write-file': method(
    Methods.RuntimeWriteFileParamsSchema,
    Methods.RuntimeMutationResultSchema(Methods.RuntimeWriteFileResultSchema),
    ['fsWrite']
  ),
  'fs.create-file': method(
    Methods.RuntimeCreateFileParamsSchema,
    Methods.RuntimeMutationResultSchema(Methods.RuntimeCreateFileResultSchema),
    ['fsWrite']
  ),
  'fs.edit-file': method(
    Methods.RuntimeEditFileParamsSchema,
    Methods.RuntimeMutationResultSchema(Methods.RuntimeEditFileResultSchema),
    ['fsWrite']
  ),
  'fs.replace-range': method(
    Methods.RuntimeReplaceRangeParamsSchema,
    Methods.RuntimeMutationResultSchema(Methods.RuntimeReplaceRangeResultSchema),
    ['fsWrite']
  ),
  'fs.delete-file': method(
    Methods.RuntimeDeleteFileParamsSchema,
    Methods.RuntimeMutationResultSchema(Methods.RuntimeDeleteFileResultSchema),
    ['fsWrite']
  ),
  'fs.move-file': method(
    Methods.RuntimeMoveFileParamsSchema,
    Methods.RuntimeMutationResultSchema(Methods.RuntimeMoveFileResultSchema),
    ['fsWrite']
  ),
  'fs.list-directory': method(
    Methods.RuntimeListDirectoryParamsSchema,
    Methods.RuntimeListDirectoryResultSchema,
    ['fsRead']
  ),
  'fs.glob': method(Methods.RuntimeGlobParamsSchema, Methods.RuntimeGlobResultSchema, ['fsRead']),
  'fs.grep': method(Methods.RuntimeGrepParamsSchema, Methods.RuntimeGrepResultSchema, ['fsRead']),
  'fs.apply-patch': method(
    Methods.RuntimeApplyPatchParamsSchema,
    Methods.RuntimeMutationResultSchema(Methods.RuntimeApplyPatchResultSchema),
    ['fsWrite']
  ),
  'shell.run': method(Methods.RuntimeShellRunParamsSchema, Methods.RuntimeShellResultSchema, [
    'shell',
  ]),
  'git.exec': method(Methods.RuntimeGitExecParamsSchema, Methods.RuntimeGitExecResultSchema, [
    'git',
  ]),
  'gh.exec': method(
    Methods.RuntimeGhExecParamsSchema,
    Methods.RuntimeGhExecResultSchema,
    ['git'],
    'Read-only `gh` subcommands; refuses a write subcommand structurally.'
  ),
  'gh.mutate': method(
    Methods.RuntimeGhExecParamsSchema,
    Methods.RuntimeGhExecResultSchema,
    ['git', 'shell'],
    'Mutating `gh` subcommands; needs shell consent on top of git.'
  ),
  'snapshot.capture': method(
    Methods.RuntimeSnapshotCaptureParamsSchema,
    Methods.RuntimeBeforeSnapshotSchema,
    ['checkpoints', 'fsRead']
  ),
  'snapshot.hash': method(
    Methods.RuntimeSnapshotHashParamsSchema,
    Methods.RuntimeSnapshotHashResultSchema,
    ['checkpoints', 'fsRead']
  ),
  'snapshot.revert': method(
    Methods.RuntimeSnapshotRevertParamsSchema,
    Methods.RuntimeSnapshotRevertResultSchema,
    ['checkpoints', 'fsWrite']
  ),
  'workspace.browse': method(
    Methods.RuntimeWorkspaceBrowseParamsSchema,
    Methods.RuntimeWorkspaceBrowseResultSchema,
    ['fsRead']
  ),
  'workspace.validate': method(
    Methods.RuntimeWorkspaceValidateParamsSchema,
    Methods.RuntimeWorkspaceValidateResultSchema,
    ['fsRead']
  ),
  'workspace.resolve-contained': method(
    Methods.RuntimeWorkspaceResolveContainedParamsSchema,
    Methods.RuntimeWorkspaceResolveContainedResultSchema,
    ['fsRead']
  ),
  'mcp.connect': method(
    Methods.RuntimeMcpConnectParamsSchema,
    Methods.RuntimeMcpConnectResultSchema,
    ['mcp']
  ),
  'mcp.list-tools': method(
    Methods.RuntimeMcpServerParamsSchema,
    Methods.RuntimeMcpListToolsResultSchema,
    ['mcp']
  ),
  'mcp.call-tool': method(
    Methods.RuntimeMcpCallToolParamsSchema,
    Methods.RuntimeMcpCallResultSchema,
    ['mcp']
  ),
  'mcp.list-resources': method(
    Methods.RuntimeMcpServerParamsSchema,
    Methods.RuntimeMcpListResourcesResultSchema,
    ['mcp']
  ),
  'mcp.read-resource': method(
    Methods.RuntimeMcpReadResourceParamsSchema,
    Methods.RuntimeMcpReadResourceResultSchema,
    ['mcp']
  ),
  'mcp.list-prompts': method(
    Methods.RuntimeMcpServerParamsSchema,
    Methods.RuntimeMcpListPromptsResultSchema,
    ['mcp']
  ),
  'mcp.get-prompt': method(
    Methods.RuntimeMcpGetPromptParamsSchema,
    Methods.RuntimeMcpPromptResultSchema,
    ['mcp']
  ),
  'mcp.elicit-response': method(
    Methods.RuntimeMcpElicitResponseParamsSchema,
    Methods.RuntimeMcpAckResultSchema,
    ['mcp']
  ),
  'mcp.disconnect': method(
    Methods.RuntimeMcpServerParamsSchema,
    Methods.RuntimeMcpAckResultSchema,
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
    Methods.RuntimeProbeRuntimesParamsSchema,
    Methods.RuntimeProbeRuntimesResultSchema,
    ['probing']
  ),
  'probing.version-managers': method(
    Methods.RuntimeProbeVersionManagersParamsSchema,
    Methods.RuntimeProbeVersionManagersResultSchema,
    ['probing']
  ),
  'probing.agent-clis': method(
    Methods.RuntimeProbeAgentClisParamsSchema,
    Methods.RuntimeProbeAgentClisResultSchema,
    ['probing']
  ),
  'install.run': method(
    Methods.RuntimeInstallRunParamsSchema,
    Methods.RuntimeInstallRunResultSchema,
    ['shell']
  ),
  'install.cancel': method(
    Methods.RuntimeInstallCancelParamsSchema,
    Methods.RuntimeAckResultSchema,
    ['shell']
  ),
  'terminal.open': method(
    Methods.RuntimeTerminalOpenParamsSchema,
    Methods.RuntimeTerminalOpenResultSchema,
    ['shell']
  ),
  'terminal.attach': method(
    Methods.RuntimeTerminalAttachParamsSchema,
    Methods.RuntimeTerminalAttachResultSchema,
    ['shell']
  ),
  'terminal.detach': method(
    Methods.RuntimeTerminalDetachParamsSchema,
    Methods.RuntimeAckResultSchema,
    ['shell']
  ),
  'terminal.write': method(
    Methods.RuntimeTerminalWriteParamsSchema,
    Methods.RuntimeAckResultSchema,
    ['shell']
  ),
  'terminal.resize': method(
    Methods.RuntimeTerminalResizeParamsSchema,
    Methods.RuntimeAckResultSchema,
    ['shell']
  ),
  'terminal.ack': method(Methods.RuntimeTerminalAckParamsSchema, Methods.RuntimeAckResultSchema, [
    'shell',
  ]),
  'terminal.close': method(
    Methods.RuntimeTerminalCloseParamsSchema,
    Methods.RuntimeAckResultSchema,
    ['shell']
  ),
  'terminal.list': method(Methods.RuntimeNoParamsSchema, Methods.RuntimeTerminalListResultSchema, [
    'shell',
  ]),
  'library.scan': method(
    Methods.RuntimeLibraryScanParamsSchema,
    Methods.RuntimeLibraryScanResultSchema,
    ['library']
  ),
  'library.read': method(
    Methods.RuntimeLibraryReadParamsSchema,
    Methods.RuntimeLibraryReadResultSchema,
    ['library']
  ),
  'library.read-tree': method(
    Methods.RuntimeLibraryReadTreeParamsSchema,
    Methods.RuntimeLibraryReadTreeResultSchema,
    ['library']
  ),
  'library.locations': method(
    Methods.RuntimeLibraryLocationsParamsSchema,
    Methods.RuntimeLibraryLocationsResultSchema,
    ['library']
  ),
  'library.settings-sources': method(
    Methods.RuntimeLibrarySettingsSourcesParamsSchema,
    RuntimeSettingsSourcesResultSchema,
    ['library']
  ),
  'library.apply': method(
    Methods.RuntimeLibraryApplyParamsSchema,
    Methods.RuntimeLibraryApplyResultSchema,
    ['library', 'fsWrite']
  ),
  'library.remove': method(
    Methods.RuntimeLibraryRemoveParamsSchema,
    Methods.RuntimeLibraryRemoveResultSchema,
    ['library', 'fsWrite']
  ),
  'library.undo': method(
    Methods.RuntimeLibraryUndoParamsSchema,
    Methods.RuntimeLibraryUndoResultSchema,
    ['library', 'fsWrite']
  ),
  'library.backups': method(
    Methods.RuntimeLibraryBackupsParamsSchema,
    Methods.RuntimeLibraryBackupsResultSchema,
    ['library']
  ),
  'library.gc': method(Methods.RuntimeLibraryGcParamsSchema, Methods.RuntimeLibraryGcResultSchema, [
    'library',
    'fsWrite',
  ]),
  'runtime.health': method(Methods.RuntimeNoParamsSchema, RuntimeHealthReportSchema, []),
  'runtime.update.begin': method(
    Methods.RuntimeUpdateBeginParamsSchema,
    Methods.RuntimeUpdateBeginResultSchema,
    ['update']
  ),
  'runtime.update.chunk': method(
    Methods.RuntimeUpdateChunkParamsSchema,
    Methods.RuntimeUpdateChunkResultSchema,
    ['update']
  ),
  'runtime.update.commit': method(
    Methods.RuntimeUpdateCommitParamsSchema,
    Methods.RuntimeUpdateCommitResultSchema,
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
