/**
 * A bounded byte ring: appends grow it, and a push past capacity drops the
 * oldest bytes to make room. Used twice by a terminal session.
 *
 * As scrollback, it keeps the last N bytes of everything the shell ever wrote,
 * for `terminal.attach` replay; a drop there is silent, because scrollback is
 * defined as "the last N bytes" and there is no viewer yet to tell.
 *
 * As the pending buffer, a drop is not silent — `takeDroppedBytes()` is what
 * makes that possible. Bytes lost while the buffer stayed full accumulate here
 * uncollected, across as many overflowing pushes as it takes, so the session
 * can raise exactly one `{kind:'dropped'}` marker for the whole overflow
 * episode when draining finally resumes, instead of one per chunk that
 * happened to arrive while it was stuck.
 */
export class ByteRingBuffer {
  readonly #chunks: Uint8Array[] = [];
  readonly #capacityBytes: number;
  #length = 0;
  #dropped = 0;

  constructor(capacityBytes: number) {
    if (!Number.isInteger(capacityBytes) || capacityBytes <= 0) {
      throw new RangeError(
        `ByteRingBuffer capacity must be a positive integer; received ${capacityBytes}.`
      );
    }
    this.#capacityBytes = capacityBytes;
  }

  /** Bytes currently held. */
  get byteLength(): number {
    return this.#length;
  }

  /** Appends bytes, dropping the oldest past capacity and counting the loss. */
  push(data: Uint8Array): void {
    if (data.byteLength === 0) return;
    this.#chunks.push(data);
    this.#length += data.byteLength;
    while (this.#length > this.#capacityBytes) {
      const head = this.#chunks[0];
      if (!head) break;
      const excess = this.#length - this.#capacityBytes;
      if (head.byteLength <= excess) {
        this.#chunks.shift();
        this.#length -= head.byteLength;
        this.#dropped += head.byteLength;
      } else {
        this.#chunks[0] = head.subarray(excess);
        this.#length -= excess;
        this.#dropped += excess;
      }
    }
  }

  /** Removes and returns up to `maxBytes` from the front, oldest first. */
  take(maxBytes: number): Uint8Array {
    if (maxBytes <= 0 || this.#length === 0) return new Uint8Array(0);
    const out = new Uint8Array(Math.min(maxBytes, this.#length));
    let offset = 0;
    while (offset < out.byteLength) {
      const head = this.#chunks[0];
      if (!head) break;
      const need = out.byteLength - offset;
      if (head.byteLength <= need) {
        out.set(head, offset);
        offset += head.byteLength;
        this.#chunks.shift();
      } else {
        out.set(head.subarray(0, need), offset);
        this.#chunks[0] = head.subarray(need);
        offset += need;
      }
    }
    this.#length -= offset;
    return out;
  }

  /** The full contents, oldest first, without removing anything. */
  snapshot(): Uint8Array {
    const out = new Uint8Array(this.#length);
    let offset = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  /** Empties the buffer. Also drops any dropped-byte count nobody collected. */
  clear(): void {
    this.#chunks.length = 0;
    this.#length = 0;
    this.#dropped = 0;
  }

  /** Bytes dropped since the last call, then resets the count to zero. */
  takeDroppedBytes(): number {
    const dropped = this.#dropped;
    this.#dropped = 0;
    return dropped;
  }
}
