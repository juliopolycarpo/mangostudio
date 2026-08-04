import type { RuntimeSlot } from '@mangostudio/shared/runtime-home';
import { RuntimeToolArgumentError } from './errors';
import { collectRuntimeHealth } from './health';
import type { RuntimeEventInput, RuntimeHandlerContext, RuntimeMethodHandler } from './host';
import type { RuntimeMethod, RuntimeMethodMap } from './methods';
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
}

export interface RuntimeMethodRegistry {
  readonly handlers: ReadonlyMap<string, RuntimeMethodHandler>;
  readonly updateActive: () => boolean;
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
      handler('probing.runtimes', (params) => probingService.probeRuntimes(params)),
      handler('probing.version-managers', (params) => probingService.probeVersionManagers(params)),
      handler('probing.agent-clis', (params) => probingService.probeAgentClis(params)),
      handler('install.run', (params) => install.run(params)),
      handler('install.cancel', (params) => install.cancel(params)),
      handler('library.scan', (params) => libraryService.scan(params)),
      handler('library.read', (params) => libraryService.read(params)),
      handler('library.locations', (params) => libraryService.locations(params)),
      handler('library.settings-sources', (params) => libraryService.settingsSources(params)),
      handler('library.apply', (params, context) => libraryService.apply(params, context.signal)),
      handler('library.remove', (params, context) => libraryService.remove(params, context.signal)),
      handler('library.undo', (params, context) => libraryService.undo(params, context.signal)),
      handler('runtime.health', () =>
        collectRuntimeHealth({
          runtimeVersion: options.runtimeVersion,
          ...(options.slot ? { slot: options.slot } : {}),
          ...(options.update?.env ? { env: options.update.env } : {}),
        })
      ),
      handler('runtime.update.begin', (params) => update.begin(params)),
      handler('runtime.update.chunk', (params) => update.chunk(params)),
      handler('runtime.update.commit', (params) => update.commit(params)),
    ]),
    updateActive: () => update.active,
    close: async () => {
      install.close();
      await update.close();
      await mcp.close();
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
