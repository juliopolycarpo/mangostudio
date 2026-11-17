/**
 * The page size of the paged list routes that take `limit` as free text
 * (`GET /api/chats/:id/messages`, `GET /api/messages/images`).
 *
 * The largest `limit` any client sends is 50, so 100 leaves headroom while
 * keeping one page small enough to build and serialize without stalling the
 * hub. A `limit` above the maximum is clamped to it; one that is not a positive
 * integer is treated as absent and gets the default.
 */

/** Rows in a page when `limit` is absent or unusable. */
export const PAGE_LIMIT_DEFAULT = 50;

/** The most rows one page returns, whatever `limit` asks for. */
export const PAGE_LIMIT_MAX = 100;
