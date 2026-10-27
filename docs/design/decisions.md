# Decisions

The reasons behind the system, one per entry. A decision is changed by adding a new
entry that supersedes, narrows or extends it, not by editing the old one's conclusion;
the old entry's status line names the entry that changed it.

Source paths are relative to `apps/frontend/src` and test paths to `apps/frontend`.

## 1. Flat, because native ports must not have to undo anything

**Status:** accepted · **Replaces:** the glass-and-gradient look.

The previous interface leaned on translucency (`backdrop-blur` on 33 elements), a
mango gradient on the primary button, coloured glow shadows and `shadow-2xl` on
dialogs and the composer. None of that has a WinUI 3 or libadwaita counterpart that
looks the same, so each native screen would have either faked the effect or visibly
disagreed with the web one. Solid surfaces separated by a hairline are the common
denominator, and they are also easier on the eyes over an eight-hour session.

**Consequence:** no gradient, no `backdrop-filter`, no coloured shadow. The conformance
test rejects them. Only surfaces that float cast a shadow, and only one of two neutral
ones (`shadow-popover`, `shadow-dialog`); every other shadow utility is rejected too.
The logo (an illustrated mango, `assets/logo.png`) is the one non-flat asset; a flat
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
by side at different radii. The rule is by role: 6px (`rounded-sm`) for anything
clickable, 8px (`rounded-md`) for containers, 12px (`rounded-lg`) for large surfaces,
4px (`rounded-xs`) for miniatures, and `rounded-full` only for status marks and round
glyphs (dots, badges, the radio, the switch), never for a button, chip or row. The
theme empties Tailwind's own radius scale, so a leftover `rounded-2xl` compiles to a
square corner instead of quietly keeping a size, and the conformance test rejects it.

## 4. Inter and JetBrains Mono; Manrope removed

**Status:** accepted.

Three families (Manrope for headings, Inter for body, JetBrains Mono) became two. Inter
is the basis of Adwaita Sans and sits next to Segoe UI Variable without clashing, so a
native build can swap in the system font with the same scale. Headings use Inter at 600. This also drops a font file from the bundle and a preload from `index.html`.

## 5. A 32px control, a 48px header

**Status:** accepted.

Controls were 36–42px depending on the file, and the header was 12px or 16px of
vertical padding depending on the breakpoint. 32px is WinUI's control height and within
two pixels of libadwaita's; 28px is the compact step and 40px is reserved for the main
action of a screen. In `Button` these are the `md`/`icon` (32px), `sm`/`icon-sm` (28px)
and `lg` (40px) sizes. Underline tabs are the one 36px row (`h-9`). The header is a
fixed 48px, and the sidebar's brand row matches it so the two share a baseline.

## 6. Text floor of 11px, no faded text

**Status:** accepted · **Narrowed by:** 26, for the context ring's figure.

About 200 text elements were 10px and several were 9px or 8px; secondary text was
produced by fading (`text-on-surface-variant/40`), which fell to roughly 2:1. The
smallest size is now `text-micro` (11px) for mono metadata and group labels, `text-xs`
(12px) for running text, and the three text colours are fixed tokens that each clear
4.5:1 on every surface. Avatar monograms inside 16–24px tiles are glyphs rather than
running text and are an explicit, documented exception.

## 7. Send is always the accent

**Status:** accepted · **Replaces:** a send button coloured by the runner.

The composer wore the runner's colour on its frame _and_ its Send button, which needed
a per-theme `color-mix` darkening to clear 4.5:1 with white text. The runner's identity
(`--composer-accent`, set from `features/chat/lib/composer-accent.ts`) still shows on
the focused border, the prompt mark, the caret, the runner chip and the leading glyph of
a pressed tool chip; Send is the product's primary action and is always `accent`. One
primary action, one colour.

## 8. Neutral interaction, accent only for "primary" and "current"

**Status:** accepted · **Narrowed by:** 22, for `subtle-danger`'s hover.

Hover and selection on menus, lists and the sidebar used to tint toward the accent
(`hover:bg-primary/10 hover:text-primary`). Hover and pressed are now neutral
translucent washes (`fill-hover`, `fill-pressed`, `fill-selected`), and the accent
appears only on the primary button, the current-page bar, checked controls and focus.
It keeps the accent meaningful and matches how native lists behave.

## 9. Underline tabs

**Status:** accepted.

Tab strips drew a folder-shaped tab with a tinted fill and an underline. The underline is
now the only mark of the current tab (`SelectorBar` / `AdwViewSwitcher`): a 2px
`accent` rule on the strip's divider. `Tabs` (buttons) and `TabNav` (router links) draw
it from the same `TAB_CLASSES` in `components/ui/Tabs.tsx`, so the two strips cannot
drift apart.

## 10. Disabled buttons turn grey

**Status:** superseded in part by 14, for `subtle` and `subtle-danger`; still accepted
for `primary`, `secondary` and `danger`.

A disabled primary button was the mango faded to 50%, which reads as a different,
dimmer brand colour. Disabled buttons are neutral (`fill-selected` + `fg-subtle`) in
every variant, as native controls draw them. A button that is only _loading_ keeps its
colour and shows a spinner.

## 11. One focus ring

**Status:** accepted.

Controls drew their own focus treatments (a ring in one place, a border in another, an
`outline-offset` in a third). `:focus-visible` now draws one 2px `focus` outline with a
2px offset globally, and components do not draw their own ring. Text fields and Select
triggers are the exception: they drop the outline and turn their own border `focus`
with a 1px ring (`focus:outline-none focus:border-focus focus:ring-1 focus:ring-focus`),
so the focus mark sits on the field's edge. A few places move the same ring rather than
draw another: underline tabs pull it inward (`-outline-offset-2`) so the scrolling strip
does not clip it, the slider draws it on its thumb, a control whose focused element
is hidden inside the box it draws (`Toggle`, `PickOneRow`, a radio segment, a composer
chip around its `<select>`) draws it on that box, and a control on `scrim-media` draws
it in `on-scrim-media` (decision 23).

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

## 14. Disabled quiet buttons keep no fill

**Status:** accepted · **Supersedes:** 10, for `subtle` and `subtle-danger`.

Decision 10 turned every disabled button into the neutral `fill-selected` tile. For a
`subtle` button that is the wrong picture: `fill-selected` is also the selected and
the hovered fill, so a disabled icon button in a row of flat ones (the Repository
row's up arrow in Settings › General's side-panel order, beside its enabled siblings)
became the most prominent control in the row, and looked current. Native toolbar and
flat buttons draw "disabled" as grey text with no tile, because they never had one to
begin with.

**Consequence:** `primary`, `secondary` and `danger` still turn into the grey tile; a
disabled `subtle` or `subtle-danger` button keeps no fill and only turns its text
`fg-subtle`, overriding a call site's own `text-danger`. A button that is loading is
still untouched (`aria-busy`). A split button follows the same rule through its
halves: while the primary half is the grey tile, the chevron is `secondary`.

## 15. Touch targets are 44px, except where a control draws its own box

**Status:** accepted.

On a coarse pointer, buttons, links, `[role="button"]`, selects, textareas and text
inputs get a 44px `min-height` and `min-width`; the 32px rhythm in the foundations is
the fine-pointer contract. The rule is unlayered on purpose, so a utility on a menu
row cannot undo an accessibility floor, and for the same reason it has to name what it
must not touch.
It first applied to every `input`, which drew the 16px checkbox and radio as empty
44px squares, the slider as a 44px bar, and the copy button over the first lines of
a code block.

**Consequence:** checkbox, radio and switch inputs, range inputs, the code block's
copy button and links inside markdown prose are exempt. `Checkbox` and `Radio` keep
their 16px drawing and widen the hit area to 40px with a pseudo-element on the input;
a row that wraps one in a `<label>` is its own 44px target (`pointer-coarse:min-h-11`).
The sliders keep their 6px track; a taller one is a restyle of the track, not a
`min-height`. The timeline raises `--timeline-row-height` to 44px on a coarse pointer,
so its nodes stay centred on rows the floor made taller.
`tests/unit/stylesheet-cascade.test.ts` pins the exemptions and the timeline height.

## 16. A selected segment is neutral, with the accent as a bar

**Status:** accepted.

`SettingsSegmented` drew the selected segment as an accent-filled button
(`bg-accent text-on-accent`), which is exactly the primary `Button`. On the Prompts
page that put four mango buttons on screen at once, two per rule file, and in the Add
server dialog the `stdio` segment and Save were the same orange, so the real primary
no longer stood out. Decision 8 already says the accent appears only on the primary
button, the current item, checked controls and focus; a selected segment is the
_current item_, not a call to action.

**Consequence:** the selected segment is `fill-selected` with a `stroke-strong` border
and `fg`, and the accent is a 2px bar on its bottom edge, the same mark as the
underline tab (decision 9). The unselected segments are `control` with `fg-muted`
text. A bar rather than a check, because a check changes the segment's width when the
choice moves and the bar does not; the fill alone would not survive a grayscale screen,
which is why the segment pairs it with the accent (the same reasoning as
`SELECTION_BAR` in `components/ui/selection-bar.ts`, the leading-edge bar of a vertical
list). Every call site changes with the one component.

## 17. A disabled menu row whose name is information steps down a colour, it does not fade

**Status:** accepted · **Narrows:** the State bullet in `foundations.md`, for menu rows ·
**Narrowed by:** 18 · **Extended by:** 21.

The State section drops "other disabled controls" to 50% opacity, and the model menu
and the runner menu followed it: a model tied to another provider, a runner this
machine cannot use, faded as a whole row. Sampled, the names fell to about 3.4:1 in
light and 4.2:1 in dark, under the 4.5:1 floor that principle 4 and decision 6 set for
text. That is fine for a control that is merely off (WCAG exempts it), but not here:
these names are the content. They say which providers and agents exist, and the row
is the only place that says why they are out of reach.

**Consequence:** a disabled menu row keeps its icon and its `cursor-not-allowed`, and
its name goes from `fg` to `fg-muted`, the way `PermissionSelector`'s refused pair
already reads. Nothing is faded. The reason is written down once per menu, not once
per row: a `text-xs fg-muted` line at the head of the model list names the provider
the chat is tied to, and the runner menu keeps the explanation line under each row.
Every other disabled control (field, select, checkbox, switch, composer chip) keeps
the 50% rule: a control that is off carries no information of its own.

## 18. A chip locked by the chat's history states a fact; it does not fade

**Status:** accepted · **Narrows:** 17, for the composer chips it lists, and the State bullet
in `foundations.md`.

Decision 17 left "composer chip" under the 50% rule, and the agent chip and the
environment chip both followed it once a chat had turns. Sampled, the environment chip's
`env:` key fell to 2.3:1 in light and its value to 3.3:1, and a chevron still promised a
menu that could not open. But what the chip says — which machine this chat ran on, who
answered it — is content, the same kind of information decision 17 protects in a menu row.
It is not a control that happens to be off.

**Consequence:** a chip whose answer is settled by the chat's first turn is a `LockedChip`
(`components/ui/`): key in `fg-muted`, value in `fg`, no chevron, the reason as its `title`
and as screen-reader text. `EnvironmentSelector` takes a `locked` flag (a fact) apart from
`disabled` (loading or failed, which still fades). It also draws a `LockedChip` when the
current environment is the only one, since there is nothing to choose; the reason then
says so. The 50% rule stays for a chip that is merely off.

## 19. Dark `control` steps above `surface-raised`, and the text on it follows

**Status:** accepted.

Dark `control` (`#2a2723`) sat on `surface-raised` (`#282521`) at 1.03:1, so inside a dialog
a field's fill and the dialog body were the same grey and the field read as an outline with
an underline. On `surface` (General, Context) the same fill stepped visibly, which made
dialogs look flatter than pages. The fill cannot be a translucent wash: it also sits over
code blocks and under the copy button, and a floating or overlaid control must stay solid.

**Consequence:** dark `control` is `#2f2c27` and `control-hover` `#37342e`, one step above the
dialog body; `control-pressed` takes the old resting value, one step darker. A lighter fill
costs the lines and text drawn on it, so dark `stroke-strong` rises to `#857f73` (3:1 on
`control` and its hover) and dark `fg-subtle` to `#a29b91` (placeholders stay above 4.5:1 on
`control` and `control-hover`), with dark `fg-muted` at `#b0a99e` so it stays a clear step
above. All three only get lighter on a dark surface, so nothing else loses contrast.

## 20. The light warning wash is amber

**Status:** accepted.

Light `warning-subtle` was the first light `warning` text colour, `#b45309`, at 10%
(`#b453091a`); the text colour has since darkened to `#92400e`. Over `canvas` that wash is
RGB(239, 228, 216), against `danger-subtle`'s (242, 228, 223): a sign-in warning and a failure
were the same blush, told apart only by a 16px glyph. Deepening the fill was not an option
(`fg-subtle` on the band was 4.6:1, with no headroom).

**Consequence:** the wash is amber, `#ffbf00` at 16% (`#ffbf0029`), which is both more yellow
and lighter, so `fg-subtle`, `accent-fg` and the `warning` text all gain contrast on it. The dark
theme was already a yellow wash.

## 21. Where a disabled control still says something, its text steps down; it does not fade

**Status:** accepted · **Extends:** 17, to `PickOneRow`.

Decision 17 kept opacity for "every other disabled control", and `PickOneRow` followed
it: a WSL distribution another environment already owns faded as a whole row, and
onboarding's "Choose who answers" faded a signed-out CLI's identity dot. Those rows are
the same case as 17's menu rows. The name says what exists, and a signed-out CLI is the
one row the person has to act on, so it must stay readable.

**Consequence:** the test is whether the disabled thing carries information. If it does,
a muted text colour does the job opacity used to do: a disabled `PickOneRow` keeps its
glyph, steps its name from `fg` to `fg-muted`, loses its hover, cannot be focused, and
shows `cursor-not-allowed`. The runner menu, already under 17, also keeps each disabled
row's identity dot at full strength. Code comments that apply this rule cite decision
17, where the reasoning lives. A control that is merely off (`Input`, `Select`,
`Checkbox`, `Radio`, `Toggle`, `ChipSelect`, a plain `MenuItem`, `Chip`) still drops to
50%, and buttons follow 10 and 14, which use colour, not opacity.

## 22. `subtle-danger` rests in `fg-muted` and turns `danger` when reached

**Status:** accepted · **Replaces:** `subtle-danger` with `danger` text at rest.
**Narrows:** 8 and the Hover bullet in `foundations.md`, for this one variant.

`subtle-danger` first drew its text in `danger` at rest. It is the variant for a
destructive action that is not the final confirmation (Remove on a rule, the trash can
on a sidebar row), so it repeats down a list. A list whose every row ends in a red trash
can is a column of red that outshouts the rows, and it spends `danger`, a status colour,
on something that has not happened.

**Consequence:** at rest it is `fg-muted`, like any quiet row action. On hover, keyboard
focus (`focus-visible`, not `focus`, so a mouse click does not leave the row tinted) and
press, its text turns `danger` on a `danger-subtle` fill. This is the one hover that
changes hue, an exception both to the Hover bullet (a hover changes the fill, and at
most steps muted text up to `fg`) and to decision 8's neutral hover: the colour appears
when the action is about to happen. Disabled, it follows 14. A call site never builds it
from `subtle` plus `text-danger`.

## 23. Controls on a picture use unthemed tokens

**Status:** accepted.

The gallery lightbox's Close and a tile's download sat on the `scrim-media` veil wearing
`secondary`. The veil is the same black in both themes, because a photograph is not
themed, but `secondary`'s `control` fill follows the theme: in the light theme it drew a
bright white tile on near-black, the brightest thing on screen after the picture, while
the dark theme drew a quiet tile. The theme's `focus` ring, a dark brown in light, all
but vanished on the veil. Writing `bg-white/16` instead is what the conformance test
rejects, and `color-mix()` in a stylesheet is what 13 rejects.

**Consequence:** `scrim-media`, `on-scrim-media`, `fill-media-hover` and
`fill-media-pressed` have the same value in both themes. A control on the veil is a
`subtle` button plus `MEDIA_CONTROL_CLASS`
(`features/gallery/components/media-control.ts`): an `on-scrim-media` glyph and focus
outline, `fill-media-*` for hover and press. The lightbox's Download stays `primary`,
with the same `on-scrim-media` outline. Text on a picture sits on `scrim-media`, never on
`bg-black/…`.

## 24. No arbitrary colour values in class strings

**Status:** accepted · **Extends:** 2 ("a tint is a token") to arbitrary values.

Tailwind accepts any colour in brackets: `bg-[#f5a623]`, `text-[rgb(…)]`,
`border-[var(--color-accent)]`, `bg-[color-mix(…)]`. Each one is a colour no token
records. It does not change with the theme, `design-token-contrast.test.ts` never sees
it, and a `color-mix()` in a class goes through the same downlevelling 13 describes.
The token list in `foundations.md` is only a contract if it is the only way to name a
colour.

**Consequence:** the conformance test rejects a colour utility whose value is a bracket
starting with `color:`, `#`, `rgb(`, `rgba(`, `hsl(`, `hsla(`, `oklch(`, `color-mix(` or
`var(--color-` in any `.ts` or `.tsx` file. A tint the design needs is a token in
`index.css` and a row in `foundations.md`. The same test already rejects raw palette
colours (`text-red-500`) and raw `black` / `white` overlays, and the theme empties
Tailwind's palette (`--color-*: initial`), so a palette class compiles to nothing.

## 25. Toasts stack top-right

**Status:** accepted · **Replaces:** a bottom-right stack.

The stack sat in the bottom-right corner, over the composer's Send button and the
workspace panel's file list. A toast holds while the pointer is over it, so reaching
for Send kept it there. The bottom corner is where a region's primary action lives; the
top-right of a page is margin or a panel's heading.

**Consequence:** the stack is fixed at `top-16 right-4`, 16px under the 48px header,
360px wide and never wider than the screen. It still dismisses after 4s and pauses while
the pointer or focus is on it.

## 26. The context ring's figure is a glyph, like an avatar monogram

**Status:** accepted · **Narrows:** 6.

Decision 6 named avatar monograms as the one text under 11px. The percentage drawn
inside the 20px `ContextRing` of a sidebar row is the same kind of thing: a figure that
belongs to the drawing, not running text. It carries the value at low percentages, where
the arc is only a dot.

**Consequence:** the figure is 8px, semibold, in `fg` rather than a muted colour, since
muted text that small is not readable. `ContextRing.tsx` is the second entry in the
conformance test's `ALLOWED` list for the type-scale rule, with that reason. The
composer, which has room, passes `showValue={false}`: the ring drops to a 16px glyph and
the figure is printed beside it at 12px instead.
