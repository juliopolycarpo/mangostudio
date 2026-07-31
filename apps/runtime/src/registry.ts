import { RuntimeToolArgumentError } from './errors';
import type { RuntimeHandlerContext, RuntimeMethodHandler } from './host';
import type { RuntimeMethod, RuntimeMethodMap } from './methods';
import { runtimeFsService } from './services/fs';
import { execGit } from './services/git';
import { runShellCommand } from './services/shell';
import { captureFileSnapshot, hashFileAtPath, revertRuntimeSnapshots } from './services/snapshot';
import {
  browseWorkspace,
  resolveContainedWorkspacePath,
  validateWorkdir,
} from './services/workspace';

/** Registers the protocol methods owned by the runtime in this release. */
export function createRuntimeMethodHandlers(): ReadonlyMap<string, RuntimeMethodHandler> {
  return new Map<string, RuntimeMethodHandler>([
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
  ]);
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
