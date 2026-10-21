/**
 * The mark of the current item in a vertical list — the sidebar, the settings
 * and onboarding step lists, a pick-one row: a 3px accent bar on the leading
 * edge, drawn with `bg-fill-selected` under it. The bar is what carries the
 * colour; the fill alone would not survive a grayscale screen.
 *
 * The row must be `relative`. Underline tabs have their own mark, `TAB_CLASSES`.
 */
export const SELECTION_BAR =
  'before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-accent';
