import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LOG_LINE_MAX_CHARS,
  LOG_TAIL_BYTES_PER_LINE,
  type LogTailSource,
  latestHubLogFile,
  readLogTail,
  tailLines,
} from '../../../src/cli/log-tail';

describe('tailLines', () => {
  it('returns the last lines and says whether more exist', () => {
    expect(tailLines('a\nb\nc\n', 2)).toEqual({ lines: ['b', 'c'], truncated: true });
    expect(tailLines('a\r\nb', 5)).toEqual({ lines: ['a', 'b'], truncated: false });
    expect(tailLines('', 5)).toEqual({ lines: [], truncated: false });
    expect(tailLines('\uFEFFfirst\r\n', 5)).toEqual({ lines: ['first'], truncated: false });
  });

  it('cuts a line longer than the wire contract allows instead of failing the whole tail', () => {
    const long = 'x'.repeat(LOG_LINE_MAX_CHARS + 500);
    const { lines } = tailLines(`${long}\nshort\n`, 5);
    expect(lines[0]?.length).toBe(LOG_LINE_MAX_CHARS);
    expect(lines[0]?.endsWith('…')).toBe(true);
    expect(lines[1]).toBe('short');
  });
});

/**
 * A log file that records the byte offset it was asked to read from. The point
 * of the assertions below is what was *not* read: a source that hands back the
 * right lines while reading the whole file passes on content alone.
 */
class RecordingLogFile implements LogTailSource {
  readonly offsets: number[] = [];
  readonly #content: string;

  constructor(content: string) {
    this.#content = content;
  }

  size(_path: string): Promise<number | null> {
    return Promise.resolve(Buffer.byteLength(this.#content));
  }

  readFrom(_path: string, offset: number): Promise<string> {
    this.offsets.push(offset);
    return Promise.resolve(this.#content.slice(offset));
  }
}

class MissingLogFile implements LogTailSource {
  size(_path: string): Promise<number | null> {
    return Promise.resolve(null);
  }

  readFrom(_path: string, _offset: number): Promise<string> {
    return Promise.reject(new Error('A missing file must never be read.'));
  }
}

describe('readLogTail', () => {
  it('reads only a bounded suffix of a log far larger than the request', async () => {
    // One line per 10 bytes, so 5_000 lines is ~50 KB — small enough to build
    // here and large enough that a 2-line request must not read most of it.
    const file = new RecordingLogFile(
      Array.from({ length: 5_000 }, (_, i) => `line-${String(i).padStart(4, '0')}`).join('\n')
    );
    const size = (await file.size('/logs/service.log')) ?? 0;

    const tail = await readLogTail('/logs/service.log', 2, file);

    expect(tail?.lines).toEqual(['line-4998', 'line-4999']);
    expect(file.offsets).toHaveLength(1);
    expect(file.offsets[0]).toBe(size - 2 * LOG_TAIL_BYTES_PER_LINE);
    expect(tail?.truncated).toBe(true);
    expect(tail?.offset).toBe(size);
  });

  it('reads a file smaller than the budget from the start', async () => {
    const file = new RecordingLogFile('a\nb\nc\n');

    const tail = await readLogTail('/logs/service.log', 100, file);

    expect(file.offsets).toEqual([0]);
    expect(tail).toEqual({ lines: ['a', 'b', 'c'], truncated: false, offset: 6 });
  });

  it('drops the partial line a byte offset lands in', async () => {
    const file = new RecordingLogFile(`${'x'.repeat(LOG_TAIL_BYTES_PER_LINE)}\nlast\n`);

    const tail = await readLogTail('/logs/service.log', 1, file);

    // The offset falls inside the run of x's; that fragment is not a log line.
    expect(tail?.lines).toEqual(['last']);
    expect(tail?.truncated).toBe(true);
  });

  it('is null for a file that is not there, without reading it', async () => {
    expect(await readLogTail('/logs/gone.log', 10, new MissingLogFile())).toBeNull();
  });
});

describe('latestHubLogFile', () => {
  it('picks the newest hub log and ignores installer logs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mango-logs-'));
    try {
      await writeFile(join(dir, 'server-20260101-000000.log'), 'old');
      await writeFile(join(dir, 'service.log'), 'new');
      await writeFile(join(dir, 'install-run.log'), 'ignored');
      await utimes(join(dir, 'server-20260101-000000.log'), 1_000, 1_000);
      await utimes(join(dir, 'service.log'), 2_000, 2_000);
      expect(await latestHubLogFile(dir)).toBe(join(dir, 'service.log'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a missing directory', async () => {
    expect(await latestHubLogFile('/nonexistent/mango/logs')).toBeNull();
  });
});
