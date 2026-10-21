# Migration and conformance

How the codebase moved from the Material-style, glass-and-gradient vocabulary to the
flat one, how to keep it there, and how to add a deliberate exception.

## Old → new

| Old (Tailwind utility suffix)                                | New                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| `background`, `surface`, `surface-dim`                       | `canvas`                                                           |
| `surface-container-low` (the sidebar)                        | `sidebar`                                                          |
| `surface-container`, `-low`, `-high` (cards, panels)         | `surface`                                                          |
| `surface-container-lowest` (fields, chips)                   | `control`                                                          |
| `surface-container-highest`                                  | `fill-selected` (resting) · `fill-hover` (hover)                   |
| `hover:bg-surface-container-*`                               | `hover:bg-fill-hover`                                              |
| `outline-variant` (+ `/10` … `/60`)                          | `stroke`                                                           |
| `outline`                                                    | `stroke-strong`                                                    |
| `on-surface`, `on-background`                                | `fg`                                                               |
| `on-surface-variant` (+ `/60`, `/70`, `/80`)                 | `fg-muted`                                                         |
| `on-surface-variant/40`, `/50`, `on-surface/30`              | `fg-subtle`                                                        |
| `primary` as a fill                                          | `accent`                                                           |
| `primary` as text or an icon                                 | `accent-fg`                                                        |
| `primary/5` … `/30`, `primary-container`, `accent-muted`     | `accent-subtle`                                                    |
| `focus:border-primary…`, `ring-primary…`, `outline-primary`  | `focus`                                                            |
| `on-primary`                                                 | `on-accent`                                                        |
| `error`, `on-error`                                          | `danger`, `on-danger` (`danger-solid` for a solid button)          |
| `error/5` … `/30`                                            | `danger-subtle`                                                    |
| `warning/…`, `success/…` (tints)                             | `warning-subtle`, `success-subtle`                                 |
| `tertiary`                                                   | `info`                                                             |
| `bg-background/80`, `bg-black/60` (overlays)                 | `bg-scrim`                                                         |
| `glass-panel`, `glass-elevated`, `.dropdown-panel` (blurred) | `surface-raised` + `stroke` + `shadow-popover` (`.dropdown-panel`) |
| `font-headline`, `font-body`, `font-label`                   | `font-sans` (the default — drop the class)                         |
| `rounded-xl`, `rounded-lg`                                   | `rounded-md` (container) or `rounded-sm` (clickable)               |
| `rounded-2xl`, `rounded-3xl`                                 | `rounded-lg`                                                       |
| `shadow-2xl`, `shadow-lg` …                                  | `shadow-dialog` / `shadow-popover`, or none                        |
| `text-[10px]`, `text-[11px]`                                 | `text-micro` (mono metadata, group labels) or `text-xs`            |
| `text-lg`, `text-xl` …                                       | `text-base`, `text-title`, `text-headline`                         |
| `font-bold`                                                  | `font-semibold` (titles) or `font-medium` (labels, buttons)        |
| `uppercase tracking-widest`                                  | sentence case, or `micro-label` for a group heading                |
| `variant="ghost"` on `Button`                                | `variant="subtle"`                                                 |
| `<Card variant="solid" \| "glass">`                          | `<Card>`                                                           |

## The conformance test

`apps/frontend/tests/unit/design-system-conformance.test.ts` reads every file under
`apps/frontend/src` as text and fails with `file:line  offender  ← rule` for:

- the retired colour, glass, gradient and font vocabulary (comments included, because a
  comment describing a removed token is stale documentation);
- radii outside `xs/sm/md/lg/full` — the theme empties the rest, so they compile to
  nothing;
- shadows other than `shadow-popover` / `shadow-dialog`;
- type sizes outside `text-micro/xs/sm/base/title/headline`;
- `font-bold` and friends, `uppercase`, `tracking-wide(r|st)`;
- opacity modifiers on semantic colours, and raw `black` / `white` overlays;
- `scale-*` and `transition-all`;
- an `EmptyState` whose icon has a literal `size={24}` instead of `ICON_LG`;
- `2.5` / `3.5` spacing steps.

**Adding an exception.** Put the file and the rule's message in `ALLOWED` in the test,
with the reason. An exception without a reason will not pass review. The only one today
is the tool-avatar monogram sizes: a glyph inside a 16–24px tile, not running text.

**Changing the vocabulary.** Update `index.css`, then [`foundations.md`](./foundations.md)
(`tests/unit/design-tokens-doc.test.ts` fails when the colour table and the stylesheet
disagree), then the rule, then add an entry to [`decisions.md`](./decisions.md).

## Dead weight removed

- `.glass-panel`, `.glass-elevated`, `--glass-*`, `--gradient-primary`.
- The Manrope font file, its `@font-face` and its preload.
- `skeleton-shimmer` (a gradient animation) in favour of a pulse.
- The `Card` `variant` prop, `Button`'s `ghost` name and every `color-mix()` in the
  stylesheets.
- The composer's seven derived `--composer-*` tints, `--composer-send-fill` and the
  runner-tinted status band.
