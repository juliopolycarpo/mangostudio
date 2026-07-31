import { lstat } from 'node:fs/promises';
import { PathAccessError } from '../../errors';
import type {
  RuntimeMutationResult,
  RuntimeWriteFileParams,
  RuntimeWriteFileResult,
} from '../../methods';
import { assertFresh, FileNotReadError, recordFileRead, withPathLocks } from '../file-freshness';
import {
  explainUnreadableMutationTarget,
  isErrnoException,
  RegularFileWriteError,
  writeRegularFileAtomic,
} from '../fs-utils';
import { captureFileSnapshot, mutationSnapshot } from '../snapshot';

export async function writeRuntimeFile(
  params: RuntimeWriteFileParams
): Promise<RuntimeMutationResult<RuntimeWriteFileResult>> {
  return await withPathLocks([params.resolvedPath], async () => {
    const created = !(await Bun.file(params.resolvedPath).exists());
    const before = params.captureSnapshot
      ? await captureFileSnapshot(params.resolvedPath)
      : { exists: false };

    if (!created) {
      try {
        await assertFresh(params.chatId, params.resolvedPath);
      } catch (error) {
        if (error instanceof FileNotReadError) {
          throw await explainUnreadableMutationTarget(params.resolvedPath, 'overwrite', error);
        }
        throw error;
      }
    }

    let committed: { bytesWritten: number; mtimeMs: number };
    try {
      committed = await writeRegularFileAtomic(params.resolvedPath, params.content, {
        exclusive: created,
      });
    } catch (error) {
      if (created && isErrnoException(error, 'EEXIST')) {
        throw await describeOccupiedPath(params.resolvedPath);
      }
      if (error instanceof RegularFileWriteError) throw new PathAccessError(error.message);
      throw error;
    }

    const sha256 = recordFileRead(
      params.chatId,
      params.resolvedPath,
      params.content,
      committed.mtimeMs
    );
    return {
      result: {
        path: params.inputPath,
        bytesWritten: committed.bytesWritten,
        created,
        sha256,
      },
      mutations: mutationSnapshot(params.captureSnapshot, {
        path: params.resolvedPath,
        op: created ? 'create' : 'edit',
        before,
        afterHash: sha256,
      }),
    };
  });
}

async function describeOccupiedPath(resolvedPath: string): Promise<Error> {
  const entry = await lstat(resolvedPath).catch(() => null);
  if (entry?.isFile()) {
    return await explainUnreadableMutationTarget(
      resolvedPath,
      'overwrite',
      new FileNotReadError(resolvedPath)
    );
  }
  return new PathAccessError(
    `Cannot write "${resolvedPath}": the path exists and is not a regular file.`
  );
}
