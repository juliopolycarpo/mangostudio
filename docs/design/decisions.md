# Decisions

The reasons behind the system, one per entry. A decision is changed by adding a new
entry that supersedes it, not by editing the old one's conclusion.

## 1. Flat, because native ports must not have to undo anything

**Status:** accepted · **Replaces:** the glass-and-gradient look.

The previous interface leaned on translucency (`backdrop-blur` on 33 elements), a
mango gradient on the primary button, coloured glow shadows and `shadow-2xl` on
dialogs and the composer. None of that has a WinUI 3 or libadwaita counterpart that
looks the same, so each native screen would have either faked the effect or visibly
disagreed with the web one. Solid surfaces separated by a hairline are the common
denominator, and they are also easier on the eyes over an eight-hour session.

**Consequence:** no gradient, no `backdrop-filter`, no coloured shadow. The conformance
test rejects them. The logo (an illustrated mango) is the one non-flat asset; a flat
mark is a brand decision and is still open.

## 2. Semantic tokens, named for roles

**Status:** accepted · **Replaces:** the Material-style `surface-container-*`,
`on-surface`, `primary` names.

The old names did not say what they were for: `surface-container-high` was a card in
one file, an input in another and a hover fill in a third, and 40+ opacity variants
(`/10` … `/60`) approximated everything between them. The new tokens are roles
(`canvas`, `surface`, `control`, `fill-hover`, `stroke`, `fg-muted`), each with one
meaning and a documented WinUI / libadwaita counterpart. Opacity modifiers on them are
rejected; a tint is a token.

**Consequence:** about 3,500 class occurrences were migrated mechanically and then
reviewed by area; the old names are banned so they cannot return.

## 3. Four radii, one rule

**Status:** accepted.

Seven radii were in use (`rounded-sm` … `rounded-3xl`), and fields and Selects sat side
by side at different radii. The rule is by role: 6px for anything clickable, 8px for
containers, 12px for large surfaces, 4px for miniatures, a pill for status only. The
theme empties Tailwind's own radius scale so a leftover `rounded-2xl` fails visibly
instead of quietly keeping a size.

## 4. Inter and JetBrains Mono; Manrope removed

**Status:** accepted.

Three families (Manrope for headings, Inter for body, JetBrains Mono) became two. Inter
is the basis of Adwaita Sans and sits next to Segoe UI Variable without clashing, so a
native build can swap in the system font with the same scale. Headings use Inter at
600. This also drops a font file from the bundle and a preload from `index.html`.

## 5. A 32px control, a 48px header

**Status:** accepted.

Controls were 36–42px depending on the file, and the header was 12px or 16px of
vertical padding depending on the breakpoint. 32px is WinUI's control height and within
two pixels of libadwaita's; 28px is the compact step and 40px is reserved for the main
action of a screen. The header is a fixed 48px, and the sidebar's brand row matches it
so the two share a baseline.

## 6. Text floor of 11px, no faded text

**Status:** accepted.

About 200 text elements were 10px and several were 9px or 8px; secondary text was
produced by fading (`text-on-surface-variant/40`), which fell to roughly 2:1. The
smallest size is now `text-micro` (11px) for mono metadata and group labels, `text-xs`
(12px) for running text, and the three text colours are fixed tokens that each clear
4.5:1 on every surface. Avatar monograms inside 16–24px tiles are glyphs rather than
running text and are an explicit, documented exception.

## 7. Send is always the accent

**Status:** accepted · **Replaces:** a send button coloured by the runner.

The composer wore the runner's colour on its frame *and* its Send button, which needed
a per-theme `color-mix` darkening to clear 4.5:1 with white text. The runner's identity
still shows on the focused border, the prompt mark, the caret and the runner chip; Send
is the product's primary action and is always `accent`. One primary action, one colour.

## 8. Neutral interaction, accent only for "primary" and "current"

**Status:** accepted.

Hover and selection on menus, lists and the sidebar used to tint toward the accent
(`hover:bg-primary/10 hover:text-primary`). Hover and pressed are now neutral
translucent washes (`fill-hover`, `fill-pressed`, `fill-selected`), and the accent
appears only on the primary button, the current-page bar, checked controls and focus.
It keeps the accent meaningful and matches how native lists behave.

## 9. Underline tabs

**Status:** accepted.

Tab strips drew a folder-shaped tab with a tinted fill and an underline. The underline is
now the only mark of the current tab (`SelectorBar` / `AdwViewSwitcher`).

## 10. Disabled buttons turn grey

**Status:** accepted.

A disabled primary button was the mango faded to 50%, which reads as a different,
dimmer brand colour. Disabled buttons are neutral (`fill-selected` + `fg-subtle`) in
every variant, as native controls draw them. A button that is only *loading* keeps its
colour and shows a spinner.

## 11. One focus ring

**Status:** accepted.

Controls drew their own focus treatments (a ring in one place, a border in another, an
`outline-offset` in a third). `:focus-visible` now draws one 2px `focus` outline with a
2px offset globally. Text fields add a border change; nothing else draws its own ring.

## 12. A `Callout` for inline notices

**Status:** accepted.

Notices were assembled per file from `border-warning/35 bg-warning/5` and similar. A
single component draws them: a tinted band, a status glyph and ordinary text, so tone is
never carried by a coloured border or coloured words.

## 13. No `color-mix()` in the stylesheets

**Status:** accepted.

The bundler downlevels `color-mix()` and re-emits only the first mixed declaration of
each rule, which had already shipped two bugs that no gate noticed. Every tint the design
needs is now a token, so the stylesheets author no `color-mix()` at all.
`tests/unit/stylesheet-downlevel.test.ts` keeps it that way.
