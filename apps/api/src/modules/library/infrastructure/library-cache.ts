/**
 * Hub-side library scan/hash cache. Instance-hash memos still live in
 * `@mangostudio/runtime`; grouped discovery memos stay on the hub so they
 * never share scan slots with the runtime process singleton.
 */

import { LIBRARY_SCAN_CACHE_TTL_MS, LibraryCache } from '@mangostudio/runtime';

export { LIBRARY_SCAN_CACHE_TTL_MS, LibraryCache };

/** Memo for grouped `LibraryResource[]` discovery on the hub (not the runtime singleton). */
export const hubLibraryDiscoveryCache = new LibraryCache();
