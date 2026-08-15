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
import { clearFileFreshness } from '../../../src';
import { withPathLocks } from '../../../src/services/file-freshness';
import { runtimeFsService } from '../../../src/services/fs';
import {
  captureFileSnapshot,
  hashFileAtPath,
  revertRuntimeSnapshots,
} from '../../../src/services/snapshot';

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

  it('refuses a cancel that arrives while the call waits for the path lock', async () => {
    // The gap the entry check cannot cover: a mutation queued behind another
    // one on the same path may wait arbitrarily long before it reaches its own
    // write, and the hub can give up in the meantime.
    const path = await seedReadFile('contended.txt');
    const controller = new AbortController();

    let releaseHold = () => undefined as void;
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
    // Large enough that the atomic write's temporary file is observable for
    // several event-loop turns; the abort is fired the moment it appears, which
    // is unambiguously after the last cancellation point.
    const content = 'x'.repeat(8 * 1024 * 1024);
    const directory = join(tempDir, 'nested');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'big.txt');
    const controller = new AbortController();

    let sawPartialWrite = false;
    const watch = setInterval(() => {
      const temporary = readdirSync(directory).some(
        (entry) => entry.startsWith('.') && entry.endsWith('.tmp')
      );
      if (!temporary) return;
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
    const restored = Buffer.from('restored\n').toString('base64');
    // Aborting while the operations run: a revert that stopped halfway would
    // leave one file restored and one not, which `alreadyReverted` reads as a
    // conflict on the retry rather than as work to resume.
    const watch = setInterval(async () => {
      if ((await Bun.file(first).text()) === 'restored\n') controller.abort();
    }, 0);

    try {
      const result = await revertRuntimeSnapshots(
        {
          chatId: 'chat-1',
          expected: [
            { path: first, afterHash: changedHash },
            { path: second, afterHash: changedHash },
          ],
          operations: [
            { type: 'restore', path: first, contentBase64: restored },
            { type: 'restore', path: second, contentBase64: restored },
          ],
        },
        controller.signal
      );
      expect(result.revertedFiles).toBe(2);
    } finally {
      clearInterval(watch);
    }

    expect(controller.signal.aborted).toBe(true);
    expect(await Bun.file(first).text()).toBe('restored\n');
    expect(await Bun.file(second).text()).toBe('restored\n');
  });
});
