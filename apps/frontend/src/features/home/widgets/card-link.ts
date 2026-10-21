/**
 * The link that belongs to a hub card — "Manage", "Manage machines", "Open
 * library". Accent text, sentence case, an underline only under the pointer:
 * the same reading a link has in markdown.
 *
 * A class rather than a wrapper component because every caller is a router
 * `Link` with its own typed `to`, `params` and `search`, and a wrapper would
 * erase that typing for the sake of one line of styling.
 */
export const CARD_LINK_CLASS = 'w-fit text-xs font-medium text-accent-fg hover:underline';
