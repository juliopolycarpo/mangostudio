/**
 * The chat's one reading column.
 *
 * The transcript, the notices above the composer, the pinned todos and the
 * composer itself all sit in it, so a balloon, a callout and the composer share
 * both edges at every width. Two numbers define it and both are written once,
 * here: how wide the column is, and how far the page keeps it from the window.
 *
 * The gutter is the composer footer's own ladder (`p-3 sm:p-4 md:p-6`, read on
 * its sides), which is why the footer does not import it: it needs the same
 * steps on all four sides.
 */

/** Centres a block in the chat column: 896px, as wide as the composer. */
export const CHAT_COLUMN_CLASS = 'mx-auto w-full max-w-4xl';

/** The sideways gutter between the window and the column. */
export const CHAT_GUTTER_X_CLASS = 'px-3 sm:px-4 md:px-6';
