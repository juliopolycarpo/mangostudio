/**
 * Hub-side re-exports of the library resource writer. Writes run in
 * `@mangostudio/runtime`; this path keeps Partial-deps ergonomics and hub
 * config defaults for Local tests and orchestrators.
 */

import {
  createResourceWriterDeps,
  type DirectoryResourceWriteInput,
  type FileResourceWriteInput,
  type ResourceWriteResult,
  type ResourceWriterDeps,
  type ResourceWriterFs,
  writeDirectoryResource as writeDirectoryResourceRuntime,
  writeFileResource as writeFileResourceRuntime,
} from '@mangostudio/runtime';
import { getConfig } from '../../../lib/config';

export type {
  DirectoryResourceWriteInput,
  FileResourceWriteInput,
  ResourceWriteResult,
  ResourceWriterDeps,
  ResourceWriterFs,
};

function defaultWriterDeps(): ResourceWriterDeps {
  return createResourceWriterDeps({
    backupRoot: () => getConfig().library.backupDir,
    retentionCount: () => getConfig().library.backupRetentionCount,
    retentionBytes: () => getConfig().library.backupRetentionBytes,
  });
}

export function writeDirectoryResource(
  input: DirectoryResourceWriteInput,
  overrides: Partial<ResourceWriterDeps> = {}
): Promise<ResourceWriteResult> {
  return writeDirectoryResourceRuntime(input, { ...defaultWriterDeps(), ...overrides });
}

export function writeFileResource(
  input: FileResourceWriteInput,
  overrides: Partial<ResourceWriterDeps> = {}
): Promise<ResourceWriteResult> {
  return writeFileResourceRuntime(input, { ...defaultWriterDeps(), ...overrides });
}
