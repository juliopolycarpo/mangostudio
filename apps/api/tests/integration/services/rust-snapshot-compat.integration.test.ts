/**
 * Differential qualification for the snapshot methods a real Rust runtime
 * serves through the Hub. The Rust connection is always a compiled child;
 * the TypeScript connection crosses the same Hub codec in process.
 *
 * ## Assertion inventory
 *
 * | TypeScript assertion or implementation | Hub-level evidence here |
 * | --- | --- |
 * | `apps/runtime/src/services/snapshot.ts` capture and hash | exact UTF-8 and binary bytes, SHA-256 hashes, in-root symlink or junction traversal, directories, and absent paths agree over the real wire |
 * | `apps/runtime/tests/unit/services/snapshot.test.ts` snapshot size refusal | an 8 MiB plus one byte capture reports the same typed refusal and leaves the file intact |
 * | `apps/runtime/src/services/snapshot.ts` reverse replay | create removal, byte restoration, ordinary moves, and available Linux cross-device moves leave matching isolated trees |
 * | `apps/runtime/src/services/snapshot.ts` base64 decoding | unpadded, non-alphabet, and malformed base64 strings decode to the same restored bytes |
 * | `apps/runtime/src/services/snapshot.ts` `alreadyReverted` | completed retries converge, a repeated path replay lands at its earliest bytes, and a mixed state refuses untouched |
 * | `apps/runtime/tests/unit/services/snapshot.test.ts` containment | a symlink on Unix or junction on Windows cannot make `snapshot.revert` escape its root |
 * | `apps/runtime/src/services/snapshot.ts` `restoreBytes` | a restored file is immediately fresh for a same-chat overwrite |
 *
 * Destructive calls use different Rust and TypeScript trees. Read-only capture,
 * hash, and containment refusals share a tree so their full wire results and
 * errors compare directly, including the absolute path in the message.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { RemoteError } from '@mangostudio/protocol';
import {
  PathAccessError,
  RUNTIME_ABSENT_HASH,
  RuntimeSnapshotConflictError,
  type RuntimeSnapshotRevertParams,
} from '@mangostudio/shared/runtime-contract';
import { resolveRuntimeLaunchCommand } from '../../../src/lib/runtime-paths';
import { connectLocalRuntime } from '../../../src/services/runtime-client/connect-in-process-runtime';
import { RuntimeClient } from '../../../src/services/runtime-client/runtime-client';
import { spawnRuntimeChild } from '../../../src/services/runtime-client/spawn-runtime-child';
import {
  cleanupMangoHome,
  resolveRustRuntimeBinary,
  rustRuntimeVersion,
  scratchMangoHome,
} from '../../support/rust-runtime-binary';

const binary = resolveRustRuntimeBinary();
const SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;

interface FixturePair {
  readonly rust: string;
  readonly typescript: string;
}

interface CrossDeviceFixturePair {
  readonly rust: CrossDevicePaths;
  readonly typescript: CrossDevicePaths;
}

interface CrossDevicePaths {
  readonly sourceRoot: string;
  readonly destinationRoot: string;
}

interface ReversalFixture {
  readonly chatId: string;
  readonly createPath: string;
  readonly restorePath: string;
  readonly movedFrom: string;
  readonly movedTo: string;
  readonly createdBytes: Uint8Array;
  readonly restoredBytes: Uint8Array;
  readonly movedBytes: Uint8Array;
  readonly expected: RuntimeSnapshotRevertParams['expected'];
  readonly operations: RuntimeSnapshotRevertParams['operations'];
}

function allowQualificationWorkspace(): boolean {
  return true;
}

function hashOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

async function remoteError(call: () => Promise<unknown>): Promise<RemoteError> {
  try {
    await call();
  } catch (error) {
    expect(error).toBeInstanceOf(RemoteError);
    return error as RemoteError;
  }
  throw new Error('Expected the runtime call to fail.');
}

async function runtimeError(call: () => Promise<unknown>): Promise<Error> {
  try {
    await call();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('Expected the runtime call to fail.');
}

async function assertBytes(path: string, expected: Uint8Array): Promise<void> {
  expect(await readFile(path)).toEqual(Buffer.from(expected));
}

describe.skipIf(!binary.available)('Rust snapshot methods match the TypeScript runtime', () => {
  let root: string;
  let home: string;
  let previousHome: string | undefined;
  let rustConnection: Awaited<ReturnType<typeof spawnRuntimeChild>> | undefined;
  let typescriptConnection: Awaited<ReturnType<typeof connectLocalRuntime>> | undefined;
  let rust: RuntimeClient;
  let typescript: RuntimeClient;
  const crossDeviceRoots: string[] = [];

  async function fixturePair(label: string): Promise<FixturePair> {
    const parent = await mkdtemp(join(root, `${label}-`));
    const rustRoot = join(parent, 'rust');
    const typescriptRoot = join(parent, 'typescript');
    await Promise.all([mkdir(rustRoot), mkdir(typescriptRoot)]);
    return {
      rust: await realpath(rustRoot),
      typescript: await realpath(typescriptRoot),
    };
  }

  async function crossDeviceFixturePair(label: string): Promise<CrossDeviceFixturePair | null> {
    if (process.platform !== 'linux') return null;

    let destinationParent: string;
    try {
      destinationParent = await mkdtemp('/dev/shm/mango-rust-snapshot-compat-');
    } catch {
      return null;
    }
    const sources = await fixturePair(label);
    try {
      if ((await stat(sources.rust)).dev === (await stat(destinationParent)).dev) {
        await rm(destinationParent, { force: true, recursive: true });
        return null;
      }
      const rustDestinationRoot = join(destinationParent, 'rust');
      const typescriptDestinationRoot = join(destinationParent, 'typescript');
      await Promise.all([mkdir(rustDestinationRoot), mkdir(typescriptDestinationRoot)]);
      crossDeviceRoots.push(destinationParent);
      return {
        rust: { sourceRoot: sources.rust, destinationRoot: rustDestinationRoot },
        typescript: { sourceRoot: sources.typescript, destinationRoot: typescriptDestinationRoot },
      };
    } catch (error) {
      await rm(destinationParent, { force: true, recursive: true });
      throw error;
    }
  }

  async function reversalFixture(root: string): Promise<ReversalFixture> {
    const chatId = 'snapshot-reversal';
    const createdBytes = Buffer.from('created \u{1F95D}\r\n', 'utf8');
    const restoredBytes = Buffer.from([0x00, 0xff, 0x63, 0x61, 0x66, 0xc3, 0xa9, 0x0a]);
    const afterRestore = Buffer.from('replaced \u{1F680}\n', 'utf8');
    const movedBytes = Buffer.from('move me \u{1F30D}\r\n', 'utf8');
    const createPath = join(root, 'created.txt');
    const restorePath = join(root, 'restore.bin');
    const movedFrom = join(root, 'before-move.txt');
    const movedTo = join(root, 'after-move.txt');

    await Promise.all([
      writeFile(createPath, createdBytes),
      writeFile(restorePath, afterRestore),
      writeFile(movedTo, movedBytes),
    ]);

    return {
      chatId,
      createPath,
      restorePath,
      movedFrom,
      movedTo,
      createdBytes,
      restoredBytes,
      movedBytes,
      expected: [
        {
          path: createPath,
          afterHash: hashOf(createdBytes),
          revertedHash: RUNTIME_ABSENT_HASH,
        },
        {
          path: restorePath,
          afterHash: hashOf(afterRestore),
          revertedHash: hashOf(restoredBytes),
        },
        {
          path: movedFrom,
          afterHash: RUNTIME_ABSENT_HASH,
          revertedHash: hashOf(movedBytes),
        },
        {
          path: movedTo,
          afterHash: hashOf(movedBytes),
          revertedHash: RUNTIME_ABSENT_HASH,
        },
      ],
      operations: [
        { type: 'create', path: createPath },
        { type: 'restore', path: restorePath, contentBase64: base64Of(restoredBytes) },
        {
          type: 'move',
          path: movedFrom,
          movedTo,
          contentBase64: base64Of(movedBytes),
        },
      ],
    };
  }

  async function assertReversal(client: RuntimeClient, fixture: ReversalFixture): Promise<void> {
    const params = {
      chatId: fixture.chatId,
      expected: fixture.expected,
      operations: fixture.operations,
    };
    expect(await client.snapshot.revert(params)).toEqual({ revertedFiles: 3 });
    expect(await client.snapshot.revert(params)).toEqual({ revertedFiles: 3 });
    await expect(Bun.file(fixture.createPath).exists()).resolves.toBe(false);
    await assertBytes(fixture.restorePath, fixture.restoredBytes);
    await expect(Bun.file(fixture.movedFrom).exists()).resolves.toBe(true);
    await assertBytes(fixture.movedFrom, fixture.movedBytes);
    await expect(Bun.file(fixture.movedTo).exists()).resolves.toBe(false);

    const afterRestore = 'fresh after restore\n';
    expect(
      await client.fs.writeFile({
        chatId: fixture.chatId,
        captureSnapshot: false,
        inputPath: basename(fixture.restorePath),
        resolvedPath: fixture.restorePath,
        content: afterRestore,
      })
    ).toMatchObject({
      result: { created: false, bytesWritten: Buffer.byteLength(afterRestore) },
      mutations: [],
    });
    expect(await Bun.file(fixture.restorePath).text()).toBe(afterRestore);
  }

  beforeAll(async () => {
    previousHome = process.env.MANGO_HOME;
    home = await scratchMangoHome('snapshot-compat');
    process.env.MANGO_HOME = home;
    root = await mkdtemp(join(tmpdir(), 'mango-rust-snapshot-compat-'));
    rustConnection = await spawnRuntimeChild({
      environmentId: 'rust-snapshot-compat',
      launch: resolveRuntimeLaunchCommand(undefined, { MANGOSTUDIO_RUNTIME_BINARY: binary.path }),
      hubVersion: await rustRuntimeVersion(binary.path),
      onClosed: () => undefined,
    });
    typescriptConnection = await connectLocalRuntime({
      authorizeWorkspace: allowQualificationWorkspace,
      externalAgentIsolation: 'withdrawn',
    });
    rust = new RuntimeClient(rustConnection.hub, () => undefined, 'rust-snapshot-compat');
    typescript = new RuntimeClient(
      typescriptConnection.hub,
      () => undefined,
      'typescript-snapshot-compat'
    );
  }, 30_000);

  afterAll(async () => {
    await rustConnection?.close();
    await typescriptConnection?.close();
    if (previousHome === undefined) delete process.env.MANGO_HOME;
    else process.env.MANGO_HOME = previousHome;
    if (home) await cleanupMangoHome(home);
    await Promise.all(crossDeviceRoots.map((path) => rm(path, { force: true, recursive: true })));
    if (root) await rm(root, { force: true, recursive: true });
  });

  it('captures exact binary and Unicode bytes through an in-root link, hashes them, and preserves absence', async () => {
    const directory = await mkdtemp(join(root, 'read-only-'));
    const bytes = Buffer.from([
      0x00, 0xff, 0x63, 0x61, 0x66, 0xc3, 0xa9, 0x20, 0xf0, 0x9f, 0x9a, 0x80, 0x0d, 0x0a,
    ]);
    const targetDirectory = join(directory, 'target');
    const linkDirectory = join(directory, 'in-root-link');
    await mkdir(targetDirectory);
    await symlink(
      targetDirectory,
      linkDirectory,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    const path = join(targetDirectory, 'binary-unicode.bin');
    const linkedPath = join(linkDirectory, 'binary-unicode.bin');
    const absent = join(directory, 'absent.bin');
    const missingParent = join(directory, 'missing', 'parent', 'absent.bin');
    await writeFile(path, bytes);

    const expectedCapture = { exists: true, contentBase64: base64Of(bytes), hash: hashOf(bytes) };
    expect(await typescript.snapshot.capture({ path })).toEqual(expectedCapture);
    expect(await typescript.snapshot.hash({ path })).toEqual({ hash: hashOf(bytes) });
    expect(await typescript.snapshot.capture({ path: linkedPath })).toEqual(expectedCapture);
    expect(await typescript.snapshot.hash({ path: linkedPath })).toEqual({ hash: hashOf(bytes) });
    expect(await typescript.snapshot.capture({ path: absent })).toEqual({ exists: false });
    expect(await typescript.snapshot.hash({ path: absent })).toEqual({ hash: null });
    expect(await typescript.snapshot.capture({ path: missingParent })).toEqual({ exists: false });
    expect(await typescript.snapshot.hash({ path: missingParent })).toEqual({ hash: null });

    const expectedDirectoryCapture = await typescript.snapshot.capture({ path: targetDirectory });
    const expectedDirectoryHash = await typescript.snapshot.hash({ path: targetDirectory });

    expect(await rust.snapshot.capture({ path })).toEqual(expectedCapture);
    expect(await rust.snapshot.hash({ path })).toEqual({ hash: hashOf(bytes) });
    expect(await rust.snapshot.capture({ path: linkedPath })).toEqual(expectedCapture);
    expect(await rust.snapshot.hash({ path: linkedPath })).toEqual({ hash: hashOf(bytes) });
    expect(await rust.snapshot.capture({ path: absent })).toEqual({ exists: false });
    expect(await rust.snapshot.hash({ path: absent })).toEqual({ hash: null });
    expect(await rust.snapshot.capture({ path: missingParent })).toEqual({ exists: false });
    expect(await rust.snapshot.hash({ path: missingParent })).toEqual({ hash: null });
    expect(await rust.snapshot.capture({ path: targetDirectory })).toEqual(
      expectedDirectoryCapture
    );
    expect(await rust.snapshot.hash({ path: targetDirectory })).toEqual(expectedDirectoryHash);
  });

  it('rejects a snapshot above the byte limit with the exact Hub error', async () => {
    const directory = await mkdtemp(join(root, 'limit-'));
    const path = join(directory, 'too-large.bin');
    const sizeBytes = SNAPSHOT_MAX_BYTES + 1;
    await writeFile(path, new Uint8Array(sizeBytes));

    const expected = await remoteError(() => typescript.snapshot.capture({ path }));
    expect(expected).toMatchObject({
      code: 'INTERNAL',
      details: { kind: 'snapshot_too_large', resolvedPath: path, sizeBytes },
    });
    const actual = await remoteError(() => rust.snapshot.capture({ path }));
    expect(actual).toEqual(expected);
  });

  it('reverses create, restore, and move operations in isolated trees, then accepts a retry', async () => {
    const roots = await fixturePair('reversal');
    const rustFixture = await reversalFixture(roots.rust);
    const typescriptFixture = await reversalFixture(roots.typescript);

    await assertReversal(typescript, typescriptFixture);
    await assertReversal(rust, rustFixture);
  });

  it.each(['short', 'long'] as const)(
    'moves a snapshot with a %s source name back across Linux filesystems',
    async (nameLength) => {
      const fixtures = await crossDeviceFixturePair('cross-device-move');
      if (!fixtures) return;
      const bytes = Buffer.from('cross-device \u{1F30D}\n', 'utf8');

      async function assertCrossDeviceMove(
        client: RuntimeClient,
        paths: CrossDevicePaths
      ): Promise<void> {
        const source = join(paths.sourceRoot, 'before-move.txt');
        const destination = join(
          paths.destinationRoot,
          nameLength === 'long' ? 'm'.repeat(234) : 'after-move.txt'
        );
        await writeFile(destination, bytes);
        expect(
          await client.snapshot.revert({
            chatId: 'snapshot-cross-device-move',
            expected: [
              {
                path: source,
                afterHash: RUNTIME_ABSENT_HASH,
                revertedHash: hashOf(bytes),
              },
              {
                path: destination,
                afterHash: hashOf(bytes),
                revertedHash: RUNTIME_ABSENT_HASH,
              },
            ],
            operations: [
              {
                type: 'move',
                path: source,
                movedTo: destination,
                contentBase64: base64Of(bytes),
              },
            ],
          })
        ).toEqual({ revertedFiles: 1 });
        await assertBytes(source, bytes);
        await expect(Bun.file(destination).exists()).resolves.toBe(false);
      }

      await assertCrossDeviceMove(typescript, fixtures.typescript);
      await assertCrossDeviceMove(rust, fixtures.rust);
    }
  );

  it('can retry a cross-device revert after source removal is denied', async () => {
    if (process.getuid?.() === 0) return;
    const fixtures = await crossDeviceFixturePair('cross-device-retry');
    if (!fixtures) return;
    const bytes = Buffer.from('retained until the reverse move commits');

    async function assertRetry(client: RuntimeClient, paths: CrossDevicePaths): Promise<void> {
      const path = join(paths.sourceRoot, 'before.txt');
      const movedTo = join(paths.destinationRoot, 'after.txt');
      const sourceMode = (await stat(paths.destinationRoot)).mode & 0o7777;
      await writeFile(movedTo, bytes);
      const params: RuntimeSnapshotRevertParams = {
        chatId: 'cross-device-retry',
        expected: [
          { path, afterHash: RUNTIME_ABSENT_HASH, revertedHash: hashOf(bytes) },
          { path: movedTo, afterHash: hashOf(bytes), revertedHash: RUNTIME_ABSENT_HASH },
        ],
        operations: [{ type: 'move', path, movedTo, contentBase64: base64Of(bytes) }],
      };
      try {
        await chmod(paths.destinationRoot, 0o555);
        const error = await runtimeError(() => client.snapshot.revert(params));
        expect(error.message).toMatch(/permission denied|EACCES/i);
        await assertBytes(movedTo, bytes);
        expect(await client.snapshot.capture({ path })).toEqual({ exists: false });
      } finally {
        await chmod(paths.destinationRoot, sourceMode);
      }
      expect(await client.snapshot.revert(params)).toEqual({ revertedFiles: 1 });
      await assertBytes(path, bytes);
      expect(await client.snapshot.capture({ path: movedTo })).toEqual({ exists: false });
    }

    await assertRetry(typescript, fixtures.typescript);
    await assertRetry(rust, fixtures.rust);
  });

  it('preserves the exclusive-destination error for a cross-device revert collision', async () => {
    const fixtures = await crossDeviceFixturePair('cross-device-collision');
    if (!fixtures) return;
    const movedBytes = Buffer.from('captured source');
    const occupiedBytes = Buffer.from('existing destination');

    async function assertCollision(client: RuntimeClient, paths: CrossDevicePaths): Promise<void> {
      const path = join(paths.sourceRoot, 'occupied.txt');
      const movedTo = join(paths.destinationRoot, 'moved.txt');
      await writeFile(path, occupiedBytes);
      await writeFile(movedTo, movedBytes);
      const error = await runtimeError(() =>
        client.snapshot.revert({
          chatId: 'cross-device-collision',
          expected: [
            { path, afterHash: hashOf(occupiedBytes) },
            { path: movedTo, afterHash: hashOf(movedBytes) },
          ],
          operations: [{ type: 'move', path, movedTo, contentBase64: base64Of(movedBytes) }],
        })
      );
      expect(error).toBeInstanceOf(PathAccessError);
      expect(error.message).toBe(`"${path}" already exists. Choose a different destination.`);
      await assertBytes(path, occupiedBytes);
      await assertBytes(movedTo, movedBytes);
    }

    await assertCollision(typescript, fixtures.typescript);
    await assertCollision(rust, fixtures.rust);
  });

  it('treats an empty containment root as omitted during replay', async () => {
    const roots = await fixturePair('empty-containment');
    const bytes = Buffer.from('created');
    for (const [client, directory] of [
      [typescript, roots.typescript],
      [rust, roots.rust],
    ] as const) {
      const path = join(directory, 'created.txt');
      await writeFile(path, bytes);
      expect(
        await client.snapshot.revert({
          chatId: 'empty-containment',
          containmentRoot: '',
          expected: [{ path, afterHash: hashOf(bytes) }],
          operations: [{ type: 'create', path }],
        })
      ).toEqual({ revertedFiles: 1 });
      expect(await client.snapshot.capture({ path })).toEqual({ exists: false });
    }
  });

  it('restores the same bytes from unpadded and malformed base64 strings, including a missing parent', async () => {
    const roots = await fixturePair('base64');
    const afterBytes = Buffer.from('after\n');

    async function assertBase64Restore(client: RuntimeClient, root: string): Promise<void> {
      for (const [index, contentBase64] of [
        'Y2Fmw6k',
        'Y2Fmw6k=\n%',
        '%%%',
        '\u0154Q==',
        '\uff34Q==',
        '\ud83d\udc96TQ==',
        'T\u013dQ==',
      ].entries()) {
        const path = join(root, `base64-${index}.bin`);
        const decoded = Buffer.from(contentBase64, 'base64');
        await writeFile(path, afterBytes);
        expect(
          await client.snapshot.revert({
            chatId: 'snapshot-base64',
            expected: [
              {
                path,
                afterHash: hashOf(afterBytes),
                revertedHash: hashOf(decoded),
              },
            ],
            operations: [{ type: 'restore', path, contentBase64 }],
          })
        ).toEqual({ revertedFiles: 1 });
        await assertBytes(path, decoded);
      }

      const missingParentPath = join(root, 'missing', 'parent', 'restored.bin');
      const restoredBytes = Buffer.from('created parent\n');
      expect(
        await client.snapshot.revert({
          chatId: 'snapshot-missing-parent',
          expected: [
            {
              path: missingParentPath,
              afterHash: RUNTIME_ABSENT_HASH,
              revertedHash: hashOf(restoredBytes),
            },
          ],
          operations: [
            {
              type: 'restore',
              path: missingParentPath,
              contentBase64: base64Of(restoredBytes),
            },
          ],
        })
      ).toEqual({ revertedFiles: 1 });
      await assertBytes(missingParentPath, restoredBytes);
    }

    await assertBase64Restore(typescript, roots.typescript);
    await assertBase64Restore(rust, roots.rust);
  });

  it('leaves both paths unchanged when a revert move has no source or would overwrite one', async () => {
    const roots = await fixturePair('move-errors');
    const movedBytes = Buffer.from('moved bytes\n');
    const collisionBytes = Buffer.from('do not overwrite\n');

    async function assertMoveErrors(client: RuntimeClient, root: string): Promise<void> {
      const missingSource = join(root, 'missing-source.txt');
      const missingDestination = join(root, 'missing-destination.txt');
      const missingError = await runtimeError(() =>
        client.snapshot.revert({
          chatId: 'snapshot-missing-move',
          expected: [
            {
              path: missingSource,
              afterHash: RUNTIME_ABSENT_HASH,
              revertedHash: hashOf(movedBytes),
            },
            {
              path: missingDestination,
              afterHash: RUNTIME_ABSENT_HASH,
              revertedHash: RUNTIME_ABSENT_HASH,
            },
          ],
          operations: [
            {
              type: 'move',
              path: missingSource,
              movedTo: missingDestination,
              contentBase64: base64Of(movedBytes),
            },
          ],
        })
      );
      expect(missingError).toBeInstanceOf(PathAccessError);
      await expect(Bun.file(missingSource).exists()).resolves.toBe(false);
      await expect(Bun.file(missingDestination).exists()).resolves.toBe(false);

      const collisionPath = join(root, 'collision.txt');
      const destinationPath = join(root, 'moved.txt');
      await Promise.all([
        writeFile(collisionPath, collisionBytes),
        writeFile(destinationPath, movedBytes),
      ]);
      const collisionError = await runtimeError(() =>
        client.snapshot.revert({
          chatId: 'snapshot-move-collision',
          expected: [
            { path: collisionPath, afterHash: hashOf(collisionBytes) },
            { path: destinationPath, afterHash: hashOf(movedBytes) },
          ],
          operations: [
            {
              type: 'move',
              path: collisionPath,
              movedTo: destinationPath,
              contentBase64: base64Of(movedBytes),
            },
          ],
        })
      );
      expect(collisionError).toBeInstanceOf(PathAccessError);
      await assertBytes(collisionPath, collisionBytes);
      await assertBytes(destinationPath, movedBytes);
    }

    await assertMoveErrors(typescript, roots.typescript);
    await assertMoveErrors(rust, roots.rust);
  });

  it('replays repeated paths to their earliest bytes and refuses a mixed revert state', async () => {
    const roots = await fixturePair('replay');
    const before = Buffer.from('first \u{1F34A}\n', 'utf8');
    const middle = Buffer.from('second \u{1F352}\n', 'utf8');
    const after = Buffer.from('third \u{1FAD0}\n', 'utf8');

    async function assertRepeatedReplay(client: RuntimeClient, root: string): Promise<void> {
      const path = join(root, 'repeated.txt');
      await writeFile(path, after);
      const params = {
        chatId: 'snapshot-replay',
        expected: [{ path, afterHash: hashOf(after), revertedHash: hashOf(before) }],
        operations: [
          { type: 'restore' as const, path, contentBase64: base64Of(middle) },
          { type: 'restore' as const, path, contentBase64: base64Of(before) },
        ],
      };
      expect(await client.snapshot.revert(params)).toEqual({ revertedFiles: 1 });
      await assertBytes(path, before);
      expect(await client.snapshot.revert(params)).toEqual({ revertedFiles: 1 });
    }

    await assertRepeatedReplay(typescript, roots.typescript);
    await assertRepeatedReplay(rust, roots.rust);

    async function assertMixedConflict(client: RuntimeClient, root: string): Promise<void> {
      const restoredPath = join(root, 'already-reverted.txt');
      const pendingPath = join(root, 'still-pending.txt');
      const beforeBytes = Buffer.from('before\n');
      const afterBytes = Buffer.from('after\n');
      await Promise.all([writeFile(restoredPath, beforeBytes), writeFile(pendingPath, afterBytes)]);

      const error = await runtimeError(() =>
        client.snapshot.revert({
          chatId: 'snapshot-mixed-conflict',
          expected: [
            {
              path: restoredPath,
              afterHash: hashOf(afterBytes),
              revertedHash: hashOf(beforeBytes),
            },
            {
              path: pendingPath,
              afterHash: hashOf(afterBytes),
              revertedHash: hashOf(beforeBytes),
            },
          ],
          operations: [
            { type: 'restore', path: pendingPath, contentBase64: base64Of(beforeBytes) },
            { type: 'restore', path: restoredPath, contentBase64: base64Of(beforeBytes) },
          ],
        })
      );
      expect(error).toBeInstanceOf(RuntimeSnapshotConflictError);
      expect((error as RuntimeSnapshotConflictError).resolvedPath).toBe(restoredPath);
      await assertBytes(restoredPath, beforeBytes);
      await assertBytes(pendingPath, afterBytes);
    }

    await assertMixedConflict(typescript, roots.typescript);
    await assertMixedConflict(rust, roots.rust);
  });

  it('rejects symlink or junction escapes before a revert can modify outside files', async () => {
    const directory = await mkdtemp(join(root, 'containment-'));
    const outside = await mkdtemp(join(root, 'outside-'));
    const escapeLink = join(
      directory,
      process.platform === 'win32' ? 'outside-junction' : 'outside-link'
    );
    await symlink(outside, escapeLink, process.platform === 'win32' ? 'junction' : 'dir');
    const escapedPath = join(escapeLink, 'planted.txt');
    const params = {
      chatId: 'snapshot-containment',
      containmentRoot: directory,
      expected: [{ path: escapedPath, afterHash: RUNTIME_ABSENT_HASH }],
      operations: [{ type: 'create' as const, path: escapedPath }],
    };

    const expected = await runtimeError(() => typescript.snapshot.revert(params));
    expect(expected).toBeInstanceOf(PathAccessError);
    const actual = await runtimeError(() => rust.snapshot.revert(params));
    expect(actual).toEqual(expected);
    await expect(Bun.file(escapedPath).exists()).resolves.toBe(false);
  });
});
