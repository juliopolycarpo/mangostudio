import { describe, expect, it } from 'bun:test';

import { NewlineSplitter, type NewlineSplitterOptions } from '../lib/newline-splitter';

/** What a caller can observe from one `push` or `finish`. */
type Observed = { readonly lines: readonly string[] } | { readonly refused: true };

function observe(call: () => readonly string[]): Observed {
  try {
    return { lines: call() };
  } catch (error) {
    if (error instanceof RangeError) return { refused: true };
    throw error;
  }
}

/** Feeds the splitter `pushes`, then finishes it. A refusal ends the run: it is its last entry. */
function feed(splitter: NewlineSplitter, pushes: readonly string[]): Observed[] {
  const observed: Observed[] = [];
  for (const piece of pushes) {
    const outcome = observe(() => splitter.push(piece));
    observed.push(outcome);
    if ('refused' in outcome) return observed;
  }
  observed.push(observe(() => [splitter.finish()]));
  return observed;
}

function cutToCap(line: string, maxLineLength: number): string {
  if (line.length <= maxLineLength) return line;
  const cut = line.slice(0, maxLineLength);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * What the splitter must report, computed from the whole stream instead of
 * incrementally: split it at every newline, hand each push the lines whose
 * newline it carried, and measure the unterminated rest at `finish`. A line over
 * the cap refuses at the push that proves it: the one that completes it, or the
 * one after which the held text is already over the cap.
 */
function expected(
  stream: string,
  pushes: readonly string[],
  options: NewlineSplitterOptions
): Observed[] {
  const parts = stream.split('\n');
  const rest = parts.pop() ?? '';
  const lineEnds: number[] = [];
  let end = 0;
  for (const part of parts) {
    end += part.length;
    lineEnds.push(end);
    end += 1;
  }

  const observed: Observed[] = [];
  let consumed = 0;
  let next = 0;
  for (const piece of pushes) {
    consumed += piece.length;
    const completed: string[] = [];
    let refused = false;
    for (; next < parts.length && (lineEnds[next] ?? Infinity) < consumed; next += 1) {
      const text = parts[next] ?? '';
      if (options.onOverflow === 'refuse' && text.length > options.maxLineLength) refused = true;
      completed.push(cutToCap(text, options.maxLineLength));
    }
    const openStart = next > 0 ? (lineEnds[next - 1] ?? 0) + 1 : 0;
    if (options.onOverflow === 'refuse' && consumed - openStart > options.maxLineLength) {
      refused = true;
    }
    if (refused) return [...observed, { refused: true }];
    observed.push({ lines: completed });
  }
  if (options.onOverflow === 'refuse' && rest.length > options.maxLineLength) {
    return [...observed, { refused: true }];
  }
  observed.push({ lines: [cutToCap(rest, options.maxLineLength)] });
  return observed;
}

/** A small deterministic generator, so a failing case names the seed that reproduces it. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const ALPHABET = ['a', 'b', '\n', '\n', '\r', '🥭', 'é'] as const;

function randomStream(random: () => number, length: number): string {
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out += ALPHABET[Math.floor(random() * ALPHABET.length)];
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

function observeError(call: () => unknown): RangeError {
  try {
    call();
  } catch (error) {
    if (error instanceof RangeError) return error;
    throw error;
  }
  throw new Error('expected a RangeError | received: no error');
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
    const random = seeded(0x5eed);
    for (let seed = 0; seed < 600; seed += 1) {
      const stream = randomStream(random, Math.floor(random() * 60));
      const options: NewlineSplitterOptions = {
        maxLineLength: [3, 8, 1000][seed % 3] ?? 3,
        onOverflow: seed % 2 === 0 ? 'truncate' : 'refuse',
      };
      const maxPiece = 1 + (seed % 7);
      const pushes = chunked(stream, () => Math.ceil(random() * maxPiece));

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
      const options: NewlineSplitterOptions = { maxLineLength: 3, onOverflow };
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

  describe('cost of a line that spans many pushes', () => {
    // The old readers took 3 to 10 s for the 16-byte case (n = 65 536 pushes) on
    // the machine this was written on. The bound is generous: it separates
    // linear from quadratic, it does not benchmark.
    const BOUND_MS = 1_500;
    const LINE_LENGTH = 1024 * 1024;

    for (const pieceLength of [16, 4096]) {
      it(`splits a 1 MiB line fed in ${pieceLength}-character pushes within ${BOUND_MS} ms`, () => {
        const stream = `${'a'.repeat(LINE_LENGTH)}\ntail`;
        const splitter = new NewlineSplitter({
          maxLineLength: 2 * LINE_LENGTH,
          onOverflow: 'refuse',
        });
        const lines: string[] = [];

        const startedAt = performance.now();
        for (let offset = 0; offset < stream.length; offset += pieceLength) {
          lines.push(...splitter.push(stream.slice(offset, offset + pieceLength)));
        }
        const elapsedMs = performance.now() - startedAt;

        expect({ lengths: lines.map((line) => line.length), rest: splitter.finish() }).toEqual({
          lengths: [LINE_LENGTH],
          rest: 'tail',
        });
        expect(elapsedMs).toBeLessThan(BOUND_MS);
      });
    }

    it('keeps the first cap characters of a line that never ends (2 MB pushed through)', () => {
      const splitter = new NewlineSplitter({ maxLineLength: 64, onOverflow: 'truncate' });

      for (let push = 0; push < 20_000; push += 1) splitter.push('x'.repeat(100));

      expect(splitter.finish()).toBe('x'.repeat(64));
    });
  });
});
