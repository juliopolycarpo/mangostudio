/** Bounds shared by the wire schemas and their lightweight consumers. */

/**
 * The largest attachment the vendor wire carries, and how many of them.
 *
 * Exported because the send path has to refuse an oversized or overlong set
 * *before* the response is committed. A chat attachment may be far larger than
 * this — the upload cap is 20 MB and a turn may name twenty of them — and the
 * only thing standing between that and a stream that opens and then dies is a
 * check on this side that measures against the same two numbers the runtime's
 * own schema does.
 */
export const EXTERNAL_ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024;

export const EXTERNAL_TURN_MAX_ATTACHMENTS = 4;

/** How long a cached account-limits snapshot stays "fresh" before rendering as stale. */
export const EXTERNAL_ACCOUNT_LIMITS_STALE_MS = 15 * 60_000;

/**
 * How many commands one catalog may carry.
 *
 * Sized off the observed ceiling with room to grow: a Claude Code install with
 * plugins announces ~56 and Cursor ~32, so this bounds a vendor that starts
 * enumerating something else without silently dropping a real catalog.
 */
export const EXTERNAL_COMMAND_CATALOG_MAX_ITEMS = 256;

/**
 * How many sessions one page may carry.
 *
 * A ceiling rather than a preference: vendor histories are unbounded, and the
 * picker pages through them. Stated here so the runtime, the hub and the schema
 * cannot disagree about what "a page" is.
 */
export const EXTERNAL_NATIVE_SESSION_PAGE_LIMIT = 50;
