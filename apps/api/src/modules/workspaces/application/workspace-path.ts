/**
 * Re-exports workspace path resolution from the runtime package so routes and
 * callers keep stable import paths.
 */

export { resolveWorkspacePath, WorkspacePathError } from '@mangostudio/runtime';
