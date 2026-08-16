import { PathAccessError } from '../../errors';
import type {
  RuntimeMoveFileParams,
  RuntimeMoveFileResult,
  RuntimeMutationResult,
} from '../../methods';
import { throwIfAborted } from '../cancellation';
import { rekeyFile, withPathLocks } from '../file-freshness';
import { assertRegularFilePath, moveRegularFileWithoutOverwrite } from '../fs-utils';
import { captureFileSnapshot, hashFileAtPath, mutationSnapshot } from '../snapshot';

export async function moveRuntimeFile(
  params: RuntimeMoveFileParams,
  signal?: AbortSignal
): Promise<RuntimeMutationResult<RuntimeMoveFileResult>> {
  if (params.resolvedFrom === params.resolvedTo) {
    throw new PathAccessError('Source and destination must be different paths.');
  }
  throwIfAborted(signal);

  return await withPathLocks([params.resolvedFrom, params.resolvedTo], async () => {
    const source = await assertRegularFilePath(params.resolvedFrom, 'move');
    const before = params.captureSnapshot
      ? await captureFileSnapshot(params.resolvedFrom)
      : { exists: false };
    // The rename is the mutation, and it is not resumable from half-done.
    throwIfAborted(signal);
    await moveRegularFileWithoutOverwrite(
      params.resolvedFrom,
      params.resolvedTo,
      source.mode & 0o7777
    );
    rekeyFile(params.chatId, params.resolvedFrom, params.resolvedTo);
    const afterHash = await hashFileAtPath(params.resolvedTo);
    return {
      result: { from: params.inputFrom, to: params.inputTo, moved: true },
      mutations: mutationSnapshot(params.captureSnapshot, {
        path: params.resolvedFrom,
        op: 'move',
        movedTo: params.resolvedTo,
        before,
        afterHash,
      }),
    };
  });
}
