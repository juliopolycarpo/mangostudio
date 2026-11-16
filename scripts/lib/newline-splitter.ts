// Splits decoded text into lines, one `push` per read.
//
// Deliberately a small copy of `DelimitedTextSplitter`
// (apps/shared/src/utils/delimited-text-splitter.ts) cut down to the one
// delimiter these scripts use, rather than an import of it:
// `scripts/test-build.ts` runs in the smoke matrix under `--no-install`, so
// everything reachable from it must import nothing but `node:`/`bun` builtins
// (`scripts/tests/smoke-dependencies.unit.test.ts` walks the import graph), and
// `runner-guardian.ts`, `child-streams.ts` and the native qualification process
// are all reachable from it.
//
// The two must not drift: `scripts/tests/newline-splitter-parity.unit.test.ts`
// runs one oracle against both. This copy differs on purpose in one way: a read
// that completes lines and then overflows returns the lines first and raises on
// the next call.
//
// The hand-written readers this replaces kept the unterminated tail in one
// string, appended every read to it and searched the whole string again. A line
// that spans n reads then costs O(line * n): a 1 MiB line in 16-byte reads took
// several seconds. This splitter searches only the new text, keeps the tail as a
// list of pieces and joins it once when the line completes.

export interface NewlineSplitterOptions {
  /** Longest line the splitter holds, in UTF-16 code units, newline excluded. */
  readonly maxLineLength: number;
  /**
   * What happens to a line longer than `maxLineLength`. `truncate` keeps its
   * first `maxLineLength` units and drops the rest; the next line starts after
   * the newline as usual. `refuse` throws a `RangeError` naming the length and
   * the limit, and every call after it throws the same error. Lines completed in
   * the read that overflowed are still returned first (see `pushRecords`).
   */
  readonly onOverflow: 'truncate' | 'refuse';
}

/** One line and the length it had before the cap, newline excluded. Cut when `length` exceeds the cap. */
export interface SplitLine {
  readonly line: string;
  readonly length: number;
}

/**
 * @example
 * const splitter = new NewlineSplitter({ maxLineLength: 1 << 20, onOverflow: 'refuse' });
 * splitter.push('one\ntw'); // ['one']
 * splitter.push('o\nthree'); // ['two']
 * splitter.finish(); // 'three'
 */
export class NewlineSplitter {
  readonly #maxLineLength: number;
  readonly #onOverflow: NewlineSplitterOptions['onOverflow'];
  /** The unterminated line so far, cut to `#maxLineLength` units. */
  #pieces: string[] = [];
  #storedLength = 0;
  /** Units of the unterminated line seen, including any that were not stored. */
  #seenLength = 0;
  #refusal: RangeError | undefined;

  constructor(options: NewlineSplitterOptions) {
    if (!Number.isSafeInteger(options.maxLineLength) || options.maxLineLength < 0) {
      throw new RangeError(
        `(NewlineSplitter): expected maxLineLength to be a non-negative integer | received: ${options.maxLineLength}`
      );
    }
    this.#maxLineLength = options.maxLineLength;
    this.#onOverflow = options.onOverflow;
  }

  /** The lines this read completed, in order, without their newline. */
  push(text: string): string[] {
    return this.pushRecords(text).map((record) => record.line);
  }

  /**
   * Like {@link push}, but each line comes with the length it had before the cap
   * cut it, so a caller can tell a line cut to the cap from one exactly at it.
   *
   * In `refuse` mode a read that completes lines and then overflows returns those
   * lines: the refusal is raised by the next `push` or `finish`. A read that
   * completes none raises it at once.
   */
  pushRecords(text: string): SplitLine[] {
    if (this.#refusal) throw this.#refusal;
    const records: SplitLine[] = [];
    try {
      let offset = 0;
      for (;;) {
        const found = text.indexOf('\n', offset);
        if (found === -1) break;
        records.push(this.#complete(text.slice(offset, found)));
        offset = found + 1;
      }
      if (offset < text.length) this.#hold(offset === 0 ? text : text.slice(offset));
    } catch (error) {
      if (error !== this.#refusal || records.length === 0) throw error;
    }
    return records;
  }

  /** Ends the stream: the unterminated line, or `''` when there is none. */
  finish(): string {
    return this.finishRecord().line;
  }

  /** Like {@link finish}, with the length the line had before the cap cut it. */
  finishRecord(): SplitLine {
    if (this.#refusal) throw this.#refusal;
    return this.#complete('');
  }

  /** Ends the held line with `last`, the text before its newline in this read. */
  #complete(last: string): SplitLine {
    const length = this.#seenLength + last.length;
    if (length > this.#maxLineLength && this.#onOverflow === 'refuse') {
      throw this.#refuse(length);
    }
    const room = Math.max(0, this.#maxLineLength - this.#storedLength);
    const line = this.#pieces.join('') + (last.length <= room ? last : last.slice(0, room));
    this.#reset();
    if (length <= this.#maxLineLength) return { line, length };
    // Never leave half a surrogate pair at the cut.
    const whole = isHighSurrogate(line.charCodeAt(line.length - 1)) ? line.slice(0, -1) : line;
    return { line: whole, length };
  }

  /** Holds a piece of the unterminated line, refusing one that can no longer fit. */
  #hold(piece: string): void {
    this.#seenLength += piece.length;
    if (this.#onOverflow === 'refuse' && this.#seenLength > this.#maxLineLength) {
      throw this.#refuse(this.#seenLength);
    }
    const room = this.#maxLineLength - this.#storedLength;
    if (room <= 0) return;
    const kept = piece.length <= room ? piece : piece.slice(0, room);
    this.#pieces.push(kept);
    this.#storedLength += kept.length;
  }

  #refuse(lineLength: number): RangeError {
    this.#refusal = new RangeError(
      `(NewlineSplitter): line length ${lineLength} exceeds the cap | expected at most ${this.#maxLineLength} characters before the newline`
    );
    this.#reset();
    return this.#refusal;
  }

  #reset(): void {
    this.#pieces = [];
    this.#storedLength = 0;
    this.#seenLength = 0;
  }
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}
