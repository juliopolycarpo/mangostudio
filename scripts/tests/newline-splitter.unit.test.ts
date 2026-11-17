import { describe, expect, it } from 'bun:test';

import { NewlineSplitter, type SplitLine } from '../lib/newline-splitter';
import { cutToCap, expected, feed, oracleCases } from './support/newline-oracle';
import { countScanWork } from './support/scan-work';

function observeError(call: () => unknown): RangeError {
  try {
    call();
  } catch (error) {
    if (error instanceof RangeError) return error;
    throw error;
  }
  throw new Error('expected a RangeError | received: no error');
}

/**
 * The reader this splitter replaces, kept as the quadratic reference the work
 * counter must catch: one string, every read appended and the whole string
 * searched again.
 */
class AccumulatingLineReader {
  private pending = '';

  push(text: string): string[] {
    this.pending += text;
    const lines: string[] = [];
    let newline = this.pending.indexOf('\n');
    while (newline !== -1) {
      lines.push(this.pending.slice(0, newline));
      this.pending = this.pending.slice(newline + 1);
      newline = this.pending.indexOf('\n');
    }
    return lines;
  }
}

/** Feeds `lineLength` characters and a newline in `pieceLength`-character pushes; returns the work counted. */
function scanWorkOfOneLine(
  reader: { push(text: string): unknown },
  lineLength: number,
  pieceLength: number
): number {
  const stream = `${'a'.repeat(lineLength)}\n`;
  return countScanWork(() => {
    for (let offset = 0; offset < stream.length; offset += pieceLength) {
      reader.push(stream.slice(offset, offset + pieceLength));
    }
  });
}

describe('NewlineSplitter', () => {
  it('returns lines as their newline arrives and the unterminated rest from finish', () => {
    const splitter = new NewlineSplitter({ maxLineLength: 100, onOverflow: 'refuse' });

    expect(splitter.push('one\ntw')).toEqual(['one']);
    expect(splitter.push('o\n\nthree\nfo')).toEqual(['two', '', 'three']);
    expect(splitter.push('ur')).toEqual([]);
    expect(splitter.finish()).toBe('four');
    expect(splitter.finish()).toBe('');
  });

  it('keeps a carriage return in the line, for the caller to trim', () => {
    const splitter = new NewlineSplitter({ maxLineLength: 100, onOverflow: 'refuse' });

    expect(splitter.push('a\r\nb\r')).toEqual(['a\r']);
    expect(splitter.finish()).toBe('b\r');
  });

  it('matches splitting the whole stream for every chunking of random streams', () => {
    // Per push and on finish, for each overflow mode. A failure names the seed,
    // mode and chunk sizes that reproduce it.
    for (const { seed, stream, pushes, options } of oracleCases(600)) {
      const received = feed(new NewlineSplitter(options), pushes);

      expect({ seed, options, pushes, received }).toEqual({
        seed,
        options,
        pushes,
        received: expected(stream, pushes, options),
      });
    }
  });

  it('matches splitting the whole stream when the stream is cut in two at every position', () => {
    const stream = 'ab\ncd\n\nef\n🥭gh\n';
    for (const onOverflow of ['truncate', 'refuse'] as const) {
      const options = { maxLineLength: 3, onOverflow } as const;
      for (let cut = 0; cut <= stream.length; cut += 1) {
        const pushes = [stream.slice(0, cut), stream.slice(cut)];

        const received = feed(new NewlineSplitter(options), pushes);

        expect({ onOverflow, cut, received }).toEqual({
          onOverflow,
          cut,
          received: expected(stream, pushes, options),
        });
      }
    }
  });

  describe('line cap', () => {
    it('truncates a longer line, drops its rest through the newline, and carries on', () => {
      const splitter = new NewlineSplitter({ maxLineLength: 4, onOverflow: 'truncate' });

      expect(splitter.push('abcdefgh')).toEqual([]);
      expect(splitter.push('ijkl\nmno\npqrstu')).toEqual(['abcd', 'mno']);
      expect(splitter.finish()).toBe('pqrs');
    });

    it('does not leave half a surrogate pair at the cut', () => {
      const splitter = new NewlineSplitter({ maxLineLength: 3, onOverflow: 'truncate' });

      expect(splitter.push('ab🥭\n')).toEqual(['ab']);
    });

    it('refuses a longer line with its length and the cap, and keeps refusing', () => {
      const splitter = new NewlineSplitter({ maxLineLength: 4, onOverflow: 'refuse' });

      expect(splitter.push('abcd')).toEqual([]);
      const refusal = observeError(() => splitter.push('e'));

      expect(refusal.message).toBe(
        '(NewlineSplitter): line length 5 exceeds the cap | expected at most 4 characters before the newline'
      );
      expect(observeError(() => splitter.push('\n'))).toBe(refusal);
      expect(observeError(() => splitter.finish())).toBe(refusal);
    });

    it('returns the lines a read completed before its tail overflowed, then refuses on the next call', () => {
      const splitter = new NewlineSplitter({ maxLineLength: 4, onOverflow: 'refuse' });

      expect(splitter.push('ok1\nok2\nabcdefgh')).toEqual(['ok1', 'ok2']);

      expect(observeError(() => splitter.push('')).message).toContain('line length 8 exceeds');
    });

    it('returns the lines before a completed line that is over the cap, then refuses on finish', () => {
      const splitter = new NewlineSplitter({ maxLineLength: 4, onOverflow: 'refuse' });

      expect(splitter.push('ok\nabcdefgh\nlater\n')).toEqual(['ok']);

      expect(observeError(() => splitter.finish()).message).toContain('line length 8 exceeds');
    });

    it('refuses at once when the read completed no line before the overflow', () => {
      const splitter = new NewlineSplitter({ maxLineLength: 4, onOverflow: 'refuse' });

      expect(observeError(() => splitter.push('abcdefgh\nok\n')).message).toContain(
        'line length 8 exceeds'
      );
    });

    it('accepts a line of exactly the cap', () => {
      const splitter = new NewlineSplitter({ maxLineLength: 4, onOverflow: 'refuse' });

      expect(splitter.push('abcd\nxy')).toEqual(['abcd']);
      expect(splitter.finish()).toBe('xy');
    });

    it('rejects a cap that is not a count', () => {
      const bad = (maxLineLength: number) => () =>
        new NewlineSplitter({ maxLineLength, onOverflow: 'refuse' });

      expect(bad(-1)).toThrow('expected maxLineLength to be a non-negative integer | received: -1');
      expect(bad(1.5)).toThrow('received: 1.5');
    });
  });

  describe('records', () => {
    it('carry the length a line had before the cap, so a cut line differs from one exactly at the cap', () => {
      const splitter = new NewlineSplitter({ maxLineLength: 4, onOverflow: 'truncate' });

      expect(splitter.pushRecords('abcd\nabcdefg\nab')).toEqual([
        { line: 'abcd', length: 4 },
        { line: 'abcd', length: 7 },
      ]);
      expect(splitter.finishRecord()).toEqual({ line: 'ab', length: 2 });
    });

    it('carry the whole length of a line that spans reads, and of a cut surrogate pair', () => {
      const splitter = new NewlineSplitter({ maxLineLength: 3, onOverflow: 'truncate' });

      expect(splitter.pushRecords('ab🥭')).toEqual([]);
      expect(splitter.pushRecords('xyz\n')).toEqual([{ line: 'ab', length: 7 }]);
    });

    it('match the lengths of splitting the whole stream, for every chunking of random streams', () => {
      for (const { seed, stream, pushes, options } of oracleCases(300)) {
        if (options.onOverflow !== 'truncate') continue;
        const splitter = new NewlineSplitter(options);

        const received: SplitLine[] = [];
        for (const piece of pushes) received.push(...splitter.pushRecords(piece));
        received.push(splitter.finishRecord());

        expect({ seed, pushes, received }).toEqual({
          seed,
          pushes,
          received: stream.split('\n').map((line) => ({
            line: cutToCap(line, options.maxLineLength),
            length: line.length,
          })),
        });
      }
    });
  });

  describe('work on a line that spans many pushes', () => {
    // Counted, not timed: the units searched or joined, not the milliseconds
    // they took. The old readers searched the pending line on every read, so a
    // 1 MiB line in 16-character pushes cost about 3.4e10 units; this splitter
    // searches each unit once and joins the line once.
    const LINE_LENGTH = 1024 * 1024;

    it('searches and joins at most 3 times the input for a 1 MiB line fed in 16-character pushes', () => {
      const splitter = new NewlineSplitter({
        maxLineLength: 2 * LINE_LENGTH,
        onOverflow: 'refuse',
      });

      const units = scanWorkOfOneLine(splitter, LINE_LENGTH, 16);

      expect(units).toBeLessThanOrEqual(3 * (LINE_LENGTH + 1));
    });

    it('does the same in truncate mode, where the cap drops the rest', () => {
      const splitter = new NewlineSplitter({ maxLineLength: 64, onOverflow: 'truncate' });

      const units = scanWorkOfOneLine(splitter, LINE_LENGTH, 16);

      expect(units).toBeLessThanOrEqual(3 * (LINE_LENGTH + 1));
    });

    it('counts the work of the accumulating reader as quadratic, so the guard can fail', () => {
      // 64 KiB keeps the reference quick: its work is about (n / 16) * n / 2 units.
      const length = 64 * 1024;

      const units = scanWorkOfOneLine(new AccumulatingLineReader(), length, 16);

      expect(units).toBeGreaterThan(100 * (length + 1));
    });

    it('keeps the first cap characters of a line that never ends (2 MB pushed through)', () => {
      const splitter = new NewlineSplitter({ maxLineLength: 64, onOverflow: 'truncate' });

      for (let push = 0; push < 20_000; push += 1) splitter.push('x'.repeat(100));

      expect(splitter.finish()).toBe('x'.repeat(64));
    });
  });
});
