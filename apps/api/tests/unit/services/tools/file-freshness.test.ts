import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertFresh,
  clearFileFreshness,
  FileNotReadError,
  forgetFile,
  PartialReadError,
  recordFileRead,
  rekeyFile,
  StaleFileError,
  withPathLocks,
} from '../../../../src/services/tools/file-freshness';

let tempDir: string;

beforeEach(() => {
  clearFileFreshness();
  tempDir = mkdtempSync(join(tmpdir(), 'file-freshness-test-'));
});

afterEach(() => {
  clearFileFreshness();
  rmSync(tempDir, { recursive: true, force: true });
});

function mtimeOf(filePath: string): number {
  return statSync(filePath).mtimeMs;
}

describe('file freshness ledger', () => {
  it('records and verifies the observed content hash', async () => {
    const filePath = join(tempDir, 'file.txt');
    await Bun.write(filePath, 'hello');

    const sha256 = recordFileRead('chat-1', filePath, 'hello', mtimeOf(filePath));

    expect(sha256).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    await expect(assertFresh('chat-1', filePath)).resolves.toBeUndefined();
  });

  it('requires every chat to establish its own snapshot', async () => {
    const filePath = join(tempDir, 'file.txt');
    await Bun.write(filePath, 'hello');
    recordFileRead('chat-a', filePath, 'hello', mtimeOf(filePath));

    await expect(assertFresh('chat-b', filePath)).rejects.toBeInstanceOf(FileNotReadError);
  });

  it('rejects content changed after the recorded read', async () => {
    const filePath = join(tempDir, 'file.txt');
    await Bun.write(filePath, 'before');
    recordFileRead('chat-1', filePath, 'before', mtimeOf(filePath));
    await Bun.write(filePath, 'after-content');

    await expect(assertFresh('chat-1', filePath)).rejects.toBeInstanceOf(StaleFileError);
  });

  it('rejects a write when the recorded read only observed part of the file', async () => {
    const filePath = join(tempDir, 'file.txt');
    await Bun.write(filePath, 'a\nb\nc');
    recordFileRead('chat-1', filePath, 'a\nb\nc', mtimeOf(filePath), {
      startLine: 1,
      endLine: 2,
      totalLines: 3,
    });

    await expect(assertFresh('chat-1', filePath)).rejects.toBeInstanceOf(PartialReadError);
  });

  it('accumulates sequential windows until they cover the file', async () => {
    const filePath = join(tempDir, 'file.txt');
    await Bun.write(filePath, 'a\nb\nc');
    const range = { startLine: 1, endLine: 2, totalLines: 3 };
    recordFileRead('chat-1', filePath, 'a\nb\nc', mtimeOf(filePath), range);
    recordFileRead('chat-1', filePath, 'a\nb\nc', mtimeOf(filePath), {
      ...range,
      startLine: 3,
      endLine: 3,
    });

    await expect(assertFresh('chat-1', filePath)).resolves.toBeUndefined();
  });

  it('drops accumulated coverage when the file changed between windows', async () => {
    const filePath = join(tempDir, 'file.txt');
    await Bun.write(filePath, 'a\nb\nc');
    recordFileRead('chat-1', filePath, 'a\nb\nc', mtimeOf(filePath), {
      startLine: 1,
      endLine: 2,
      totalLines: 3,
    });

    // The second window observed different bytes, so the first no longer
    // describes any part of the file the model is about to overwrite.
    await Bun.write(filePath, 'a\nb\nd');
    recordFileRead('chat-1', filePath, 'a\nb\nd', mtimeOf(filePath), {
      startLine: 3,
      endLine: 3,
      totalLines: 3,
    });

    await expect(assertFresh('chat-1', filePath)).rejects.toBeInstanceOf(PartialReadError);
  });

  it('hashes rather than trusting metadata when the read observed no snapshot', async () => {
    const filePath = join(tempDir, 'file.txt');
    await Bun.write(filePath, 'new');

    // A same-size rewrite during read_file's own read: the bytes are stale but
    // the path's size and mtime are not, so only NaN keeps the fast path shut.
    recordFileRead('chat-1', filePath, 'old', Number.NaN);

    await expect(assertFresh('chat-1', filePath)).rejects.toBeInstanceOf(StaleFileError);
  });

  it('accepts metadata-only changes and refreshes the cached metadata', async () => {
    const filePath = join(tempDir, 'file.txt');
    await Bun.write(filePath, 'unchanged');
    recordFileRead('chat-1', filePath, 'unchanged', mtimeOf(filePath));
    const changedTime = new Date(Date.now() + 10_000);
    utimesSync(filePath, changedTime, changedTime);

    await expect(assertFresh('chat-1', filePath)).resolves.toBeUndefined();
    await expect(assertFresh('chat-1', filePath)).resolves.toBeUndefined();
  });

  it('uses the size and mtime fast path for an unchanged file', async () => {
    if (process.platform === 'win32') return;

    const filePath = join(tempDir, 'file.txt');
    await Bun.write(filePath, 'unchanged');
    recordFileRead('chat-1', filePath, 'unchanged', mtimeOf(filePath));
    chmodSync(filePath, 0);
    try {
      await expect(assertFresh('chat-1', filePath)).resolves.toBeUndefined();
    } finally {
      chmodSync(filePath, 0o600);
    }
  });

  it('forgets snapshots explicitly', async () => {
    const filePath = join(tempDir, 'file.txt');
    await Bun.write(filePath, 'hello');
    recordFileRead('chat-1', filePath, 'hello', mtimeOf(filePath));

    forgetFile('chat-1', filePath);

    await expect(assertFresh('chat-1', filePath)).rejects.toBeInstanceOf(FileNotReadError);
  });

  it('rekeys a snapshot after a file move', async () => {
    const from = join(tempDir, 'from.txt');
    const to = join(tempDir, 'to.txt');
    await Bun.write(from, 'hello');
    recordFileRead('chat-1', from, 'hello', mtimeOf(from));
    renameSync(from, to);

    rekeyFile('chat-1', from, to);

    await expect(assertFresh('chat-1', to)).resolves.toBeUndefined();
    await expect(assertFresh('chat-1', from)).rejects.toBeInstanceOf(FileNotReadError);
  });

  it('clears every snapshot for test and restart isolation', async () => {
    const filePath = join(tempDir, 'file.txt');
    await Bun.write(filePath, 'hello');
    recordFileRead('chat-1', filePath, 'hello', mtimeOf(filePath));

    clearFileFreshness();

    await expect(assertFresh('chat-1', filePath)).rejects.toBeInstanceOf(FileNotReadError);
  });

  it('evicts the least recently used entry when a chat exceeds its bound', async () => {
    const paths = Array.from({ length: 257 }, (_, index) => join(tempDir, `${index}.txt`));
    await Promise.all(paths.map((path, index) => Bun.write(path, String(index))));
    for (let index = 0; index < 256; index++) {
      recordFileRead('chat-1', paths[index], String(index), mtimeOf(paths[index]));
    }

    // Touch the first entry, making the second entry the oldest.
    await assertFresh('chat-1', paths[0]);
    recordFileRead('chat-1', paths[256], '256', mtimeOf(paths[256]));

    await expect(assertFresh('chat-1', paths[0])).resolves.toBeUndefined();
    await expect(assertFresh('chat-1', paths[1])).rejects.toBeInstanceOf(FileNotReadError);
  });
});

describe('withPathLocks', () => {
  it('serializes concurrent work on the same path in arrival order', async () => {
    const events: string[] = [];
    let releaseFirst: () => void = () => undefined;
    let markFirstStarted: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withPathLocks(['/same'], async () => {
      events.push('first:start');
      markFirstStarted();
      await firstGate;
      events.push('first:end');
    });
    await firstStarted;
    const second = withPathLocks(['/same'], () => {
      events.push('second:start');
      events.push('second:end');
      return Promise.resolve();
    });

    releaseFirst();
    await Promise.all([first, second]);

    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('releases locks when the protected operation fails', async () => {
    await expect(
      withPathLocks(['/same'], () => Promise.reject(new Error('failed')))
    ).rejects.toThrow('failed');

    await expect(withPathLocks(['/same'], () => Promise.resolve('recovered'))).resolves.toBe(
      'recovered'
    );
  });
});
