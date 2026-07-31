import type { RuntimeShellKind } from '@mangostudio/shared/runtime-protocol';
import type {
  ListDirectoryResponse,
  WorkdirValidationReason,
} from '@mangostudio/shared/workspaces';

export const RUNTIME_ABSENT_HASH = 'absent';

export interface RuntimeBeforeSnapshot {
  readonly exists: boolean;
  readonly contentBase64?: string;
  readonly hash?: string;
}

export interface RuntimeMutationSnapshot {
  readonly path: string;
  readonly op: 'create' | 'delete' | 'edit' | 'move';
  readonly movedTo?: string;
  readonly before: RuntimeBeforeSnapshot;
  readonly afterHash: string;
}

export interface RuntimeMutationResult<T> {
  readonly result: T;
  readonly mutations: readonly RuntimeMutationSnapshot[];
}

export interface RuntimeReadFileParams {
  readonly chatId: string;
  readonly inputPath: string;
  readonly resolvedPath: string;
  readonly startLine?: number;
  readonly maxLines?: number;
}

export interface RuntimeReadFileResult {
  readonly content: string;
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly totalLines: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly truncated: boolean;
}

interface RuntimeMutationParams {
  readonly chatId: string;
  readonly captureSnapshot: boolean;
}

export interface RuntimeWriteFileParams extends RuntimeMutationParams {
  readonly inputPath: string;
  readonly resolvedPath: string;
  readonly content: string;
}

export interface RuntimeWriteFileResult {
  readonly path: string;
  readonly bytesWritten: number;
  readonly created: boolean;
  readonly sha256: string;
}

export interface RuntimeCreateFileParams extends RuntimeMutationParams {
  readonly inputPath: string;
  readonly resolvedPath: string;
  readonly content: string;
}

export interface RuntimeCreateFileResult {
  readonly path: string;
  readonly bytesWritten: number;
  readonly sha256: string;
}

export interface RuntimeEditFileParams extends RuntimeMutationParams {
  readonly inputPath: string;
  readonly resolvedPath: string;
  readonly oldString: string;
  readonly newString: string;
  readonly replaceAll?: boolean;
}

export interface RuntimeEditFileResult {
  readonly path: string;
  readonly replacements: number;
  readonly sha256: string;
  readonly firstChangedLine: number;
}

export interface RuntimeReplaceRangeParams extends RuntimeMutationParams {
  readonly inputPath: string;
  readonly resolvedPath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
}

export interface RuntimeReplaceRangeResult {
  readonly path: string;
  readonly replacedLines: number;
  readonly newTotalLines: number;
  readonly sha256: string;
}

export interface RuntimeDeleteFileParams extends RuntimeMutationParams {
  readonly inputPath: string;
  readonly resolvedPath: string;
}

export interface RuntimeDeleteFileResult {
  readonly path: string;
  readonly deleted: true;
}

export interface RuntimeMoveFileParams extends RuntimeMutationParams {
  readonly inputFrom: string;
  readonly inputTo: string;
  readonly resolvedFrom: string;
  readonly resolvedTo: string;
}

export interface RuntimeMoveFileResult {
  readonly from: string;
  readonly to: string;
  readonly moved: true;
}

export interface RuntimeListDirectoryParams {
  readonly inputPath: string;
  readonly resolvedPath: string;
}

export interface RuntimeListDirectoryResult {
  readonly path: string;
  readonly entries: ReadonlyArray<{
    readonly name: string;
    readonly type: 'file' | 'directory';
  }>;
}

export interface RuntimePathFilter {
  readonly allowedRoots: readonly string[];
  readonly deniedRoots: readonly string[];
  readonly containmentRoot?: string;
}

export interface RuntimeGlobParams extends RuntimePathFilter {
  readonly pattern: string;
  readonly cwd: string;
  readonly maxResults: number;
  readonly includeDotfiles: boolean;
  readonly absolute: boolean;
}

export interface RuntimeGlobResult {
  readonly pattern: string;
  readonly cwd: string;
  readonly matches: readonly string[];
  readonly truncated: boolean;
}

export interface RuntimeGrepParams extends RuntimePathFilter {
  readonly pattern: string;
  readonly inputPath: string;
  readonly resolvedPath: string;
  readonly glob?: string;
  readonly caseInsensitive: boolean;
  readonly maxResults: number;
  readonly maxMatchesPerFile: number;
  readonly maxFileSizeBytes: number;
  readonly includeDotfiles: boolean;
}

export interface RuntimeGrepResult {
  readonly pattern: string;
  readonly path: string;
  readonly matches: ReadonlyArray<{
    readonly file: string;
    readonly line: number;
    readonly text: string;
  }>;
  readonly filesScanned: number;
  readonly truncated: boolean;
}

export interface RuntimePatchHunkLine {
  readonly type: 'context' | 'add' | 'delete';
  readonly content: string;
  readonly ending: '' | '\n' | '\r\n';
}

export interface RuntimePatchHunk {
  readonly marker?: string;
  readonly lines: readonly RuntimePatchHunkLine[];
}

export type RuntimePatchOperation =
  | {
      readonly type: 'add';
      readonly inputPath: string;
      readonly resolvedPath: string;
      readonly content: string;
    }
  | {
      readonly type: 'delete';
      readonly inputPath: string;
      readonly resolvedPath: string;
    }
  | {
      readonly type: 'update';
      readonly inputPath: string;
      readonly resolvedPath: string;
      readonly moveTo?: string;
      readonly resolvedMoveTo?: string;
      readonly hunks: readonly RuntimePatchHunk[];
    };

export interface RuntimeApplyPatchParams extends RuntimeMutationParams {
  readonly operations: readonly RuntimePatchOperation[];
}

export interface RuntimeApplyPatchResult {
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly op: 'add' | 'update' | 'delete' | 'move';
    readonly movedTo?: string;
    readonly sha256?: string;
  }>;
  readonly summary: string;
}

export interface RuntimeShellRunParams {
  readonly kind: RuntimeShellKind;
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly envPolicy?: {
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
  };
}

export interface RuntimeShellResult {
  readonly shell: RuntimeShellKind;
  readonly command: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly termination:
    | { readonly kind: 'exited' }
    | { readonly kind: 'timed_out' }
    | { readonly kind: 'aborted' }
    | { readonly kind: 'signalled'; readonly signal: string };
  readonly durationMs: number;
}

export interface RuntimeGitExecParams {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly acceptedExitCodes?: readonly number[];
}

export interface RuntimeGitExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface RuntimeSnapshotCaptureParams {
  readonly path: string;
}

export interface RuntimeSnapshotHashParams {
  readonly path: string;
}

export interface RuntimeSnapshotHashResult {
  readonly hash: string | null;
}

export interface RuntimeSnapshotRevertParams {
  readonly chatId: string;
  /** When set, every revert path must stay inside this root after symlink resolution. */
  readonly containmentRoot?: string;
  readonly expected: readonly {
    readonly path: string;
    readonly afterHash: string;
  }[];
  readonly operations: readonly (
    | { readonly type: 'create'; readonly path: string }
    | {
        readonly type: 'restore';
        readonly path: string;
        readonly contentBase64: string;
      }
    | {
        readonly type: 'move';
        readonly path: string;
        readonly movedTo: string;
        readonly contentBase64: string;
      }
  )[];
}

export interface RuntimeWorkspaceBrowseParams {
  readonly path?: string;
}

export type RuntimeWorkspaceBrowseResult = ListDirectoryResponse;

export type RuntimeWorkspaceValidateResult =
  | { readonly ok: true; readonly resolvedPath: string }
  | { readonly ok: false; readonly reason: WorkdirValidationReason };

export interface RuntimeWorkspaceValidateParams {
  readonly path: string;
  readonly requireAbsolute?: boolean;
}

export interface RuntimeWorkspaceResolveContainedParams {
  readonly root: string;
  /** Root-relative path, in either separator style; the runtime applies its own. */
  readonly path: string;
}

export interface RuntimeWorkspaceResolveContainedResult {
  /** Root-relative canonical path, or null when nothing exists at that location. */
  readonly relativePath: string | null;
}

export interface RuntimeSnapshotRevertResult {
  readonly revertedFiles: number;
}

export interface RuntimeMethodMap {
  'fs.read-file': {
    readonly params: RuntimeReadFileParams;
    readonly result: RuntimeReadFileResult;
  };
  'fs.write-file': {
    readonly params: RuntimeWriteFileParams;
    readonly result: RuntimeMutationResult<RuntimeWriteFileResult>;
  };
  'fs.create-file': {
    readonly params: RuntimeCreateFileParams;
    readonly result: RuntimeMutationResult<RuntimeCreateFileResult>;
  };
  'fs.edit-file': {
    readonly params: RuntimeEditFileParams;
    readonly result: RuntimeMutationResult<RuntimeEditFileResult>;
  };
  'fs.replace-range': {
    readonly params: RuntimeReplaceRangeParams;
    readonly result: RuntimeMutationResult<RuntimeReplaceRangeResult>;
  };
  'fs.delete-file': {
    readonly params: RuntimeDeleteFileParams;
    readonly result: RuntimeMutationResult<RuntimeDeleteFileResult>;
  };
  'fs.move-file': {
    readonly params: RuntimeMoveFileParams;
    readonly result: RuntimeMutationResult<RuntimeMoveFileResult>;
  };
  'fs.list-directory': {
    readonly params: RuntimeListDirectoryParams;
    readonly result: RuntimeListDirectoryResult;
  };
  'fs.glob': {
    readonly params: RuntimeGlobParams;
    readonly result: RuntimeGlobResult;
  };
  'fs.grep': {
    readonly params: RuntimeGrepParams;
    readonly result: RuntimeGrepResult;
  };
  'fs.apply-patch': {
    readonly params: RuntimeApplyPatchParams;
    readonly result: RuntimeMutationResult<RuntimeApplyPatchResult>;
  };
  'shell.run': {
    readonly params: RuntimeShellRunParams;
    readonly result: RuntimeShellResult;
  };
  'git.exec': {
    readonly params: RuntimeGitExecParams;
    readonly result: RuntimeGitExecResult;
  };
  'snapshot.capture': {
    readonly params: RuntimeSnapshotCaptureParams;
    readonly result: RuntimeBeforeSnapshot;
  };
  'snapshot.hash': {
    readonly params: RuntimeSnapshotHashParams;
    readonly result: RuntimeSnapshotHashResult;
  };
  'snapshot.revert': {
    readonly params: RuntimeSnapshotRevertParams;
    readonly result: RuntimeSnapshotRevertResult;
  };
  'workspace.browse': {
    readonly params: RuntimeWorkspaceBrowseParams;
    readonly result: RuntimeWorkspaceBrowseResult;
  };
  'workspace.validate': {
    readonly params: RuntimeWorkspaceValidateParams;
    readonly result: RuntimeWorkspaceValidateResult;
  };
  'workspace.resolve-contained': {
    readonly params: RuntimeWorkspaceResolveContainedParams;
    readonly result: RuntimeWorkspaceResolveContainedResult;
  };
}

export type RuntimeMethod = keyof RuntimeMethodMap;
