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

export const runtimeFsService = {
  readFile: (params: RuntimeReadFileParams) => readRuntimeFile(params),
  writeFile: (params: RuntimeWriteFileParams) => writeRuntimeFile(params),
  createFile: (params: RuntimeCreateFileParams) => createRuntimeFile(params),
  editFile: (params: RuntimeEditFileParams) => editRuntimeFile(params),
  replaceRange: (params: RuntimeReplaceRangeParams) => replaceRuntimeRange(params),
  deleteFile: (params: RuntimeDeleteFileParams) => deleteRuntimeFile(params),
  moveFile: (params: RuntimeMoveFileParams) => moveRuntimeFile(params),
  listDirectory: (params: RuntimeListDirectoryParams) => listRuntimeDirectory(params),
  glob: (params: RuntimeGlobParams) => globRuntimePaths(params),
  grep: (params: RuntimeGrepParams) => grepRuntimeFiles(params),
  applyPatch: (params: RuntimeApplyPatchParams) => applyRuntimePatch(params),
};
