/**
 * The face of a control laid on `scrim-media` — the lightbox's Close, a tile's
 * download — added on top of `buttonClassName('subtle', size)`.
 *
 * The veil is the same black in both themes, because a photograph is not
 * themed (foundations.md), so what sits on it cannot be themed either. These
 * controls used to wear `secondary`, whose `control` fill follows the theme: in
 * the light theme that drew a bright white tile on near-black, the brightest
 * thing on screen after the picture, while the same button was a quiet dark tile
 * in the dark theme. Here the glyph is `on-scrim-media` and the hover and press
 * fills are that same white at a fixed share, so both themes draw one control.
 * The focus ring is `on-scrim-media` too: the theme's `focus` is a dark brown in
 * the light theme, and a dark ring on a dark veil is not a ring.
 *
 * The fills are the `fill-media-*` tokens, that same white at 16% and 24%.
 *
 * @example
 * <Button variant="subtle" size="icon" className={MEDIA_CONTROL_CLASS}>…</Button>
 */
export const MEDIA_CONTROL_CLASS = [
  'text-on-scrim-media',
  'not-disabled:hover:bg-fill-media-hover',
  'not-disabled:active:bg-fill-media-pressed',
  'focus-visible:outline-on-scrim-media',
].join(' ');
