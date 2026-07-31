import type { RuntimeHandlerContext, RuntimeMethodHandler } from './host';
import type { RuntimeMethod, RuntimeMethodMap } from './methods';
import { runtimeFsService } from './services/fs';
import { runShellCommand } from './services/shell';
import { captureFileSnapshot, hashFileAtPath, revertRuntimeSnapshots } from './services/snapshot';

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
    handler('fs.glob', (params) => runtimeFsService.glob(params)),
    handler('fs.grep', (params) => runtimeFsService.grep(params)),
    handler('fs.apply-patch', (params) => runtimeFsService.applyPatch(params)),
    handler('shell.run', (params, context) =>
      runShellCommand({ ...params, signal: context.signal })
    ),
    handler('snapshot.capture', (params) => captureFileSnapshot(params.path)),
    handler('snapshot.hash', async (params) => ({
      hash: await hashFileAtPath(params.path),
    })),
    handler('snapshot.revert', (params) => revertRuntimeSnapshots(params)),
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
  throw new TypeError(`Runtime method "${method}" requires an object params payload.`);
}
