# Foundations

The tokens behind the flat design: colour, type, space, radius, elevation, state,
motion and icons. Every value lives in [`apps/frontend/src/index.css`](../../apps/frontend/src/index.css):
`@theme static` holds the dark theme, which is the default, and `[data-theme="light"]`
overrides it. Every utility named here is the class you write.
[`README.md`](./README.md) says why the system is shaped this way;
[`components.md`](./components.md) says how the pieces use these tokens.

## Colour

Tokens are named for the **role** they play, never for the value they happen to
hold. A native port maps each role to the platform resource that plays it (see
[`native-ports.md`](./native-ports.md)); a hex value would have no such mapping.

The theme empties Tailwind's own palette (`--color-*: initial`), so `bg-amber-500`
or `text-blue-400` compiles to nothing. `transparent` and `currentColor` still work.

Rules that hold across all of them:

- Text, icons and marks that carry meaning clear the contrast floor in **both**
  themes: 4.5:1 for text, 3:1 for control lines, focus rings and glyphs.
- A tint is a token (`*-subtle`, `fill-*`), never an opacity modifier. Writing
  `bg-accent/10` is rejected by the conformance test, and so is an arbitrary colour
  in a class (`bg-[#…]`, `text-[rgb(…)]`, `border-[var(--color-…)]`,
  `bg-[color-mix(…)]`; [decision 24](./decisions.md)), a raw palette colour
  (`text-red-500`) and a raw `black` or `white` overlay (`bg-black/50`). The
  stylesheets author no `color-mix()` either ([decision 13](./decisions.md)).
- Status colours always travel with an icon or a word. Colour alone is not a
  signal.
- The accent is the only hue in the interface. The `agent-*` colours identify
  runners and nothing else.

The tables below are the colour contract: `tests/unit/design-tokens-doc.test.ts`
fails if a token is missing here, listed here but gone from `index.css`, or has a
different value in either theme.

### Surfaces

| Token            | Utility             | Dark      | Light     | Use                                                                                                                                                  |
| ---------------- | ------------------- | --------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canvas`         | `bg-canvas`         | `#151311` | `#f6f4f0` | The window and the main content area (chat, settings). The header shares it, so there is no darker strip.                                            |
| `sidebar`        | `bg-sidebar`        | `#1b1916` | `#eeebe5` | The sidebar. One step off `canvas`, closed by a `stroke` line.                                                                                       |
| `surface`        | `bg-surface`        | `#1f1d1a` | `#ffffff` | Cards, section panels, the composer, tool blocks. Always with a `stroke` border, never a shadow.                                                     |
| `surface-raised` | `bg-surface-raised` | `#282521` | `#ffffff` | Things that float: menus, listboxes, popovers, dialogs, toasts, the command palette. With `shadow-popover` or `shadow-dialog` and a `stroke` border. |

### Controls and interaction fills

| Token             | Utility              | Dark        | Light       | Use                                                                                                                                                                                                                                                                                    |
| ----------------- | -------------------- | ----------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `control`         | `bg-control`         | `#2f2c27`   | `#ffffff`   | Fill of text fields, Select triggers, secondary buttons, unselected segments, checkbox and radio boxes, the switch and slider tracks, keycaps, the code block's copy button. One step above `surface-raised`, so a field in a dialog is still a field ([decision 19](./decisions.md)). |
| `control-hover`   | `bg-control-hover`   | `#37342e`   | `#f7f5f1`   | The same controls under the pointer.                                                                                                                                                                                                                                                   |
| `control-pressed` | `bg-control-pressed` | `#2a2723`   | `#f0ede7`   | Secondary button while pressed. One step darker than `control` in both themes.                                                                                                                                                                                                         |
| `fill-hover`      | `bg-fill-hover`      | `#fff5e60f` | `#2a1e0a0d` | Hover for anything with no fill of its own: subtle buttons, menu items, sidebar rows, list rows, idle tabs, chips.                                                                                                                                                                     |
| `fill-pressed`    | `bg-fill-pressed`    | `#fff5e608` | `#2a1e0a08` | Pressed state of the `fill-hover` family. A thinner wash than `fill-hover` in both themes.                                                                                                                                                                                             |
| `fill-selected`   | `bg-fill-selected`   | `#fff5e614` | `#2a1e0a12` | The current item in navigation and lists, an open or pressed chip, inline code, the disabled filled button, skeletons, the neutral `Badge` and `Callout`. Neutral on purpose: the `accent` bar carries the colour.                                                                     |

### Lines

| Token           | Utility                | Dark      | Light     | Use                                                                                                                                                                                                         |
| --------------- | ---------------------- | --------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stroke`        | `border-stroke`        | `#35312b` | `#e3ded5` | Decorative hairline: card and surface borders, dividers, the sidebar edge, the header's bottom border. The default colour of a bare `border`.                                                               |
| `stroke-strong` | `border-stroke-strong` | `#857f73` | `#8a8478` | The line that identifies a control: a field's bottom border, checkbox and radio boxes, the switch and slider tracks, the timeline rail, scrollbar thumbs. At least 3.1:1 on every surface and on `control`. |

### Text

| Token       | Utility          | Dark      | Light     | Use                                                                                                                                                                           |
| ----------- | ---------------- | --------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fg`        | `text-fg`        | `#ece7df` | `#1e1b16` | Primary text and active icons.                                                                                                                                                |
| `fg-muted`  | `text-fg-muted`  | `#a8a196` | `#5a554c` | Secondary text, descriptions, the key half of a chip, resting icons, the resting `subtle-danger` button. At least 5.4:1 on every surface and on `control`.                    |
| `fg-subtle` | `text-fg-subtle` | `#9c958a` | `#6b655b` | Placeholders, timestamps, metadata, hints, `.micro-label`. At least 4.6:1 on every surface and on `control`. It is the floor for text: never fade text with opacity below it. |

### Accent (mango)

| Token            | Utility             | Dark        | Light       | Use                                                                                                                                                                                   |
| ---------------- | ------------------- | ----------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accent`         | `bg-accent`         | `#f5a623`   | `#f0a020`   | Fill of the primary button, a checked switch, checkbox or radio, the slider's travelled track and thumb, the current-item bar, the streaming caret. Text on it is always `on-accent`. |
| `accent-hover`   | `bg-accent-hover`   | `#f7b44a`   | `#f2ad3c`   | Primary button and checked boxes under the pointer.                                                                                                                                   |
| `accent-pressed` | `bg-accent-pressed` | `#e0961a`   | `#e09114`   | Primary button while pressed; the divider inside a primary split button.                                                                                                              |
| `on-accent`      | `text-on-accent`    | `#241600`   | `#241600`   | Text and icons on `accent` (8.2:1 or better). Dark in both themes so the mango stays orange in light mode.                                                                            |
| `accent-fg`      | `text-accent-fg`    | `#f5a623`   | `#8f5a00`   | Mango as text or an icon on a surface: links, a menu item's check, drop hints, the active timeline bead. 4.8:1 or better.                                                             |
| `accent-subtle`  | `bg-accent-subtle`  | `#f5a62324` | `#f5a62329` | A mango wash for a quiet active state: the drop hint, an accent badge, selected text.                                                                                                 |
| `focus`          | `outline-focus`     | `#f5a623`   | `#8f5a00`   | The keyboard focus ring: 2px, offset 2px, on every control. 4.8:1 or better on every surface.                                                                                         |

### Status

| Token            | Utility             | Dark        | Light       | Use                                                                                      |
| ---------------- | ------------------- | ----------- | ----------- | ---------------------------------------------------------------------------------------- |
| `success`        | `bg-success`        | `#4ade80`   | `#166534`   | Text and icon for success. Always with an icon or a word.                                |
| `success-subtle` | `bg-success-subtle` | `#4ade801f` | `#15803d1a` | Fill of a success badge or callout.                                                      |
| `warning`        | `bg-warning`        | `#ffd166`   | `#92400e`   | Text and icon for attention. Always with an icon or a word.                              |
| `warning-subtle` | `bg-warning-subtle` | `#ffd1661f` | `#ffbf0029` | Fill of a warning badge or callout. Amber in both themes.                                |
| `danger`         | `bg-danger`         | `#f87171`   | `#c42b1c`   | Text and icon for errors, and the error status dot. Always with an icon or a word.       |
| `danger-subtle`  | `bg-danger-subtle`  | `#f871711f` | `#c42b1c14` | Fill of an error badge or callout; hover of a destructive menu item and `subtle-danger`. |
| `danger-solid`   | `bg-danger-solid`   | `#c42b1c`   | `#c42b1c`   | Fill of the destructive button (delete, revoke). Always with `on-danger`.                |
| `on-danger`      | `text-on-danger`    | `#ffffff`   | `#ffffff`   | Text on `danger-solid` (5.7:1).                                                          |
| `info`           | `bg-info`           | `#7cb8ff`   | `#1f63c4`   | Text and icon for neutral information and notes.                                         |
| `info-subtle`    | `bg-info-subtle`    | `#7cb8ff1f` | `#1f63c414` | Fill of an info badge or callout.                                                        |

Light `success` and `warning` are darker than a plain white page needs, because
text in them is also read on its own tint over `canvas`, `sidebar` and `surface` (a
badge, a diff line, a callout). `#166534` and `#92400e` keep 5:1 or better there;
the brighter `#15803d` / `#b45309` fell to about 4:1 on the tint.
`tests/unit/design-token-contrast.test.ts` holds every status colour to 4.5:1 on its
own tint.

The light `warning-subtle` is an amber wash (`#ffbf00` at 16%) rather than a thin copy of
the `warning` text colour. At 10% that copy came out the same blush as `danger-subtle`
over `canvas`, so a sign-in warning and a failure differed by their glyph alone; the amber
reads yellow beside the pink danger wash and is lighter, so `fg-subtle` (4.9:1) and
`accent-fg` (4.9:1) both clear 4.5:1 on it over `canvas`, and `warning` is 6.0:1
([decision 20](./decisions.md)).

### Overlay and identity

| Token                | Utility                 | Dark        | Light       | Use                                                                                                                                                                                                                                                                 |
| -------------------- | ----------------------- | ----------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scrim`              | `bg-scrim`              | `#0000008c` | `#1e1b1652` | The veil behind a dialog, the command palette or the mobile sidebar. A flat tint, never a blur.                                                                                                                                                                     |
| `scrim-media`        | `bg-scrim-media`        | `#000000b3` | `#000000b3` | The veil under text laid over a picture: a gallery tile's caption bar, the lightbox ground. The same in both themes, because a photograph is not themed. 70% black, so `on-scrim-media` holds 4.5:1 (8.6:1 over white) whatever the image.                          |
| `on-scrim-media`     | `text-on-scrim-media`   | `#ffffff`   | `#ffffff`   | Text, icons and the focus ring on `scrim-media`. White in both themes.                                                                                                                                                                                              |
| `fill-media-hover`   | `bg-fill-media-hover`   | `#ffffff29` | `#ffffff29` | Hover fill of a control laid on `scrim-media` (the lightbox's Close, a tile's download): `on-scrim-media` at 16%. Unthemed, like the veil. Applied through `MEDIA_CONTROL_CLASS` in `features/gallery/components/media-control.ts` ([decision 23](./decisions.md)). |
| `fill-media-pressed` | `bg-fill-media-pressed` | `#ffffff3d` | `#ffffff3d` | Pressed fill of a control on `scrim-media`: `on-scrim-media` at 24%.                                                                                                                                                                                                |
| `agent-mango`        | `bg-agent-mango`        | `#f5a623`   | `#a86400`   | MangoStudio's own runner: the dot, the composer border, the prompt mark. The light value is darkened to `#a86400` because the composer draws it as text on `surface` (4.7:1).                                                                                       |
| `agent-claude`       | `bg-agent-claude`       | `#e0836a`   | `#b9553a`   | Claude Code runner identity.                                                                                                                                                                                                                                        |
| `agent-codex`        | `bg-agent-codex`        | `#5cc8e8`   | `#1f7a99`   | Codex runner identity.                                                                                                                                                                                                                                              |
| `agent-cursor`       | `bg-agent-cursor`       | `#a78bfa`   | `#6d4fd8`   | Cursor runner identity.                                                                                                                                                                                                                                             |
| `agent-generic`      | `bg-agent-generic`      | `#8b8579`   | `#736d63`   | A runner with no identity of its own.                                                                                                                                                                                                                               |

`lib/agent-identity.ts` maps each runner to its token in two forms: a `bg-agent-*`
class for its dot (`dotClass`) and a `var(--color-agent-*)` reference (`colorVar`).
The `var()` form is read in inline styles (the composer accent through
`features/chat/lib/composer-accent.ts`, the turn separator), which Tailwind does not
scan. That is why the theme is `@theme static`: a plain `@theme` would drop those
tokens from the dark default.

### Which surface, which fill

```text
canvas          the window, the chat, a settings page
  sidebar       the sidebar, one step off canvas
  surface       a card, the composer, a tool block   (+ stroke border)
    control     a field or secondary button inside it
  surface-raised  a menu, dialog, toast, popover      (+ stroke border + elevation)
```

Hover, press and selection on anything *without* its own fill use the neutral
`fill-hover` / `fill-pressed` / `fill-selected` washes. They are translucent, so
they work on `canvas`, `sidebar` and `surface` alike. Hover never tints toward the
accent: the accent says "primary" or "current", not "pointer is here".

## Typography

One interface family and one mono, both self-hosted as variable fonts. The stacks
fall through to what the platform ships, so a native build reads in its own system
font with the same scale.

| Family                | Stack                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `font-sans` (default) | Inter → Segoe UI Variable Text → Segoe UI → Adwaita Sans → Cantarell → system-ui → sans-serif     |
| `font-mono`           | JetBrains Mono → Cascadia Mono → Adwaita Mono → ui-monospace → SFMono-Regular → Menlo → monospace |

The theme empties Tailwind's type scale, so only these six sizes exist: `text-lg`
compiles to nothing. The conformance test rejects it, and an arbitrary size such as
`text-[13px]` too.

| Utility         | Size / line      | Weight          | Use                                                                                       |
| --------------- | ---------------- | --------------- | ----------------------------------------------------------------------------------------- |
| `text-headline` | 28 / 36, −0.01em | 600             | One greeting per screen: the Home heading, an onboarding step title.                      |
| `text-title`    | 20 / 28          | 600             | Page and dialog titles; the large counts of a health summary.                             |
| `text-base`     | 16 / 24          | 600             | Section titles inside a page; large card headings.                                        |
| `text-sm`       | 14 / 20          | 400 · 500 · 600 | The default: fields, menu items, chat titles, message text. Button labels at 500.         |
| `text-xs`       | 12 / 16          | 400 · 500       | Descriptions, metadata, badges, toasts, `sm` buttons. The smallest size for running text. |
| `text-micro`    | 11 / 16          | 500             | The floor for text. Mono metadata, counters, and `.micro-label` group headings.           |

- Weights are 400 (text), 500 (labels, buttons, the current item) and 600 (titles):
  `font-medium` and `font-semibold`. There is no bold; `font-bold` and the light
  weights are rejected.
- Sentence case everywhere. The one upper-case is `.micro-label` (mono, 11px, 500,
  0.06em tracking, `fg-subtle`), applied by the class, never by `uppercase` or
  `tracking-*` on an element; the conformance test rejects `uppercase` and
  `tracking-wide` / `-wider` / `-widest` in source.
- Two glyphs drawn inside a tile sit under 11px, and they are the only entries in the
  conformance test's `ALLOWED` map: `ToolAvatar`'s monogram (8 to 10px in the small
  tiles) and the figure inside the 20px `ContextRing` (8px). Neither is running text
  ([decisions 6 and 26](./decisions.md)).
- The chat's own size is a preference: `--chat-font-size` (13, 14 or 16px) drives
  message bodies only (`.chat-message-body`).
- Mono is for content that is technical (`key: value` chips, paths, code, tool
  output) and for group labels. Titles, buttons and prose are never mono.
- `cn()` in `lib/utils.ts` knows the custom names (`text-micro`, `text-title`,
  `text-headline`, `shadow-popover`, `shadow-dialog`), so merging `text-title` with
  `text-danger` keeps both.

## Space

A 4px grid. Tailwind's own scale already is one; the system narrows it.

| Step  | px | Typical use                                                      |
| ----- | -- | ---------------------------------------------------------------- |
| `0.5` | 2  | Optical nudges only (a `mt-0.5` under a two-line label).         |
| `1`   | 4  | Menu padding; the gap inside a chip.                             |
| `1.5` | 6  | The gap between an icon and its label in a dense row.            |
| `2`   | 8  | Gap between neighbouring controls; icon-to-label in buttons.     |
| `3`   | 12 | Horizontal padding of buttons and fields; gap between form rows. |
| `4`   | 16 | Card padding; sidebar and header gutters.                        |
| `5`   | 20 | Gap between groups inside a card.                                |
| `6`   | 24 | Dialog and page padding; gap between cards.                      |
| `8`   | 32 | Gap between page sections.                                       |
| `12`  | 48 | Breathing room above empty states and greetings.                 |

`2.5` and `3.5` (10px, 14px) are off the grid. The conformance test rejects them as
padding, margin, gap and `space-*` steps (`px-2.5`, `gap-3.5`, `-mt-2.5`). A size is
not spacing: `size-3.5` for a 14px icon box is allowed.

Prose in the chat is held to a reading measure of `max-w-2xl` (672px) inside the
chat column; see [Layout](#layout). The chat's density is a preference
(`[data-chat-density]`: compact, default, comfortable) that changes only the gap
between turns (`--chat-message-gap`) and between a turn's steps
(`--timeline-row-gap`, `--timeline-block-gap`); see [`patterns.md`](./patterns.md#density).

### Heights

| Utility | px | Use                                                                                                    |
| ------- | -- | ------------------------------------------------------------------------------------------------------ |
| `h-5`   | 20 | Badges, keycaps (`KbdHint`), the switch track.                                                         |
| `h-6`   | 24 | The `key: value` chips (`.terminal-chip`, `.composer-chip`, which set it in CSS).                      |
| `h-7`   | 28 | Compact controls: `sm` and `icon-sm` buttons, the composer's tool chips, the code block's copy button. |
| `h-8`   | 32 | The default: `md` and `icon` buttons, fields, Select triggers, menu items, nav rows, segments.         |
| `h-9`   | 36 | Underline tabs (`Tabs`, `TabNav`).                                                                     |
| `h-10`  | 40 | `lg` buttons: the actions of the login, sign-up and onboarding screens.                                |
| `h-12`  | 48 | The header and the sidebar's brand row, so they share a baseline.                                      |

32px is WinUI's own control height and is within two pixels of libadwaita's.

### Touch targets

The heights above are the **fine-pointer** sizes. Under `@media (pointer: coarse)`
an unlayered rule in `index.css` gives every `button`, `a`, `select`, `textarea`,
`[role="button"]` and text-like `input` a 44px `min-height` and `min-width`, so a touch
screen reads taller than the table. It is unlayered so a utility such as `min-h-8` on
a menu row cannot undo it, which is also why it names its exemptions:

- Checkbox, radio and range inputs, and the switch (a `role="switch"` checkbox),
  keep their drawn size. `Checkbox` and `Radio` widen the hit area to 40px with a
  pseudo-element (`pointer-coarse:after:-inset-3`); a row that wraps one in a
  `<label>` makes itself the target with `pointer-coarse:min-h-11`.
- A range input keeps its 6px track.
- The code block's 28px copy button (`.copy-code-btn`) stays 28px so it does not
  cover the first lines of a snippet.
- Links inside markdown prose stay inline text.

Two more rules follow from it. The timeline raises `--timeline-row-height` to 44px on
a coarse pointer, so a node stays centred on a row the floor made taller (a static
`TimelineRow` takes the same height through `min-h-(--timeline-row-height)`). Anything
revealed on hover is shown at rest on touch (`pointer-coarse:opacity-100`, as in
`features/chat/lib/turn-action-reveal.ts`, or `pointer-coarse:flex` /
`pointer-coarse:inline-flex`), and keycaps are not drawn (`KbdHint` carries
`pointer-coarse:hidden`). `tests/unit/stylesheet-cascade.test.ts` pins the exemptions
and the timeline height; [decision 15](./decisions.md) has the reasoning.

## Radius

Four radii by role, plus the pill. The theme empties Tailwind's own scale, so
`rounded-xl` and larger compile to nothing. The conformance test rejects them, and a
bare `rounded` with no size too.

| Utility        | px | Applies to                                                                                                                                                        |
| -------------- | -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rounded-xs`   | 4  | Checkboxes, keycaps, inline code, thumbnails, skeletons.                                                                                                          |
| `rounded-sm`   | 6  | **Everything clickable**: buttons, fields, Select, chips, menu items, nav rows, segments.                                                                         |
| `rounded-md`   | 8  | Containers: cards, tool blocks, menus, toasts, code blocks, callouts.                                                                                             |
| `rounded-lg`   | 12 | Large surfaces: dialogs, the composer, the command palette, the user's message, the login and sign-up cards.                                                      |
| `rounded-full` | —  | Status marks and round glyphs: badges, status dots, spinners, progress bars, the accent bars, the radio, the switch and slider. No button, chip or row is a pill. |

A control and the container it sits in differ by one step (a `rounded-sm` button
in a `rounded-md` card) so the corners never look like they were guessed.
`ToolAvatar` steps its corner with its size, from `rounded-xs` on the smallest tile
to `rounded-lg` on the largest.

## Elevation

Flat by default. A card, a button and the composer rely on surface + stroke; none
of them casts a shadow. Only things that **float** do.

| Utility          | Dark                              | Light                               | Use                                                                                                                      |
| ---------------- | --------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `shadow-popover` | `0 4px 16px rgba(0, 0, 0, 0.36)`  | `0 4px 16px rgba(30, 20, 5, 0.1)`   | Menus, listboxes and popovers (`.dropdown-panel`), toasts, and controls that float over the transcript (jump to latest). |
| `shadow-dialog`  | `0 16px 40px rgba(0, 0, 0, 0.48)` | `0 16px 40px rgba(30, 20, 5, 0.14)` | Dialogs and the command palette.                                                                                         |

They are custom utilities backed by `--elevation-popover` / `--elevation-dialog`,
because Tailwind inlines a `--shadow-*` theme value into the utility and a
per-theme override of the variable would never reach it. Every other shadow name
(`shadow-sm` through `shadow-2xl`, `drop-shadow-*`) is rejected.

Floating surfaces are **solid**: `bg-surface-raised border border-stroke`. No
transparency and no backdrop blur. WinUI flyouts and libadwaita popovers are
drawn this way, so a native port has no material effect to undo. The `.dropdown-panel`
class bundles all of it for menus and listboxes; `DIALOG_SURFACE_CLASS` in
`Dialog.tsx` does the same for dialogs.

## State

- **Focus**: a 2px solid `focus` outline, offset 2px, applied globally to
  `:focus-visible`. Components do not draw their own ring. Text fields and Select
  triggers replace it with a border change (`focus:outline-none focus:border-focus
  focus:ring-1 focus:ring-focus`). A few controls move the same ring: underline tabs
  pull it inward (`-outline-offset-2`) so the scrolling strip does not clip it, a
  slider draws it on its thumb, the switch on its track (the input itself is
  visually hidden), a composer chip around the `<label>` that wraps its `<select>`
  (`.composer-chip:has(:focus-visible)`), and a control on `scrim-media` draws it in
  `on-scrim-media`.
- **Hover** changes colour only, in 120ms: the fill, and on a control whose text rests
  in `fg-muted` (an idle tab, an unselected segment, a chip) the text steps up to
  `fg`. No scale, no lift, no glow, and no `transition-all`. Tailwind's `hover:` only
  applies to a pointer that can hover, and the hover fills hand-written in `index.css`
  (composer chips, the slider thumb, the copy button) are gated the same way
  (`@media (hover: hover)`), so a tapped control does not stay lit. The one hover that
  changes hue is `subtle-danger`: it rests in `fg-muted` and turns `danger` text on a
  `danger-subtle` fill on hover, keyboard focus and press
  ([decision 22](./decisions.md)). A `tone="danger"` `MenuItem` is `danger` text at rest
  and takes the `danger-subtle` fill on hover. The `danger` button brightens
  (`brightness-110`) instead of stepping to a token.
- **Pressed**: `accent-pressed` and `control-pressed` are one step darker than the
  resting fill. `fill-pressed` is a thinner wash than `fill-hover`.
- **Disabled** buttons turn neutral grey (`fill-selected` + `fg-subtle`) in the
  filled variants (`primary`, `secondary`, `danger`); the quiet ones (`subtle`,
  `subtle-danger`) have no fill to begin with and only turn their text `fg-subtle`,
  because a tile would read as the hovered or selected row
  ([decisions 10 and 14](./decisions.md)). A button that is merely *loading* keeps its
  colour and shows the spinner; `aria-busy` tells the two apart. Other disabled
  controls (fields, Select, checkbox, switch, slider, chips, menu items) drop to 50%
  opacity. The test is whether the disabled thing carries information
  ([decision 21](./decisions.md)); two kinds of row are content rather than a control
  that is off, and do not fade:
  - A disabled row whose name is information (a model tied to another provider, an
    unavailable runner, a taken distribution or a signed-out CLI in a `PickOneRow`)
    keeps its icon or identity dot at full strength (a locked model gains a lock), and
    its name steps from `fg` to `fg-muted`. It
    loses its hover and shows `cursor-not-allowed`; the reason sits beside it or at the
    head of the list ([decisions 17 and 21](./decisions.md)).
  - A composer chip *locked* because the chat has turns (the agent, the environment)
    is a `LockedChip`: full-strength text, no chevron ([decision 18](./decisions.md)).
    Only a chip that is loading or failed fades.
- **Selected** is a neutral `fill-selected` plus an accent mark. In a vertical list
  (the sidebar, the settings nav, onboarding steps, `PickOneRow`, the theme cards, the
  terminal session list) the mark is a 3px bar on the leading edge (`SELECTION_BAR` in
  `components/ui/selection-bar.ts`). An
  underline tab and a selected `SettingsSegmented` segment carry a 2px bar on their
  bottom edge instead.
- **On** (a toggle chip with `aria-pressed="true"`) wears `fill-selected`, the same
  wash as an open menu, so it adds a second cue the open state lacks: the chip's
  leading icon takes the composer's runner colour. A chip whose state nothing else
  shows (Create images) also carries a check beside its label.

## Motion

| Token              | Value                             | Use                                                                                                                                           |
| ------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `--duration-quick` | 120ms                             | Hover and focus feedback, and menus and popovers opening. A bare `transition-colors` resolves to it.                                          |
| `--duration-base`  | 200ms                             | The command palette's and lightbox's panel, disclosures, toasts, card entrances, moving a switch knob, the composer border changing on focus. |
| `--duration-slow`  | 320ms                             | A sliding panel (the mobile sidebar).                                                                                                         |
| `ease-standard`    | `cubic-bezier(0.2, 0, 0, 1)`      | Everything that moves today, and the default timing of a bare `transition-*`.                                                                 |
| `ease-emphasized`  | `cubic-bezier(0.05, 0.7, 0.1, 1)` | A firmer settle, kept for an entrance that should feel deliberate. Nothing uses it yet.                                                       |

Tailwind has no `--duration-*` namespace, so the durations live in `:root` and are
written `duration-(--duration-base)` in a class or `var(--duration-base)` in CSS.
`index.css` also points `--default-transition-duration` and
`--default-transition-timing-function` at `--duration-quick` and `ease-standard`, which
retunes every bare `transition-colors` at once.

JavaScript animation (`motion/react`) reads the same values from
`lib/motion/tokens.ts`, which `tests/unit/lib/motion/tokens.test.ts` keeps equal to the
stylesheet. Components take a preset from `useMotionPresets()` instead of writing a
transition (`lib/motion/variants.ts` defines them): menus, Select and `ChipSelect`
drop 6px from their trigger (`popoverBelow`), composer popovers rise 8px
(`popoverAbove`), the command palette's and the gallery lightbox's panel drops 8px
(`dialogPanel`), and toasts and the jump-to-latest button rise 8px (`fadeRise`), each
with a fade; popovers and those panels also grow from 96–97% scale. Disclosures open by
height (`collapse`), and the card grids on Home rise 6px per card, 40ms apart
(`useCardGrid()`). Nothing bounces.

`prefers-reduced-motion` collapses every CSS animation and transition, and
`useMotionPresets()` swaps to still presets, because the CSS rule does not reach
JavaScript animation.

## Icons

Lucide (`lucide-react`), at its default 2px stroke with round caps. Sizes are
constants in `@/lib/icon-sizes`:

| Constant  | px | Use                                                                                |
| --------- | -- | ---------------------------------------------------------------------------------- |
| `ICON_SM` | 14 | Inside chips, badges and compact rows; inline status glyphs.                       |
| `ICON_MD` | 16 | Buttons, menu items, navigation rows, callout glyphs.                              |
| `ICON_LG` | 20 | The mobile navigation tiles, the header's menu button, toast glyphs, empty states. |

Pick one of the three; do not write a literal `size`. The one exception is a tick
drawn inside a 16px box (`Checkbox`, `ChoiceButton`), which is 12px. The conformance
test enforces the rule for `EmptyState` icons. Icons inherit the text colour of their row; at rest that is
`fg-muted`. A native build swaps them for Segoe Fluent Icons or Adwaita symbolic
icons at the same metrics.

## Layout

- The sidebar is 256px by default (240px to 420px, resizable from its edge;
  `CHAT_SIDEBAR_WIDTH_*` in `@mangostudio/shared/workspaces`), `bg-sidebar`, closed by
  a `stroke` border. Below `md` it becomes a slide-over with a `scrim`.
- The header is `h-12` in every breakpoint, `bg-canvas` with a `stroke` bottom border.
  It carries the runner, the machine (from `sm`) and the workspace (from `md`) on the
  left, and the command palette and account actions on the right. Below `md` the right
  side is a New chat button and one account menu.
- The workspace panel (git, GitHub, to-dos, terminal) docks on the right from 1024px:
  a 48px `bg-sidebar` icon strip and a `bg-surface` panel, 360px by default (280px to
  640px, resizable; `WORKSPACE_PANEL_WIDTH_*`). Below 1024px it is a drawer over a
  `scrim`.
- Reading surfaces (chat, settings) centre their content in a single column. The
  chat's is `max-w-4xl` (896px) inside a `px-3 sm:px-4 md:px-6` gutter
  (`CHAT_COLUMN_CLASS` and `CHAT_GUTTER_X_CLASS`), and the transcript, the notices
  above the composer and the composer all sit in it, so their edges line up at every
  width. Prose bubbles inside it stop at `max-w-2xl`.
  Settings pages use a two-column layout (a 14rem nav + content) from `lg`, inside
  `max-w-6xl`. The library is a section of the Environments umbrella, not a page of
  its own: it sits under that umbrella's heading and tab strip with a second `TabNav`
  of its own (kinds, settings, locations) and no side nav, so a wide matrix keeps the
  full width. The row above the second strip is the same `EnvironmentScopeHeader`
  every Environments tab opens with: the description, the machine picker and one
  Re-check. Backups span every machine, so that page drops the picker and the
  Re-check.
