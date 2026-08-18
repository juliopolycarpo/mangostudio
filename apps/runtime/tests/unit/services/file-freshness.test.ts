import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertFresh,
  assertFreshContent,
  assertLineNumbersCurrent,
  clearFileFreshness,
  FileNotReadError,
  forgetFile,
  type ObservedLineRange,
  PartialReadError,
  readFreshFile,
  recordFileEdit,
  recordFileRead,
  rekeyFile,
  StaleFileError,
  StaleLineNumbersError,
  UnobservedLineNumbersError,
  withPathLocks,
} from '../../../src/services/file-freshness';

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

function windowed(
  startLine: number,
  endLine: number,
  totalLines: number
): { readonly kind: 'window'; readonly range: ObservedLineRange } {
  return { kind: 'window', range: { startLine, endLine, totalLines } };
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

  it('verifies the exact bytes supplied by a read-modify-write caller', async () => {
    const filePath = join(tempDir, 'file.txt');
    await Bun.write(filePath, 'before');
    recordFileRead('chat-1', filePath, 'before', mtimeOf(filePath));

    expect(() => assertFreshContent('chat-1', filePath, 'before')).not.toThrow();
    expect(() => assertFreshContent('chat-1', filePath, 'after!')).toThrow(StaleFileError);
  });

  it('hashes the snapshot returned to a read-modify-write caller', async () => {
    const filePath = join(tempDir, 'file.txt');
    await Bun.write(filePath, 'before');
    recordFileRead('chat-1', filePath, 'before', mtimeOf(filePath));
    await Bun.write(filePath, 'after!');

    await expect(readFreshFile('chat-1', filePath)).rejects.toBeInstanceOf(StaleFileError);
  });

  it('rejects a write when the recorded read only observed part of the file', async () => {
    const filePath = join(tempDir, 'file.txt');
    await Bun.write(filePath, 'a\nb\nc');
    recordFileRead('chat-1', filePath, 'a\nb\nc', mtimeOf(filePath), windowed(1, 2, 3));

    await expect(assertFresh('chat-1', filePath)).rejects.toBeInstanceOf(PartialReadError);
  });

  it('accumulates sequential windows until they cover the file', async () => {
    const filePath = join(tempDir, 'file.txt');
    await Bun.write(filePath, 'a\nb\nc');
    recordFileRead('chat-1', filePath, 'a\nb\nc', mtimeOf(filePath), windowed(1, 2, 3));
    recordFileRead('chat-1', filePath, 'a\nb\nc', mtimeOf(filePath), windowed(3, 3, 3));

    await expect(assertFresh('chat-1', filePath)).resolves.toBeUndefined();
  });

  it('drops accumulated coverage when the file changed between windows', async () => {
    const filePath = join(tempDir, 'file.txt');
    await Bun.write(filePath, 'a\nb\nc');
    recordFileRead('chat-1', filePath, 'a\nb\nc', mtimeOf(filePath), windowed(1, 2, 3));

    // The second window observed different bytes, so the first no longer
    // describes any part of the file the model is about to overwrite.
    await Bun.write(filePath, 'a\nb\nd');
    recordFileRead('chat-1', filePath, 'a\nb\nd', mtimeOf(filePath), windowed(3, 3, 3));

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

  it('leaves line numbers addressable until an edit shifts them', async () => {
    const filePath = join(tempDir, 'file.txt');
    await Bun.write(filePath, 'a\nb\nc\n');
    recordFileRead('chat-1', filePath, 'a\nb\nc\n', mtimeOf(filePath));

    expect(() => assertLineNumbersCurrent('chat-1', filePath, 3)).not.toThrow();
    // A same-height splice moves nothing, so every number still holds.
    recordFileEdit('chat-1', filePath, 'A\nb\nc\n', mtimeOf(filePath), Number.MAX_SAFE_INTEGER);
    expect(() => assertLineNumbersCurrent('chat-1', filePath, 3)).not.toThrow();
  });

  it('narrows line addressability to the prefix an edit left in place', async () => {
    const filePath = join(tempDir, 'file.txt');
    await Bun.write(filePath, 'a\nb\nc\n');
    recordFileRead('chat-1', filePath, 'a\nb\nc\n', mtimeOf(filePath));

    recordFileEdit('chat-1', filePath, 'a\nb1\nb2\nc\n', mtimeOf(filePath), 1);

    expect(() => assertLineNumbersCurrent('chat-1', filePath, 1)).not.toThrow();
    expect(() => assertLineNumbersCurrent('chat-1', filePath, 2)).toThrow(StaleLineNumbersError);
  });

  it('keeps the narrowest frontier across edits and restores it on a full read', async () => {
    const filePath = join(tempDir, 'file.txt');
    await Bun.write(filePath, 'a\nb\nc\n');
    recordFileRead('chat-1', filePath, 'a\nb\nc\n', mtimeOf(filePath));

    recordFileEdit('chat-1', filePath, 'a\nb1\nb2\nc\n', mtimeOf(filePath), 1);
    // A later edit that shifts nothing must not widen the frontier back.
    recordFileEdit(
      'chat-1',
      filePath,
      'a\nb1\nb2\nC\n',
      mtimeOf(filePath),
      Number.MAX_SAFE_INTEGER
    );
    expect(() => assertLineNumbersCurrent('chat-1', filePath, 2)).toThrow(StaleLineNumbersError);

    recordFileRead('chat-1', filePath, 'a\nb1\nb2\nC\n', mtimeOf(filePath));
    expect(() => assertLineNumbersCurrent('chat-1', filePath, 4)).not.toThrow();
  });

  it('does not treat a byte view as assigning line numbers', async () => {
    const filePath = join(tempDir, 'file.txt');
    await Bun.write(filePath, 'a\nb\nc\n');
    recordFileRead('chat-1', filePath, 'a\nb\nc\n', mtimeOf(filePath), { kind: 'byteView' });

    await expect(assertFresh('chat-1', filePath)).resolves.toBeUndefined();
    expect(() => assertLineNumbersCurrent('chat-1', filePath, 1)).toThrow(
      UnobservedLineNumbersError
    );
  });

  it('re-establishes line numbers when a text read follows a byte view', async () => {
    const filePath = join(tempDir, 'file.txt');
    await Bun.write(filePath, 'a\nb\nc\n');
    recordFileRead('chat-1', filePath, 'a\nb\nc\n', mtimeOf(filePath), { kind: 'byteView' });
    recordFileRead('chat-1', filePath, 'a\nb\nc\n', mtimeOf(filePath));

    expect(() => assertLineNumbersCurrent('chat-1', filePath, 3)).not.toThrow();
  });

  it('does not let a byte-view state floor a later edit frontier', async () => {
    const filePath = join(tempDir, 'file.txt');
    await Bun.write(filePath, 'a\nb\nc\n');
    recordFileRead('chat-1', filePath, 'a\nb\nc\n', mtimeOf(filePath), { kind: 'byteView' });
    // If unobserved were stored as 0, Math.min would keep the frontier at 0
    // even after a same-height splice claimed every number still held.
    recordFileEdit('chat-1', filePath, 'A\nb\nc\n', mtimeOf(filePath), Number.MAX_SAFE_INTEGER);

    expect(() => assertLineNumbersCurrent('chat-1', filePath, 3)).not.toThrow();
  });

  it('keeps an empty text window as numbered, not unobserved', async () => {
    const filePath = join(tempDir, 'empty.txt');
    await Bun.write(filePath, '');
    recordFileRead('chat-1', filePath, '', mtimeOf(filePath), windowed(1, 0, 0));

    await expect(assertFresh('chat-1', filePath)).resolves.toBeUndefined();
    expect(() => assertLineNumbersCurrent('chat-1', filePath, 1)).not.toThrow();
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
