/**
 * The link that belongs to a hub card — "Manage", "Manage machines", "Open
 * library". Accent text, sentence case, an underline only under the pointer:
 * the same reading a link has in markdown.
 *
 * `inline-flex items-center` so the text sits in the middle of the 44px box a
 * touch screen gives every link; as a plain flex item in a card header it
 * floated to the top of that box, off the label beside it. On touch the box
 * overhangs the text by 12px a side (`pointer-coarse:-my-3`, the Callout
 * action's trick), so the header row stays 20px instead of 44px and the hit
 * area lands on the card's own padding and gap rather than on a neighbour.
 *
 * A class rather than a wrapper component because every caller is a router
 * `Link` with its own typed `to`, `params` and `search`, and a wrapper would
 * erase that typing for the sake of one line of styling.
 */
export const CARD_LINK_CLASS =
  'inline-flex w-fit items-center text-xs font-medium text-accent-fg hover:underline pointer-coarse:-my-3';
