/**
 * Re-exports workspace path resolution from the runtime package so routes and
 * callers keep stable import paths.
 */

export { resolveWorkspacePath } from '@mangostudio/runtime';
export { WorkspacePathError } from '@mangostudio/shared/runtime-contract';
