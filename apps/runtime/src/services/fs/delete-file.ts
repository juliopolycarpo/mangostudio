import { unlink } from 'node:fs/promises';
import type {
  RuntimeBeforeSnapshot,
  RuntimeDeleteFileParams,
  RuntimeDeleteFileResult,
  RuntimeMutationResult,
} from '../../methods';
import {
  assertFresh,
  FileNotReadError,
  forgetFile,
  readFreshFile,
  StaleFileError,
  withPathLocks,
} from '../file-freshness';
import {
  assertRegularFilePath,
  explainUnreadableMutationTarget,
  isErrnoException,
} from '../fs-utils';
import { mutationSnapshot, snapshotFromBytes } from '../snapshot';

export async function deleteRuntimeFile(
  params: RuntimeDeleteFileParams
): Promise<RuntimeMutationResult<RuntimeDeleteFileResult>> {
  return await withPathLocks([params.resolvedPath], async () => {
    await assertRegularFilePath(params.resolvedPath, 'delete');

    let before: RuntimeBeforeSnapshot = { exists: false };
    try {
      if (params.captureSnapshot) {
        const observed = await readFreshFile(params.chatId, params.resolvedPath);
        before = snapshotFromBytes(observed.bytes);
      } else {
        await assertFresh(params.chatId, params.resolvedPath);
      }
    } catch (error) {
      if (error instanceof FileNotReadError) {
        throw await explainUnreadableMutationTarget(params.resolvedPath, 'delete', error);
      }
      throw error;
    }

    try {
      await unlink(params.resolvedPath);
    } catch (error) {
      if (isErrnoException(error, 'ENOENT')) throw new StaleFileError(params.resolvedPath);
      throw error;
    }

    forgetFile(params.chatId, params.resolvedPath);
    return {
      result: { path: params.inputPath, deleted: true },
      mutations: mutationSnapshot(params.captureSnapshot, {
        path: params.resolvedPath,
        op: 'delete',
        before,
        afterHash: null,
      }),
    };
  });
}
