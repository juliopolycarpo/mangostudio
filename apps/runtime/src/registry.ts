import type { ExternalIdentityIsolation } from '@mangostudio/shared/external-agents';
import type { RuntimeSlot } from '@mangostudio/shared/runtime-home';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import { type RuntimeConsentSource, staticConsentSource } from './consent-source';
import { RuntimeToolArgumentError } from './errors';
import { collectRuntimeHealth } from './health';
import type { RuntimeEventInput, RuntimeHandlerContext, RuntimeMethodHandler } from './host';
import type { RuntimeMethod, RuntimeMethodMap } from './methods';
import type { ExternalAgentAdapter } from './services/external-agents/adapter';
import { ExternalAgentAdapterRegistry } from './services/external-agents/registry';
import {
  ExternalAgentSessionSupervisor,
  type ExternalAgentSupervisorOptions,
} from './services/external-agents/supervisor';
import { runtimeFsService } from './services/fs';
import { execGit } from './services/git';
import { createInstallService } from './services/install';
import { libraryService } from './services/library/service';
import { createMcpService } from './services/mcp/service';
import { probingService } from './services/probing/service';
import {
  createRuntimeUpdateService,
  type RuntimeUpdateServiceOptions,
} from './services/runtime-update';
import { runShellCommand } from './services/shell';
import { captureFileSnapshot, hashFileAtPath, revertRuntimeSnapshots } from './services/snapshot';
import {
  browseWorkspace,
  resolveContainedWorkspacePath,
  validateWorkdir,
} from './services/workspace';

export interface RuntimeMethodRegistryOptions {
  /** Release string this host reports to the MCP servers it initializes. */
  readonly runtimeVersion: string;
  /** Publishes an `evt` frame; the MCP methods stream elicitations through it. */
  readonly emit: (event: RuntimeEventInput) => void;
  /**
   * Slot whose `runtime.json` this host answers for. Health reads it so a
   * dialled-in peer reports the same consent the CLI's `health --json` would.
   */
  readonly slot?: RuntimeSlot;
  readonly update?: Omit<RuntimeUpdateServiceOptions, 'slot'>;
  readonly consent?: RuntimeConsentSource;
  readonly externalAgents?: Omit<
    ExternalAgentSupervisorOptions,
    'registry' | 'runtimeVersion' | 'emit' | 'consent'
  > & {
    readonly adapters?: readonly ExternalAgentAdapter[];
    readonly identityIsolation?: ExternalIdentityIsolation;
  };
}

export interface RuntimeMethodRegistry {
  readonly handlers: ReadonlyMap<string, RuntimeMethodHandler>;
  readonly updateActive: () => boolean;
  readonly externalAgentRegistry: ExternalAgentAdapterRegistry;
  /** Releases everything the handlers hold open — MCP sessions today. */
  close(): Promise<void>;
}

/** Registers the protocol methods owned by the runtime in this release. */
export function createRuntimeMethodHandlers(
  options: RuntimeMethodRegistryOptions
): RuntimeMethodRegistry {
  const mcp = createMcpService({ runtimeVersion: options.runtimeVersion, emit: options.emit });
  const install = createInstallService({ emit: options.emit });
  const update = createRuntimeUpdateService({
    slot: options.slot ?? 'host',
    ...options.update,
  });
  const consent =
    options.consent ?? staticConsentSource(RUNTIME_CONSENT_PRESETS.full, options.slot ?? 'host');
  const externalAgentRegistry = new ExternalAgentAdapterRegistry(options.externalAgents?.adapters);
  const externalAgents = new ExternalAgentSessionSupervisor({
    // Caller options first: the four fields below are owned here, and excess
    // property checking only protects object literals. A caller that passes a
    // pre-built wider object must not be able to substitute the consent source
    // the supervisor enforces.
    ...(options.externalAgents ?? {}),
    registry: externalAgentRegistry,
    runtimeVersion: options.runtimeVersion,
    emit: options.emit,
    consent,
  });

  return {
    handlers: new Map<string, RuntimeMethodHandler>([
      handler('fs.read-file', (params) => runtimeFsService.readFile(params)),
      handler('fs.write-file', (params) => runtimeFsService.writeFile(params)),
      handler('fs.create-file', (params) => runtimeFsService.createFile(params)),
      handler('fs.edit-file', (params) => runtimeFsService.editFile(params)),
      handler('fs.replace-range', (params) => runtimeFsService.replaceRange(params)),
      handler('fs.delete-file', (params) => runtimeFsService.deleteFile(params)),
      handler('fs.move-file', (params) => runtimeFsService.moveFile(params)),
      handler('fs.list-directory', (params) => runtimeFsService.listDirectory(params)),
      handler('fs.glob', (params, context) => runtimeFsService.glob(params, context.signal)),
      handler('fs.grep', (params, context) => runtimeFsService.grep(params, context.signal)),
      handler('fs.apply-patch', (params) => runtimeFsService.applyPatch(params)),
      handler('shell.run', (params, context) =>
        runShellCommand({ ...params, signal: context.signal })
      ),
      handler('git.exec', (params, context) => execGit(params, context.signal)),
      handler('snapshot.capture', (params) => captureFileSnapshot(params.path)),
      handler('snapshot.hash', async (params) => ({
        hash: await hashFileAtPath(params.path),
      })),
      handler('snapshot.revert', (params) => revertRuntimeSnapshots(params)),
      handler('workspace.browse', (params) => browseWorkspace(params)),
      handler('workspace.validate', (params) =>
        validateWorkdir(params.path, { requireAbsolute: params.requireAbsolute })
      ),
      handler('workspace.resolve-contained', (params) => resolveContainedWorkspacePath(params)),
      handler('mcp.connect', (params, context) => mcp.connect(params, context)),
      handler('mcp.list-tools', (params) => mcp.listTools(params)),
      handler('mcp.call-tool', (params, context) => mcp.callTool(params, context)),
      handler('mcp.list-resources', (params) => mcp.listResources(params)),
      handler('mcp.read-resource', (params) => mcp.readResource(params)),
      handler('mcp.list-prompts', (params) => mcp.listPrompts(params)),
      handler('mcp.get-prompt', (params) => mcp.getPrompt(params)),
      handler('mcp.elicit-response', (params) => mcp.respondToElicitation(params)),
      handler('mcp.disconnect', (params) => mcp.disconnect(params)),
      handler('external-agent.discover', (params, context) =>
        externalAgents.discover(params, context.signal)
      ),
      handler('external-agent.open', (params, context) =>
        externalAgents.open(params, context.signal)
      ),
      handler('external-agent.turn', (params) => externalAgents.turn(params)),
      handler('external-agent.respond', (params) => externalAgents.respond(params)),
      handler('external-agent.cancel', (params) => externalAgents.cancel(params)),
      handler('external-agent.close', (params) => externalAgents.closeSession(params)),
      handler('probing.runtimes', (params) => probingService.probeRuntimes(params)),
      handler('probing.version-managers', (params) => probingService.probeVersionManagers(params)),
      handler('probing.agent-clis', (params) => probingService.probeAgentClis(params)),
      handler('install.run', (params) => install.run(params)),
      handler('install.cancel', (params) => install.cancel(params)),
      handler('library.scan', (params) => libraryService.scan(params)),
      handler('library.read', (params) => libraryService.read(params)),
      handler('library.read-tree', (params) => libraryService.readTree(params)),
      handler('library.locations', (params) => libraryService.locations(params)),
      handler('library.settings-sources', (params) => libraryService.settingsSources(params)),
      handler('library.apply', (params, context) => libraryService.apply(params, context.signal)),
      handler('library.remove', (params, context) => libraryService.remove(params, context.signal)),
      handler('library.undo', (params, context) => libraryService.undo(params, context.signal)),
      handler('library.backups', (params) => libraryService.backups(params)),
      handler('library.gc', (params) => libraryService.gc(params)),
      handler('runtime.health', () =>
        collectRuntimeHealth({
          runtimeVersion: options.runtimeVersion,
          ...(options.slot ? { slot: options.slot } : {}),
          ...(options.update?.env ? { env: options.update.env } : {}),
          externalAgents: {
            ...externalAgents.health,
            ...(options.externalAgents?.identityIsolation
              ? { identityIsolation: options.externalAgents.identityIsolation }
              : {}),
          },
        })
      ),
      handler('runtime.update.begin', (params) => update.begin(params)),
      handler('runtime.update.chunk', (params) => update.chunk(params)),
      handler('runtime.update.commit', (params) => update.commit(params)),
    ]),
    updateActive: () => update.active,
    externalAgentRegistry,
    close: async () => {
      // Settled, not chained: the external-agent supervisor owns spawned vendor
      // processes and their process trees, so an earlier rejection must not skip
      // its teardown and leak them for the life of the runtime. `install.close`
      // is in here for the same reason — it aborts hub-supplied argv, and a
      // throw from one of those aborts must not take the reaper down with it.
      const results = await Promise.allSettled([
        (async () => install.close())(),
        update.close(),
        mcp.close(),
        externalAgents.close(),
      ]);
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Runtime service teardown failed.');
      }
    },
  };
}

function handler<K extends RuntimeMethod>(
  method: K,
  execute: (
    params: RuntimeMethodMap[K]['params'],
    context: RuntimeHandlerContext
  ) => Promise<RuntimeMethodMap[K]['result']>
): readonly [K, RuntimeMethodHandler] {
  return [
    method,
    (params, context) => {
      assertParamsObject(method, params);
      return execute(params as RuntimeMethodMap[K]['params'], context);
    },
  ];
}

function assertParamsObject(method: string, params: unknown): asserts params is object {
  if (typeof params === 'object' && params !== null && !Array.isArray(params)) return;
  // A bare TypeError reaches the client as an unclassified INTERNAL error;
  // errorPayloadFor only forwards `kind` for RuntimeServiceError instances.
  throw new RuntimeToolArgumentError(
    `Runtime method "${method}" requires an object params payload.`
  );
}
