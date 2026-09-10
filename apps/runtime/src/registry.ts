import type { EventInput } from '@mangostudio/protocol';
import type { ExternalIdentityIsolation } from '@mangostudio/shared/external-agents';
import type { RuntimeSlot } from '@mangostudio/shared/runtime-home';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import { type RuntimeConsentSource, staticConsentSource } from './consent-source';
import type { RuntimeHandlers } from './handlers';
import { collectRuntimeHealth } from './health';
import type { ExternalAgentAdapter } from './services/external-agents/adapter';
import { ExternalAgentAdapterRegistry } from './services/external-agents/registry';
import {
  ExternalAgentSessionSupervisor,
  type ExternalAgentSupervisorOptions,
} from './services/external-agents/supervisor';
import { runtimeFsService } from './services/fs';
import { closeGrepPool } from './services/fs/grep-scanner';
import { execGh, mutateGh } from './services/gh';
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
import { createTerminalService } from './services/terminal/service';
import {
  browseWorkspace,
  resolveContainedWorkspacePath,
  validateWorkdir,
} from './services/workspace';

export interface RuntimeMethodRegistryOptions {
  /** Release string this host reports to the MCP servers it initializes. */
  readonly runtimeVersion: string;
  /** Publishes an `evt` frame; the MCP methods stream elicitations through it. */
  readonly emit: (event: EventInput) => void;
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
  readonly handlers: RuntimeHandlers;
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
  const terminal = createTerminalService({ emit: options.emit });
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
    handlers: {
      // Handlers that can refuse take the call's `AbortSignal`. Forwarding it is
      // not the same as honouring it: each service decides where cancelling is
      // safe, and a mutation already under way is never abandoned. See
      // `services/cancellation.ts`. Short lookups and methods with their own
      // cancel RPC still ignore the request signal.
      'fs.read-file': (params, context) => runtimeFsService.readFile(params, context.signal),
      'fs.write-file': (params, context) => runtimeFsService.writeFile(params, context.signal),
      'fs.create-file': (params, context) => runtimeFsService.createFile(params, context.signal),
      'fs.edit-file': (params, context) => runtimeFsService.editFile(params, context.signal),
      'fs.replace-range': (params, context) =>
        runtimeFsService.replaceRange(params, context.signal),
      'fs.delete-file': (params, context) => runtimeFsService.deleteFile(params, context.signal),
      'fs.move-file': (params, context) => runtimeFsService.moveFile(params, context.signal),
      'fs.list-directory': (params, context) =>
        runtimeFsService.listDirectory(params, context.signal),
      'fs.glob': (params, context) => runtimeFsService.glob(params, context.signal),
      'fs.grep': (params, context) => runtimeFsService.grep(params, context.signal),
      'fs.apply-patch': (params, context) => runtimeFsService.applyPatch(params, context.signal),
      'shell.run': (params, context) => runShellCommand({ ...params, signal: context.signal }),
      'git.exec': (params, context) => execGit(params, context.signal),
      'gh.exec': (params, context) => execGh(params, context.signal),
      'gh.mutate': (params, context) => mutateGh(params, context.signal),
      'snapshot.capture': (params, context) => captureFileSnapshot(params.path, context.signal),
      'snapshot.hash': async (params, context) => ({
        hash: await hashFileAtPath(params.path, context.signal),
      }),
      'snapshot.revert': (params, context) => revertRuntimeSnapshots(params, context.signal),
      'workspace.browse': (params, context) => browseWorkspace(params, context.signal),
      'workspace.validate': (params) =>
        validateWorkdir(params.path, { requireAbsolute: params.requireAbsolute }),
      'workspace.resolve-contained': (params) => resolveContainedWorkspacePath(params),
      'mcp.connect': (params, context) => mcp.connect(params, context),
      'mcp.list-tools': (params) => mcp.listTools(params),
      'mcp.call-tool': (params, context) => mcp.callTool(params, context),
      'mcp.list-resources': (params) => mcp.listResources(params),
      'mcp.read-resource': (params) => mcp.readResource(params),
      'mcp.list-prompts': (params) => mcp.listPrompts(params),
      'mcp.get-prompt': (params) => mcp.getPrompt(params),
      'mcp.elicit-response': (params) => mcp.respondToElicitation(params),
      'mcp.disconnect': (params) => mcp.disconnect(params),
      'external-agent.discover': (params, context) =>
        externalAgents.discover(params, context.signal),
      'external-agent.open': (params, context) => externalAgents.open(params, context.signal),
      'external-agent.turn': (params) => externalAgents.turn(params),
      'external-agent.respond': (params) => externalAgents.respond(params),
      'external-agent.steer': (params) => externalAgents.steer(params),
      'external-agent.start-review': (params, context) =>
        externalAgents.startReview(params, context.signal),
      'external-agent.cancel': (params) => externalAgents.cancel(params),
      'external-agent.close': (params) => externalAgents.closeSession(params),
      'external-agent.list-sessions': (params, context) =>
        externalAgents.listSessions(params, context.signal),
      'external-agent.refresh-account-usage': (params, context) =>
        externalAgents.refreshAccountUsage(params, context.signal),
      'probing.runtimes': (params, context) => probingService.probeRuntimes(params, context.signal),
      'probing.version-managers': (params, context) =>
        probingService.probeVersionManagers(params, context.signal),
      'probing.agent-clis': (params, context) =>
        probingService.probeAgentClis(params, context.signal),
      'install.run': (params) => install.run(params),
      'install.cancel': (params) => install.cancel(params),
      'terminal.open': (params) => terminal.open(params),
      'terminal.attach': (params) => terminal.attach(params),
      'terminal.detach': (params) => terminal.detach(params),
      'terminal.write': (params) => terminal.write(params),
      'terminal.resize': (params) => terminal.resize(params),
      'terminal.ack': (params) => terminal.ack(params),
      'terminal.close': (params) => terminal.closeSession(params),
      'terminal.list': () => terminal.list(),
      'library.scan': (params, context) => libraryService.scan(params, context.signal),
      'library.read': (params) => libraryService.read(params),
      'library.read-tree': (params, context) => libraryService.readTree(params, context.signal),
      'library.locations': (params) => libraryService.locations(params),
      'library.settings-sources': (params) => libraryService.settingsSources(params),
      'library.apply': (params, context) => libraryService.apply(params, context.signal),
      'library.remove': (params, context) => libraryService.remove(params, context.signal),
      'library.undo': (params, context) => libraryService.undo(params, context.signal),
      'library.backups': (params) => libraryService.backups(params),
      'library.gc': (params) => libraryService.gc(params),
      'runtime.health': () =>
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
        }),
      'runtime.update.begin': (params) => update.begin(params),
      'runtime.update.chunk': (params) => update.chunk(params),
      'runtime.update.commit': (params) => update.commit(params),
    },
    updateActive: () => update.active,
    externalAgentRegistry,
    close: async () => {
      // Settled, not chained: the external-agent supervisor owns spawned vendor
      // processes and their process trees, so an earlier rejection must not skip
      // its teardown and leak them for the life of the runtime. `install.close`
      // is in here for the same reason — it aborts hub-supplied argv, and a
      // throw from one of those aborts must not take the reaper down with it.
      // `terminal.close` kills every open shell for the same reason: sessions do
      // not survive a host close, since a reconnect builds a fresh host.
      const results = await Promise.allSettled([
        (async () => install.close())(),
        (async () => terminal.close())(),
        update.close(),
        mcp.close(),
        externalAgents.close(),
        // The grep pool holds worker threads, not just memory: `unref` keeps
        // them from blocking exit but does not release them.
        closeGrepPool(),
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
