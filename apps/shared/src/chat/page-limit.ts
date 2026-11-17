/**
 * The page size of the paged list routes that take `limit` as free text
 * (`GET /api/chats/:id/messages`, `GET /api/messages/images`).
 *
 * The largest `limit` any client sends is 50, so 100 leaves headroom while
 * keeping one page small enough to build and serialize without stalling the
 * hub. The query schemas refuse a `limit` outside `1..PAGE_LIMIT_MAX` (422), as
 * the activity, GitHub and external-session routes do.
 */

/** Rows in a page when `limit` is absent. */
export const PAGE_LIMIT_DEFAULT = 50;

/** The most rows one page may ask for. */
export const PAGE_LIMIT_MAX = 100;
