/**
 * Hub-side re-exports of the library resource writer. Writes run in
 * `@mangostudio/shared/library/machine`; this path keeps Partial-deps
 * ergonomics and hub config defaults for Local tests and orchestrators.
 */

import {
  createResourceWriterDeps,
  type DirectoryResourceWriteInput,
  type FileResourceWriteInput,
  type ResourceWriteResult,
  type ResourceWriterDeps,
  type ResourceWriterFs,
  writeDirectoryResource as writeDirectoryResourceEngine,
  writeFileResource as writeFileResourceEngine,
} from '@mangostudio/shared/library/machine';
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
  return writeDirectoryResourceEngine(input, { ...defaultWriterDeps(), ...overrides });
}

export function writeFileResource(
  input: FileResourceWriteInput,
  overrides: Partial<ResourceWriterDeps> = {}
): Promise<ResourceWriteResult> {
  return writeFileResourceEngine(input, { ...defaultWriterDeps(), ...overrides });
}
