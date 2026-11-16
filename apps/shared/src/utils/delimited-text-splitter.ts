/**
 * Splits a stream of decoded text into records at a delimiter, one `push` per
 * read.
 *
 * The hand-written readers this replaces kept the unterminated tail in one
 * string, appended every read to it and searched the whole string again. A
 * record that spans n reads then costs O(record * n): a 1 MiB record in 16-byte
 * reads took several seconds. This splitter searches only the new text (plus
 * the few characters a delimiter could straddle), keeps the tail as a list of
 * pieces, and joins it once when the record completes.
 */

export interface DelimitedTextSplitterOptions {
  /** Longest record the splitter holds, in UTF-16 code units, delimiter excluded. */
  readonly maxRecordLength: number;
  /**
   * What happens to a record longer than `maxRecordLength`. `truncate` keeps its
   * first `maxRecordLength` units and drops the rest, and the next record
   * starts after the delimiter as usual. `refuse` throws a
   * {@link RecordTooLongError} (a `RangeError`) from `push` or `finish`, and every
   * call after it throws the same error. Records completed in the read that
   * overflowed are returned first; see `push`.
   */
  readonly onOverflow: 'truncate' | 'refuse';
}

/**
 * What a `refuse` splitter throws for a record over the cap. It is a
 * `RangeError`, so existing handlers still match, and it carries the lengths so
 * a caller can report them or tell it from any other `RangeError`.
 */
export class RecordTooLongError extends RangeError {
  /** Units of the record seen when it was refused; a lower bound when it never ended. */
  readonly recordLength: number;
  readonly maxRecordLength: number;

  constructor(recordLength: number, maxRecordLength: number) {
    super(
      `(DelimitedTextSplitter): record length ${recordLength} exceeds the cap | expected at most ${maxRecordLength} characters before the delimiter`
    );
    this.name = 'RecordTooLongError';
    this.recordLength = recordLength;
    this.maxRecordLength = maxRecordLength;
  }
}

/**
 * @example
 * const splitter = new DelimitedTextSplitter('\n\n', { maxRecordLength: 1 << 20, onOverflow: 'refuse' });
 * splitter.push('data: a\n'); // []
 * splitter.push('\ndata: b\n\n'); // ['data: a', 'data: b']
 */
export class DelimitedTextSplitter {
  readonly #delimiter: string;
  readonly #maxRecordLength: number;
  readonly #onOverflow: DelimitedTextSplitterOptions['onOverflow'];
  /** The unterminated record so far, cut to `#storedLimit` units. */
  #pieces: string[] = [];
  #storedLength = 0;
  /** Units of the unterminated record seen, including any that were not stored. */
  #seenLength = 0;
  /** The last `delimiter.length - 1` units seen: the part of a delimiter a read can end inside. */
  #tail = '';
  #refusal: RecordTooLongError | undefined;

  constructor(delimiter: string, options: DelimitedTextSplitterOptions) {
    if (delimiter.length === 0) {
      throw new RangeError('(DelimitedTextSplitter): expected a delimiter of at least 1 character');
    }
    if (!Number.isSafeInteger(options.maxRecordLength) || options.maxRecordLength < 0) {
      throw new RangeError(
        `(DelimitedTextSplitter): expected maxRecordLength to be a non-negative integer | received: ${options.maxRecordLength}`
      );
    }
    this.#delimiter = delimiter;
    this.#maxRecordLength = options.maxRecordLength;
    this.#onOverflow = options.onOverflow;
  }

  /**
   * The records this read completed, in order, without their delimiter. In
   * `refuse` mode a read that completes records and then overflows returns
   * those records, and the refusal is raised by the next `push` or `finish`; a
   * read that completes none raises it at once.
   */
  push(text: string): string[] {
    if (this.#refusal) throw this.#refusal;
    const records: string[] = [];
    try {
      this.#split(text, records);
    } catch (error) {
      if (error !== this.#refusal || records.length === 0) throw error;
    }
    return records;
  }

  /** Appends the records `text` completes to `records`, and holds what it leaves unterminated. */
  #split(text: string, records: string[]): void {
    let offset = 0;

    if (this.#seenLength > 0) {
      // The delimiter may start in the held tail and end in `text`.
      const found = (this.#tail + text).indexOf(this.#delimiter);
      if (found === -1) {
        this.#hold(text);
        return;
      }
      const tailLength = this.#tail.length;
      const recordLength = this.#seenLength - tailLength + found;
      records.push(this.#completeHeld(recordLength, text));
      offset = found + this.#delimiter.length - tailLength;
    }

    for (;;) {
      const found = text.indexOf(this.#delimiter, offset);
      if (found === -1) break;
      records.push(this.#bound(text.slice(offset, found), found - offset));
      offset = found + this.#delimiter.length;
    }
    if (offset < text.length) this.#hold(offset === 0 ? text : text.slice(offset));
  }

  /** Ends the stream: the unterminated record, or `''` when there is none. */
  finish(): string {
    if (this.#refusal) throw this.#refusal;
    const recordLength = this.#seenLength;
    const record = this.#bound(this.#pieces.join(''), recordLength);
    this.#reset();
    return record;
  }

  /** Holds a piece of the unterminated record, refusing one that can no longer fit. */
  #hold(piece: string): void {
    this.#seenLength += piece.length;
    // A delimiter's own prefix can sit in the held text before its last unit
    // arrives, so room for `delimiter.length - 1` extra units is kept.
    const slack = this.#delimiter.length - 1;
    if (this.#onOverflow === 'refuse' && this.#seenLength - slack > this.#maxRecordLength) {
      throw this.#refuse(this.#seenLength - slack);
    }
    const room = this.#maxRecordLength + slack - this.#storedLength;
    if (room > 0) {
      const kept = piece.length <= room ? piece : piece.slice(0, room);
      this.#pieces.push(kept);
      this.#storedLength += kept.length;
    }
    this.#tail = slack === 0 ? '' : (this.#tail + piece).slice(-slack);
  }

  /** Finishes the held record at a delimiter found `recordLength` units in; its remainder is in `text`. */
  #completeHeld(recordLength: number, text: string): string {
    const kept = Math.min(recordLength, this.#maxRecordLength);
    let record = this.#pieces.join('');
    // Everything stored is a prefix of the record. Stored text can only fall
    // short of `kept` when nothing was dropped, so the rest is in `text`.
    record =
      record.length >= kept ? record.slice(0, kept) : record + text.slice(0, kept - record.length);
    this.#reset();
    return this.#bound(record, recordLength);
  }

  /** Applies the cap to a complete record whose full length was `recordLength`. */
  #bound(record: string, recordLength: number): string {
    if (recordLength <= this.#maxRecordLength) return record;
    if (this.#onOverflow === 'refuse') throw this.#refuse(recordLength);
    const cut = record.slice(0, this.#maxRecordLength);
    // Never leave half a surrogate pair at the cut.
    return isHighSurrogate(cut.charCodeAt(cut.length - 1)) ? cut.slice(0, -1) : cut;
  }

  #refuse(recordLength: number): RecordTooLongError {
    this.#refusal = new RecordTooLongError(recordLength, this.#maxRecordLength);
    this.#reset();
    return this.#refusal;
  }

  #reset(): void {
    this.#pieces = [];
    this.#storedLength = 0;
    this.#seenLength = 0;
    this.#tail = '';
  }
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}
