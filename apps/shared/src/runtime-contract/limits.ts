/**
 * Numeric bounds a runtime enforces and a hub must not exceed.
 *
 * The runtime refuses a call past any of these, which makes them the runtime's
 * rules — but the hub advertises the same numbers in a tool's JSON schema and
 * validates against them before it sends anything, so the model is told the
 * truth and an over-long read is refused where it can still be explained. Two
 * copies of one ceiling would show up as a tool whose schema promises 5000
 * lines and a runtime that answers 2000.
 *
 * A leaf, like {@link ./errors}: constants only, importing nothing.
 */

/** Smallest `maxLines` a text read may ask for. */
export const READ_FILE_MIN_MAX_LINES = 1;

/** Largest `maxLines` a text read may ask for. */
export const READ_FILE_MAX_MAX_LINES = 5000;

/** Largest `startLine` a text read may ask for. */
export const READ_FILE_MAX_START_LINE = 10_000_000;

/** Longest single line a text read emits before truncating it. */
export const READ_FILE_MAX_LINE_CHARS = 2000;

/** Ceiling on the text a single windowed read may emit. */
export const READ_FILE_MAX_WINDOW_BYTES = 256 * 1024;

/** Ceiling on the bytes any single read may put in memory. */
export const READ_FILE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Ceiling on a file read through `read_file`'s `hex` or `base64` view.
 *
 * Far below {@link READ_FILE_MAX_BYTES} because a byte view lands in the
 * model's context rather than being windowed away: base64 inflates by 4/3 and
 * hex by 2, so 256 KiB of file is already ~512 KiB of tokens.
 *
 * It shares a value with {@link READ_FILE_MAX_WINDOW_BYTES} and nothing else:
 * that one bounds the text a window may *emit*, while this bounds the bytes a
 * view may *consume* before transcoding inflates them. Deriving either from the
 * other would tie two budgets that are only coincidentally equal.
 */
export const READ_FILE_MAX_BINARY_VIEW_BYTES = 256 * 1024;

/** How many leading bytes a binary sniff looks at. */
export const BINARY_SNIFF_BYTES = 8 * 1024;
