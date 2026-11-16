import { describe, expect, it } from 'bun:test';

import {
  DelimitedTextSplitter,
  type DelimitedTextSplitterOptions,
  RecordTooLongError,
} from '../../src/utils/delimited-text-splitter';

/** What a caller can observe from one `push` or `finish`. */
type Observed = { readonly records: readonly string[] } | { readonly refused: true };

function observe(call: () => readonly string[]): Observed {
  try {
    return { records: call() };
  } catch (error) {
    if (error instanceof RangeError) return { refused: true };
    throw error;
  }
}

/** Feeds the splitter `pushes`, then finishes it. A refusal ends the run: it is its last entry. */
function feed(splitter: DelimitedTextSplitter, pushes: readonly string[]): Observed[] {
  const observed: Observed[] = [];
  for (const piece of pushes) {
    const outcome = observe(() => splitter.push(piece));
    observed.push(outcome);
    if ('refused' in outcome) return observed;
  }
  observed.push(observe(() => [splitter.finish()]));
  return observed;
}

function cutToCap(record: string, options: DelimitedTextSplitterOptions): string {
  if (record.length <= options.maxRecordLength) return record;
  const cut = record.slice(0, options.maxRecordLength);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * What the splitter must report, computed from the whole stream instead of
 * incrementally: split it at the delimiter (leftmost, non-overlapping), hand
 * each push the records whose delimiter its last unit completed, and measure
 * the unterminated rest at `finish`. A record over the cap refuses at the push
 * that proves it (the delimiter arrived, or the held text outgrew the cap by
 * more than a delimiter prefix) and `finish` refuses a rest over the cap. The
 * records that push completed before the refusing one are still returned, and
 * the refusal is the next entry.
 */
function expected(
  stream: string,
  delimiter: string,
  pushes: readonly string[],
  options: DelimitedTextSplitterOptions
): Observed[] {
  const records: { readonly text: string; readonly delimiterEnd: number }[] = [];
  let start = 0;
  for (;;) {
    const at = stream.indexOf(delimiter, start);
    if (at === -1) break;
    records.push({ text: stream.slice(start, at), delimiterEnd: at + delimiter.length });
    start = at + delimiter.length;
  }
  const restStart = start;
  const rest = stream.slice(restStart);
  const slack = delimiter.length - 1;

  const observed: Observed[] = [];
  let consumed = 0;
  let next = 0;
  for (const piece of pushes) {
    consumed += piece.length;
    const completed: string[] = [];
    let refused = false;
    for (; next < records.length && itemAt(records, next).delimiterEnd <= consumed; next += 1) {
      const text = itemAt(records, next).text;
      if (options.onOverflow === 'refuse' && text.length > options.maxRecordLength) {
        refused = true;
        break;
      }
      completed.push(cutToCap(text, options));
    }
    const openStart = next > 0 ? itemAt(records, next - 1).delimiterEnd : 0;
    if (
      !refused &&
      options.onOverflow === 'refuse' &&
      consumed - openStart - slack > options.maxRecordLength
    ) {
      refused = true;
    }
    if (refused) {
      // The records completed before the refusing one come back with their push;
      // the refusal is raised by the next call, or by `finish`.
      if (completed.length > 0) observed.push({ records: completed });
      return [...observed, { refused: true }];
    }
    observed.push({ records: completed });
  }
  if (options.onOverflow === 'refuse' && rest.length > options.maxRecordLength) {
    return [...observed, { refused: true }];
  }
  observed.push({ records: [cutToCap(rest, options)] });
  return observed;
}

function itemAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`expected an item at index ${index} | received: ${items.length} items`);
  }
  return item;
}

/** A small deterministic generator, so a failing case names the seed that reproduces it. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function randomStream(random: () => number, alphabet: readonly string[], length: number): string {
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out += itemAt(alphabet, Math.floor(random() * alphabet.length));
  }
  return out;
}

function chunked(stream: string, sizes: () => number): string[] {
  const pieces: string[] = [];
  for (let offset = 0; offset < stream.length;) {
    const size = Math.max(1, sizes());
    pieces.push(stream.slice(offset, offset + size));
    offset += size;
  }
  return pieces;
}

const DELIMITERS = ['\n', '\n\n', '\r\n', 'aa', '--sep--'] as const;
const ALPHABET = ['a', 'b', '-', 's', 'e', 'p', '\n', '\n', '\r', '🥭', 'é'] as const;

describe('DelimitedTextSplitter', () => {
  it('returns records as their delimiter arrives and the unterminated rest from finish', () => {
    const splitter = new DelimitedTextSplitter('\n\n', {
      maxRecordLength: 100,
      onOverflow: 'refuse',
    });

    expect(splitter.push('data: a\n')).toEqual([]);
    expect(splitter.push('\ndata: b\n\ndata: ')).toEqual(['data: a', 'data: b']);
    expect(splitter.push('c')).toEqual([]);
    expect(splitter.finish()).toBe('data: c');
    expect(splitter.finish()).toBe('');
  });

  it('finds a delimiter that straddles two pushes, at any split point', () => {
    for (const delimiter of DELIMITERS) {
      for (let cut = 0; cut <= delimiter.length; cut += 1) {
        const splitter = new DelimitedTextSplitter(delimiter, {
          maxRecordLength: 100,
          onOverflow: 'refuse',
        });
        const stream = `one${delimiter}two`;
        const at = 3 + cut;

        const received = [
          ...splitter.push(stream.slice(0, at)),
          ...splitter.push(stream.slice(at)),
        ];

        expect({ delimiter, cut, received, rest: splitter.finish() }).toEqual({
          delimiter,
          cut,
          received: ['one'],
          rest: 'two',
        });
      }
    }
  });

  it('matches splitting the whole stream for every chunking of random streams', () => {
    // Per push and on finish, for each delimiter and both overflow modes. A
    // failure names the seed, delimiter, mode and chunk sizes that reproduce it.
    const random = seeded(0x5eed);
    for (let seed = 0; seed < 600; seed += 1) {
      const delimiter = itemAt(DELIMITERS, seed % DELIMITERS.length);
      const stream = randomStream(
        random,
        [...ALPHABET, delimiter.charAt(0)],
        Math.floor(random() * 60)
      );
      const options: DelimitedTextSplitterOptions = {
        maxRecordLength: itemAt([3, 8, 1000], seed % 3),
        onOverflow: seed % 2 === 0 ? 'truncate' : 'refuse',
      };
      const maxPiece = 1 + (seed % 7);
      const pushes = chunked(stream, () => Math.ceil(random() * maxPiece));

      const received = feed(new DelimitedTextSplitter(delimiter, options), pushes);

      expect({ seed, delimiter, options, pushes, received }).toEqual({
        seed,
        delimiter,
        options,
        pushes,
        received: expected(stream, delimiter, pushes, options),
      });
    }
  });

  it('matches splitting the whole stream when the stream is cut in two at every position', () => {
    const stream = 'ab\n\ncd\n\n\nef\n\n🥭gh\n';
    const options: DelimitedTextSplitterOptions = { maxRecordLength: 3, onOverflow: 'truncate' };
    for (const delimiter of ['\n', '\n\n']) {
      for (let cut = 0; cut <= stream.length; cut += 1) {
        const pushes = [stream.slice(0, cut), stream.slice(cut)];

        const received = feed(new DelimitedTextSplitter(delimiter, options), pushes);

        expect({ delimiter, cut, received }).toEqual({
          delimiter,
          cut,
          received: expected(stream, delimiter, pushes, options),
        });
      }
    }
  });

  describe('record cap', () => {
    it('truncates a longer record, drops its rest through the delimiter, and carries on', () => {
      const splitter = new DelimitedTextSplitter('\n', {
        maxRecordLength: 4,
        onOverflow: 'truncate',
      });

      expect(splitter.push('abcdefgh')).toEqual([]);
      expect(splitter.push('ijkl\nmno\npqrstu')).toEqual(['abcd', 'mno']);
      expect(splitter.finish()).toBe('pqrs');
    });

    it('does not leave half a surrogate pair at the cut', () => {
      const splitter = new DelimitedTextSplitter('\n', {
        maxRecordLength: 3,
        onOverflow: 'truncate',
      });

      expect(splitter.push('ab🥭\n')).toEqual(['ab']);
    });

    it('refuses a longer record with its length and the cap, and keeps refusing', () => {
      const splitter = new DelimitedTextSplitter('\n', {
        maxRecordLength: 4,
        onOverflow: 'refuse',
      });

      expect(splitter.push('abcd')).toEqual([]);
      const refusal = observeError(() => splitter.push('e'));

      expect(refusal.message).toBe(
        '(DelimitedTextSplitter): record length 5 exceeds the cap | expected at most 4 characters before the delimiter'
      );
      expect(observeError(() => splitter.push('\n'))).toBe(refusal);
      expect(observeError(() => splitter.finish())).toBe(refusal);
    });

    it('names the lengths on the error it throws, and it is a RangeError', () => {
      const splitter = new DelimitedTextSplitter('\n', {
        maxRecordLength: 4,
        onOverflow: 'refuse',
      });

      const refusal = observeError(() => splitter.push('abcdefg'));

      expect(refusal).toBeInstanceOf(RecordTooLongError);
      expect(refusal).toMatchObject({
        name: 'RecordTooLongError',
        recordLength: 7,
        maxRecordLength: 4,
      });
    });

    it('returns the records a read completed before its tail overflowed, then refuses on the next call', () => {
      const splitter = new DelimitedTextSplitter('\n', {
        maxRecordLength: 4,
        onOverflow: 'refuse',
      });

      expect(splitter.push('ok1\nok2\nabcdefgh')).toEqual(['ok1', 'ok2']);

      expect(observeError(() => splitter.push('')).message).toContain('record length 8 exceeds');
    });

    it('returns the records before a completed record that is over the cap, then refuses on finish', () => {
      const splitter = new DelimitedTextSplitter('\n', {
        maxRecordLength: 4,
        onOverflow: 'refuse',
      });

      expect(splitter.push('ok\nabcdefgh\nlater\n')).toEqual(['ok']);

      expect(observeError(() => splitter.finish()).message).toContain('record length 8 exceeds');
    });

    it('refuses at once when the read completed no record before the overflow', () => {
      const splitter = new DelimitedTextSplitter('\n', {
        maxRecordLength: 4,
        onOverflow: 'refuse',
      });

      expect(observeError(() => splitter.push('abcdefgh\nok\n')).message).toContain(
        'record length 8 exceeds'
      );
    });

    it('accepts a record of exactly the cap, with its delimiter split across pushes', () => {
      const splitter = new DelimitedTextSplitter('\n\n', {
        maxRecordLength: 4,
        onOverflow: 'refuse',
      });

      expect(splitter.push('abcd\n')).toEqual([]);
      expect(splitter.push('\nxy')).toEqual(['abcd']);
      expect(splitter.finish()).toBe('xy');
    });

    it('rejects a delimiter that is empty and a cap that is not a count', () => {
      const bad = (delimiter: string, maxRecordLength: number) => () =>
        new DelimitedTextSplitter(delimiter, { maxRecordLength, onOverflow: 'refuse' });

      expect(bad('', 1)).toThrow('expected a delimiter of at least 1 character');
      expect(bad('\n', -1)).toThrow(
        'expected maxRecordLength to be a non-negative integer | received: -1'
      );
      expect(bad('\n', 1.5)).toThrow('received: 1.5');
    });
  });

  describe('cost of a record that spans many pushes', () => {
    // The old readers took 3 to 10 s for the 16-byte case (n = 65 536 pushes) on
    // the machine this was written on. The bound is generous: it separates
    // linear from quadratic, it does not benchmark.
    const BOUND_MS = 1_500;
    const RECORD_LENGTH = 1024 * 1024;

    for (const [delimiter, pieceLength] of [
      ['\n', 16],
      ['\n\n', 16],
      ['\n', 4096],
    ] as const) {
      it(`splits a 1 MiB record fed in ${pieceLength}-character pushes within ${BOUND_MS} ms (delimiter ${JSON.stringify(delimiter)})`, () => {
        const stream = `${'a'.repeat(RECORD_LENGTH)}${delimiter}tail`;
        const splitter = new DelimitedTextSplitter(delimiter, {
          maxRecordLength: 2 * RECORD_LENGTH,
          onOverflow: 'refuse',
        });
        const records: string[] = [];

        const startedAt = performance.now();
        for (let offset = 0; offset < stream.length; offset += pieceLength) {
          records.push(...splitter.push(stream.slice(offset, offset + pieceLength)));
        }
        const elapsedMs = performance.now() - startedAt;

        expect({
          lengths: records.map((record) => record.length),
          rest: splitter.finish(),
        }).toEqual({
          lengths: [RECORD_LENGTH],
          rest: 'tail',
        });
        expect(elapsedMs).toBeLessThan(BOUND_MS);
      });
    }

    it('keeps the first cap characters of a record that never ends (2 MB pushed through)', () => {
      const splitter = new DelimitedTextSplitter('\n', {
        maxRecordLength: 64,
        onOverflow: 'truncate',
      });

      for (let push = 0; push < 20_000; push += 1) splitter.push('x'.repeat(100));

      expect(splitter.finish()).toBe('x'.repeat(64));
    });
  });
});

function observeError(call: () => unknown): RangeError {
  try {
    call();
  } catch (error) {
    if (error instanceof RangeError) return error;
    throw error;
  }
  throw new Error('expected a RangeError | received: no error');
}
