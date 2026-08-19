/**
 * Cancellation reaches every runtime method, and stops at the same place in all
 * of them: before the mutation, never during it. The tests below are in two
 * halves for that reason — what a cancelled call refuses, and what it must
 * still finish once bytes have started moving.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_APP_SETTINGS, libraryLocationsFor } from '@mangostudio/shared/app-settings';
import { createPathEnv } from '@mangostudio/shared/runtime-env';
import { clearFileFreshness } from '../../../src';
import { withPathLocks } from '../../../src/services/file-freshness';
import { runtimeFsService } from '../../../src/services/fs';
import { createLibraryService } from '../../../src/services/library';
import { createProbingService } from '../../../src/services/probing/service';
import {
  captureFileSnapshot,
  hashFileAtPath,
  revertRuntimeSnapshots,
} from '../../../src/services/snapshot';
import { browseWorkspace } from '../../../src/services/workspace';

let tempDir: string;

beforeEach(() => {
  clearFileFreshness();
  tempDir = mkdtempSync(join(tmpdir(), 'runtime-cancel-test-'));
});

afterEach(() => {
  clearFileFreshness();
  rmSync(tempDir, { recursive: true, force: true });
});

function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

/** Seeds a file and records it as read, so a mutation's freshness gate passes. */
async function seedReadFile(name: string, content = 'original\n'): Promise<string> {
  const path = join(tempDir, name);
  await Bun.write(path, content);
  await runtimeFsService.readFile({ chatId: 'chat-1', inputPath: name, resolvedPath: path });
  return path;
}

describe('a cancelled runtime call refuses before it mutates', () => {
  it('refuses every filesystem mutation and leaves the file as it was', async () => {
    const path = await seedReadFile('target.txt');
    const other = join(tempDir, 'other.txt');
    const signal = abortedSignal();

    // Thunks, not promises: building them all up front would leave every
    // rejection unhandled until the loop below reached it.
    const refusals: Array<[string, () => Promise<unknown>]> = [
      [
        'writeFile',
        () =>
          runtimeFsService.writeFile(
            {
              chatId: 'chat-1',
              inputPath: 'target.txt',
              resolvedPath: path,
              content: 'replaced\n',
              captureSnapshot: false,
            },
            signal
          ),
      ],
      [
        'createFile',
        () =>
          runtimeFsService.createFile(
            {
              chatId: 'chat-1',
              inputPath: 'other.txt',
              resolvedPath: other,
              content: 'new\n',
              captureSnapshot: false,
            },
            signal
          ),
      ],
      [
        'editFile',
        () =>
          runtimeFsService.editFile(
            {
              chatId: 'chat-1',
              inputPath: 'target.txt',
              resolvedPath: path,
              oldString: 'original',
              newString: 'edited',
              captureSnapshot: false,
            },
            signal
          ),
      ],
      [
        'replaceRange',
        () =>
          runtimeFsService.replaceRange(
            {
              chatId: 'chat-1',
              inputPath: 'target.txt',
              resolvedPath: path,
              startLine: 1,
              endLine: 1,
              content: 'ranged\n',
              captureSnapshot: false,
            },
            signal
          ),
      ],
      [
        'deleteFile',
        () =>
          runtimeFsService.deleteFile(
            {
              chatId: 'chat-1',
              inputPath: 'target.txt',
              resolvedPath: path,
              captureSnapshot: false,
            },
            signal
          ),
      ],
      [
        'moveFile',
        () =>
          runtimeFsService.moveFile(
            {
              chatId: 'chat-1',
              inputFrom: 'target.txt',
              inputTo: 'other.txt',
              resolvedFrom: path,
              resolvedTo: other,
              captureSnapshot: false,
            },
            signal
          ),
      ],
      [
        'applyPatch',
        () =>
          runtimeFsService.applyPatch(
            {
              chatId: 'chat-1',
              captureSnapshot: false,
              operations: [
                { type: 'add', inputPath: 'other.txt', resolvedPath: other, content: 'added\n' },
              ],
            },
            signal
          ),
      ],
    ];

    for (const [name, call] of refusals) {
      // Named in the assertion so a method that stops refusing is identifiable
      // from the failure alone.
      await expect(call().then(() => name)).rejects.toMatchObject({ name: 'AbortError' });
    }

    expect(await Bun.file(path).text()).toBe('original\n');
    expect(await Bun.file(other).exists()).toBe(false);
  });

  it('refuses the read-only methods too', async () => {
    const path = await seedReadFile('readable.txt');
    const signal = abortedSignal();

    await expect(
      runtimeFsService.readFile(
        { chatId: 'chat-1', inputPath: 'readable.txt', resolvedPath: path },
        signal
      )
    ).rejects.toMatchObject({ name: 'AbortError' });

    await expect(
      runtimeFsService.listDirectory({ inputPath: '.', resolvedPath: tempDir }, signal)
    ).rejects.toMatchObject({ name: 'AbortError' });

    await expect(
      runtimeFsService.glob(
        {
          pattern: '*',
          cwd: tempDir,
          maxResults: 10,
          includeDotfiles: false,
          absolute: false,
        },
        signal
      )
    ).rejects.toMatchObject({ name: 'AbortError' });

    await expect(
      runtimeFsService.glob(
        {
          pattern: 'no-such-*',
          cwd: tempDir,
          maxResults: 10,
          includeDotfiles: false,
          absolute: false,
        },
        signal
      )
    ).rejects.toMatchObject({ name: 'AbortError' });

    await expect(
      runtimeFsService.grep(
        {
          pattern: 'original',
          inputPath: '.',
          resolvedPath: tempDir,
          caseInsensitive: false,
          maxResults: 10,
          maxMatchesPerFile: 10,
          maxFileSizeBytes: 1_000_000,
          includeDotfiles: false,
        },
        signal
      )
    ).rejects.toMatchObject({ name: 'AbortError' });

    await expect(
      runtimeFsService.grep(
        {
          pattern: 'original',
          inputPath: 'readable.txt',
          resolvedPath: path,
          caseInsensitive: false,
          maxResults: 10,
          maxMatchesPerFile: 10,
          maxFileSizeBytes: 1_000_000,
          includeDotfiles: false,
        },
        signal
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('refuses the snapshot methods', async () => {
    const path = await seedReadFile('snapshot.txt');
    const signal = abortedSignal();

    await expect(captureFileSnapshot(path, signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(hashFileAtPath(path, signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      revertRuntimeSnapshots(
        {
          chatId: 'chat-1',
          expected: [{ path, afterHash: 'deadbeef' }],
          operations: [{ type: 'create', path }],
        },
        signal
      )
    ).rejects.toMatchObject({ name: 'AbortError' });

    // The revert refused before touching anything, so the file it would have
    // removed is still there.
    expect(await Bun.file(path).exists()).toBe(true);
  });

  it('refuses a hash whose read finished after the caller cancelled', async () => {
    const path = await seedReadFile('hash-inflight.txt');
    const controller = new AbortController();
    const pending = hashFileAtPath(path, controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('refuses an already-reverted retry cancelled while hashing the last file', async () => {
    const path = await seedReadFile('already-reverted.txt', 'reverted\n');
    const revertedHash = await hashFileAtPath(path);
    if (revertedHash === null) throw new Error('expected a hash for the seeded file');

    const controller = new AbortController();
    const queued = revertRuntimeSnapshots(
      {
        chatId: 'chat-1',
        expected: [{ path, afterHash: 'deadbeef', revertedHash }],
        operations: [{ type: 'create', path }],
      },
      controller.signal
    );
    // Abort after the call has started so the entry check cannot be the one
    // that refuses. The idempotent branch used to return success anyway.
    controller.abort();

    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(await Bun.file(path).text()).toBe('reverted\n');
  });

  it('refuses directory walks and host probes before they start', async () => {
    const signal = abortedSignal();
    let scanned = false;

    await expect(browseWorkspace({ path: tempDir }, signal)).rejects.toMatchObject({
      name: 'AbortError',
    });

    const probing = createProbingService({
      runtimeDefinitions: [],
      createScanDeps: () => {
        scanned = true;
        throw new Error('probe must not run after cancel');
      },
    });
    await expect(probing.probeRuntimes({}, signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(probing.probeVersionManagers({}, signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(
      probing.probeAgentClis({ self: { version: '0.0.0' } }, signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(scanned).toBe(false);

    const library = createLibraryService({
      createPathEnv: () => createPathEnv({ platform: process.platform, homeDir: tempDir, env: {} }),
      describeLocations: () => [],
      now: () => 0,
    });
    await expect(
      library.scan({ locationSettings: libraryLocationsFor(DEFAULT_APP_SETTINGS) }, signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      library.readTree({ locationId: 'mango-skills', path: tempDir }, signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('refuses a cancel that arrives while the call waits for the path lock', async () => {
    // The gap the entry check cannot cover: a mutation queued behind another
    // one on the same path may wait arbitrarily long before it reaches its own
    // write, and the hub can give up in the meantime.
    const path = await seedReadFile('contended.txt');
    const controller = new AbortController();

    let releaseHold: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      releaseHold = () => resolve();
    });
    const holder = withPathLocks([path], () => held);
    await Promise.resolve();

    const queued = runtimeFsService.writeFile(
      {
        chatId: 'chat-1',
        inputPath: 'contended.txt',
        resolvedPath: path,
        content: 'replaced\n',
        captureSnapshot: false,
      },
      controller.signal
    );
    // Cancelled after the entry check passed and while the lock is held
    // elsewhere, so only the check inside the lock can catch it.
    controller.abort();
    releaseHold();
    await holder;

    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(await Bun.file(path).text()).toBe('original\n');
  });
});

describe('a cancelled runtime call never abandons a mutation in progress', () => {
  it('finishes a write that had already started when the cancel arrived', async () => {
    // Large enough that the exclusive open's destination entry — created by
    // `open(path, 'wx')` before any bytes land — is observable for several
    // event-loop turns; the abort is fired the moment it appears, which is
    // unambiguously after the last cancellation point. There is no temporary
    // file to watch for here: an exclusive create writes the destination
    // directly, precisely because it has nothing to replace atomically.
    const content = 'x'.repeat(8 * 1024 * 1024);
    const directory = join(tempDir, 'nested');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'big.txt');
    const controller = new AbortController();

    let sawPartialWrite = false;
    const watch = setInterval(() => {
      const started = readdirSync(directory).includes('big.txt');
      if (!started) return;
      sawPartialWrite = true;
      controller.abort();
    }, 0);

    let result: Awaited<ReturnType<typeof runtimeFsService.createFile>>;
    try {
      result = await runtimeFsService.createFile(
        {
          chatId: 'chat-1',
          inputPath: 'nested/big.txt',
          resolvedPath: path,
          content,
          captureSnapshot: false,
        },
        controller.signal
      );
    } finally {
      clearInterval(watch);
    }

    expect(sawPartialWrite).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    // The write is reported as done and the file holds all of it — never the
    // temporary, never a short file, never a rejection with bytes on disk.
    expect(result.result.bytesWritten).toBe(content.length);
    expect(Bun.file(path).size).toBe(content.length);
    expect(readdirSync(directory)).toEqual(['big.txt']);
  }, 30_000);

  it('finishes every operation of a revert cancelled after the first one landed', async () => {
    const first = join(tempDir, 'first.txt');
    const second = join(tempDir, 'second.txt');
    await Bun.write(first, 'changed\n');
    await Bun.write(second, 'changed\n');
    const changedHash = await hashFileAtPath(first);
    if (changedHash === null) throw new Error('fixture file is missing');

    const controller = new AbortController();
    const restoredFirst = 'restored\n';
    // Large enough that the second restore is still in flight after the first
    // file is on disk. Two tiny writes finish in one microtask chain, so a
    // timer watching the first file never sees a mid-revert moment.
    const restoredSecond = 'r'.repeat(1024 * 1024);

    const revert = revertRuntimeSnapshots(
      {
        chatId: 'chat-1',
        expected: [
          { path: first, afterHash: changedHash },
          { path: second, afterHash: changedHash },
        ],
        operations: [
          {
            type: 'restore',
            path: first,
            contentBase64: Buffer.from(restoredFirst).toString('base64'),
          },
          {
            type: 'restore',
            path: second,
            contentBase64: Buffer.from(restoredSecond).toString('base64'),
          },
        ],
      },
      controller.signal
    );

    const deadline = Date.now() + 5_000;
    while ((await Bun.file(first).text()) !== restoredFirst) {
      if (Date.now() >= deadline) throw new Error('first file was never restored');
      await Bun.sleep(0);
    }
    controller.abort();

    const result = await revert;
    expect(result.revertedFiles).toBe(2);
    expect(controller.signal.aborted).toBe(true);
    expect(await Bun.file(first).text()).toBe(restoredFirst);
    expect(await Bun.file(second).text()).toBe(restoredSecond);
  }, 15_000);
});
