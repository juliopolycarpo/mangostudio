/**
 * A stale undo against the real library engine: the compiled Rust runtime,
 * asked over stdio to restore a backup set it never wrote, must reach the hub
 * as the 404 the frontend keys its undo on.
 *
 * The unit suite (`library-apply-transport.test.ts`) pins the hub half with a
 * fake host that throws the typed error; this file proves the runtime really
 * answers a missing set with that kind on the wire.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackupStoreDeps } from '@mangostudio/shared/library/machine';
import { undoLibraryPropagation } from '../../../../src/modules/library/application/propagation-apply';
import {
  resolveRustRuntimeBinary,
  skipWithoutRustBinary,
} from '../../../support/rust-runtime-binary';
import { type RustStdioRuntime, spawnRustStdioRuntime } from '../../../support/rust-stdio-runtime';

const binary = resolveRustRuntimeBinary();

let runtime: RustStdioRuntime | undefined;
let backupRoot: string | undefined;

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  if (backupRoot) await rm(backupRoot, { force: true, recursive: true });
  backupRoot = undefined;
});

describe('library.undo against the real runtime', () => {
  it.skipIf(skipWithoutRustBinary(binary, 'library-undo-missing-backup'))(
    'answers 404 when the runtime reports the backup set is gone',
    async () => {
      runtime = await spawnRustStdioRuntime(binary.path, { label: 'library-undo-missing' });
      backupRoot = await mkdtemp(join(tmpdir(), 'mango-library-undo-missing-'));
      const root = backupRoot;
      const client = runtime.client;

      // The error class does not cross the frame, so the 404 has to survive on
      // the kind the payload carries rather than on the message text.
      await expect(
        undoLibraryPropagation('2020-01-01T00-00-00.000Z-deadbeef', {
          pathEnv: () => ({ platform: 'linux', homeDir: '/tmp', env: {} }),
          backup: createBackupStoreDeps({
            backupRoot: () => root,
            retentionCount: () => 10,
            retentionBytes: () => 1024 * 1024,
          }),
          resetCaches: () => undefined,
          runtimeUndo: (params) => client.library.undo(params, { timeoutMs: 5_000 }),
        })
      ).rejects.toMatchObject({ status: 404 });
    },
    30_000
  );
});
