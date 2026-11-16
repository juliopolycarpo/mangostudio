// Splits decoded text into lines, one `push` per read.
//
// Deliberately a small copy of `DelimitedTextSplitter` (apps/shared) cut down
// to the one delimiter these scripts use, rather than an import of it:
// `scripts/test-build.ts` runs in the smoke matrix under `--no-install`, so
// everything reachable from it must import nothing but `node:`/`bun` builtins
// (`scripts/tests/smoke-dependencies.unit.test.ts` walks the import graph), and
// `runner-guardian.ts`, `child-streams.ts` and the native qualification process
// are all reachable from it.
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
   * first `maxLineLength` units and drops the rest. `refuse` throws a
   * `RangeError` naming the length and the limit from `push`, and every call
   * after it throws the same error.
   */
  readonly onOverflow: 'truncate' | 'refuse';
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
    if (this.#refusal) throw this.#refusal;
    const lines: string[] = [];
    let offset = 0;
    for (;;) {
      const found = text.indexOf('\n', offset);
      if (found === -1) break;
      lines.push(this.#complete(text.slice(offset, found)));
      offset = found + 1;
    }
    if (offset < text.length) this.#hold(offset === 0 ? text : text.slice(offset));
    return lines;
  }

  /** Ends the stream: the unterminated line, or `''` when there is none. */
  finish(): string {
    if (this.#refusal) throw this.#refusal;
    return this.#complete('');
  }

  /** Ends the held line with `last`, the text before its newline in this read. */
  #complete(last: string): string {
    const lineLength = this.#seenLength + last.length;
    if (lineLength > this.#maxLineLength && this.#onOverflow === 'refuse') {
      throw this.#refuse(lineLength);
    }
    const room = Math.max(0, this.#maxLineLength - this.#storedLength);
    const line = this.#pieces.join('') + (last.length <= room ? last : last.slice(0, room));
    this.#reset();
    if (lineLength <= this.#maxLineLength) return line;
    // Never leave half a surrogate pair at the cut.
    return isHighSurrogate(line.charCodeAt(line.length - 1)) ? line.slice(0, -1) : line;
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
