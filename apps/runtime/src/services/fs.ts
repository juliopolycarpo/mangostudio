import type {
  RuntimeApplyPatchParams,
  RuntimeCreateFileParams,
  RuntimeDeleteFileParams,
  RuntimeEditFileParams,
  RuntimeGlobParams,
  RuntimeGrepParams,
  RuntimeListDirectoryParams,
  RuntimeMoveFileParams,
  RuntimeReadFileParams,
  RuntimeReplaceRangeParams,
  RuntimeWriteFileParams,
} from '../methods';
import { applyRuntimePatch } from './fs/apply-patch';
import { createRuntimeFile } from './fs/create-file';
import { deleteRuntimeFile } from './fs/delete-file';
import { editRuntimeFile } from './fs/edit-file';
import { globRuntimePaths } from './fs/glob';
import { grepRuntimeFiles } from './fs/grep';
import { listRuntimeDirectory } from './fs/list-directory';
import { moveRuntimeFile } from './fs/move-file';
import { readRuntimeFile } from './fs/read-file';
import { replaceRuntimeRange } from './fs/replace-range';
import { writeRuntimeFile } from './fs/write-file';
import { guardPaths } from './fs-path-policy';

/**
 * Every entry declares which of its parameters are paths, so the call's path
 * policy is enforced here rather than in each service. Glob and grep declare
 * their starting point only — the candidates they walk are filtered as they are
 * discovered, inside the service that discovers them.
 */
export const runtimeFsService = {
  readFile: guardPaths(
    (params: RuntimeReadFileParams) => [params.resolvedPath],
    (params: RuntimeReadFileParams) => readRuntimeFile(params)
  ),
  writeFile: guardPaths(
    (params: RuntimeWriteFileParams) => [params.resolvedPath],
    (params: RuntimeWriteFileParams) => writeRuntimeFile(params)
  ),
  createFile: guardPaths(
    (params: RuntimeCreateFileParams) => [params.resolvedPath],
    (params: RuntimeCreateFileParams) => createRuntimeFile(params)
  ),
  editFile: guardPaths(
    (params: RuntimeEditFileParams) => [params.resolvedPath],
    (params: RuntimeEditFileParams) => editRuntimeFile(params)
  ),
  replaceRange: guardPaths(
    (params: RuntimeReplaceRangeParams) => [params.resolvedPath],
    (params: RuntimeReplaceRangeParams) => replaceRuntimeRange(params)
  ),
  deleteFile: guardPaths(
    (params: RuntimeDeleteFileParams) => [params.resolvedPath],
    (params: RuntimeDeleteFileParams) => deleteRuntimeFile(params)
  ),
  moveFile: guardPaths(
    (params: RuntimeMoveFileParams) => [params.resolvedFrom, params.resolvedTo],
    (params: RuntimeMoveFileParams) => moveRuntimeFile(params)
  ),
  listDirectory: guardPaths(
    (params: RuntimeListDirectoryParams) => [params.resolvedPath],
    (params: RuntimeListDirectoryParams) => listRuntimeDirectory(params)
  ),
  glob: guardPaths(
    (params: RuntimeGlobParams) => [params.cwd],
    (params: RuntimeGlobParams, signal?: AbortSignal) => globRuntimePaths(params, signal)
  ),
  grep: guardPaths(
    (params: RuntimeGrepParams) => [params.resolvedPath],
    (params: RuntimeGrepParams, signal?: AbortSignal) => grepRuntimeFiles(params, signal)
  ),
  applyPatch: guardPaths(
    (params: RuntimeApplyPatchParams) =>
      params.operations.flatMap((operation) => [
        operation.resolvedPath,
        ...(operation.type === 'update' && operation.resolvedMoveTo
          ? [operation.resolvedMoveTo]
          : []),
      ]),
    (params: RuntimeApplyPatchParams) => applyRuntimePatch(params)
  ),
};
