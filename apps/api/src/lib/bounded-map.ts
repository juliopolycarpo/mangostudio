/**
 * Sets a key on a `Map`, then evicts the least-recently-*written* entries
 * until the map is back within `maxEntries`. Re-inserting a key moves it to
 * the end of the Map's iteration order, so eviction drops the entry least
 * recently written rather than merely the one inserted longest ago.
 */
export function setBounded<K, V>(entries: Map<K, V>, key: K, value: V, maxEntries: number): void {
  entries.delete(key);
  entries.set(key, value);
  while (entries.size > maxEntries) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
}
