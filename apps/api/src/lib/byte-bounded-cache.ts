/**
 * A cache of byte arrays that never holds more than `maxBytes` in total. Reading a key makes it
 * the most recently used; storing one evicts the least recently used until the total fits. A value
 * larger than the whole budget is returned but not stored, so one oversized body cannot empty the
 * cache for nothing.
 *
 * Sized by bytes, not entries, because what it bounds is memory: `bounded-map.ts` counts entries,
 * which says nothing about a 1.6 MB script next to a 2 KB stylesheet.
 */
export class ByteBoundedCache<K, V extends Uint8Array = Uint8Array> {
  private readonly entries = new Map<K, V>();
  private storedBytes = 0;

  constructor(readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new Error(
        `ByteBoundedCache: expected maxBytes as a non-negative integer | received: ${maxBytes}`
      );
    }
  }

  /** Bytes currently held. Example: cache.totalBytes // 1625378 */
  get totalBytes(): number {
    return this.storedBytes;
  }

  /** Number of values currently held. Example: cache.size // 2 */
  get size(): number {
    return this.entries.size;
  }

  /**
   * The value for `key`, from the cache or from `compute`, which runs at most once per miss.
   * Example: cache.getOrCompute('/assets/main.js', () => Bun.gunzipSync(gzipped))
   */
  getOrCompute(key: K, compute: () => V): V {
    const hit = this.entries.get(key);
    if (hit !== undefined) {
      // Re-inserting moves the key to the end of the Map's order: most recently used.
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    const value = compute();
    if (value.byteLength > this.maxBytes) return value;
    this.entries.set(key, value);
    this.storedBytes += value.byteLength;
    for (const [oldestKey, oldest] of this.entries) {
      if (this.storedBytes <= this.maxBytes) break;
      this.entries.delete(oldestKey);
      this.storedBytes -= oldest.byteLength;
    }
    return value;
  }
}
