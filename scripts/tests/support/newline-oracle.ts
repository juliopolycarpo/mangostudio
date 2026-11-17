/**
 * An oracle for newline splitters: what a splitter must report for a stream and
 * a chunking, computed from the whole stream instead of incrementally. One
 * oracle serves `NewlineSplitter` and `DelimitedTextSplitter('\n')`, so a drift
 * between the two shows as a failing case that names its seed.
 */

/** The two things a splitter under test must offer. */
export interface SplitterUnderTest {
  push(text: string): string[];
  finish(): string;
}

export interface OracleOptions {
  readonly maxLineLength: number;
  readonly onOverflow: 'truncate' | 'refuse';
}

/** What a caller can observe from one `push` or `finish`. */
export type Observed = { readonly lines: readonly string[] } | { readonly refused: true };

function observe(call: () => readonly string[]): Observed {
  try {
    return { lines: call() };
  } catch (error) {
    if (error instanceof RangeError) return { refused: true };
    throw error;
  }
}

/** Feeds the splitter `pushes`, then finishes it. A refusal ends the run: it is its last entry. */
export function feed(splitter: SplitterUnderTest, pushes: readonly string[]): Observed[] {
  const observed: Observed[] = [];
  for (const piece of pushes) {
    const outcome = observe(() => splitter.push(piece));
    observed.push(outcome);
    if ('refused' in outcome) return observed;
  }
  observed.push(observe(() => [splitter.finish()]));
  return observed;
}

export function cutToCap(line: string, maxLineLength: number): string {
  if (line.length <= maxLineLength) return line;
  const cut = line.slice(0, maxLineLength);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Split the stream at every newline, hand each push the lines whose newline it
 * carried, and measure the unterminated rest at `finish`. A line over the cap
 * refuses at the push that proves it: the one that completes it, or the one
 * after which the held text is already over the cap. The lines that push
 * completed before the refusing one are still returned, and the refusal is the
 * next entry (the next push, or `finish`).
 */
export function expected(
  stream: string,
  pushes: readonly string[],
  options: OracleOptions
): Observed[] {
  const parts = stream.split('\n');
  const rest = parts.pop() ?? '';
  // lineEnds[i] is the index of the newline that ends parts[i].
  const lineEnds: number[] = [];
  let end = 0;
  for (const part of parts) {
    end += part.length;
    lineEnds.push(end);
    end += 1;
  }

  const refuse = options.onOverflow === 'refuse';
  const observed: Observed[] = [];
  let consumed = 0;
  let next = 0;
  for (const piece of pushes) {
    consumed += piece.length;
    const completed: string[] = [];
    let refused = false;
    for (; next < parts.length && (lineEnds[next] ?? Infinity) < consumed; next += 1) {
      const text = parts[next] ?? '';
      if (refuse && text.length > options.maxLineLength) {
        refused = true;
        next = parts.length;
        break;
      }
      completed.push(cutToCap(text, options.maxLineLength));
    }
    const openStart = next > 0 ? (lineEnds[next - 1] ?? 0) + 1 : 0;
    if (!refused && refuse && consumed - openStart > options.maxLineLength) refused = true;
    if (refused) {
      if (completed.length > 0) observed.push({ lines: completed });
      return [...observed, { refused: true }];
    }
    observed.push({ lines: completed });
  }
  if (refuse && rest.length > options.maxLineLength) return [...observed, { refused: true }];
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

/** One random case: the stream, its chunking and the options, all fixed by `seed`. */
export interface OracleCase {
  readonly seed: number;
  readonly stream: string;
  readonly pushes: readonly string[];
  readonly options: OracleOptions;
}

/** `count` cases, alternating overflow modes and cycling the caps 3, 8 and 1000. */
export function oracleCases(count: number): OracleCase[] {
  const random = seeded(0x5eed);
  const cases: OracleCase[] = [];
  for (let seed = 0; seed < count; seed += 1) {
    const stream = randomStream(random, Math.floor(random() * 60));
    const options: OracleOptions = {
      maxLineLength: [3, 8, 1000][seed % 3] ?? 3,
      onOverflow: seed % 2 === 0 ? 'truncate' : 'refuse',
    };
    const maxPiece = 1 + (seed % 7);
    cases.push({
      seed,
      stream,
      pushes: chunked(stream, () => Math.ceil(random() * maxPiece)),
      options,
    });
  }
  return cases;
}
