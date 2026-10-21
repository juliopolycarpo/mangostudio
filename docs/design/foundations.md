# Foundations

The tokens behind the flat design: colour, type, space, radius, elevation, motion
and icons. Every value lives in [`apps/frontend/src/index.css`](../../apps/frontend/src/index.css)
(`@theme static` for dark, `[data-theme="light"]` for light) and every utility
named here is the class you write. [`README.md`](./README.md) says why the system
is shaped this way; [`components.md`](./components.md) says how the pieces use
these tokens.

## Colour

Tokens are named for the **role** they play, never for the value they happen to
hold. A native port maps each role to the platform resource that plays it (see
[`native-ports.md`](./native-ports.md)); a hex value would have no such mapping.

Rules that hold across all of them:

- Text, icons and marks that carry meaning clear the contrast floor in **both**
  themes: 4.5:1 for text, 3:1 for control lines, focus rings and glyphs.
- A tint is a token (`*-subtle`, `fill-*`), never an opacity modifier. Writing
  `bg-accent/10` is rejected by the conformance test.
- Status colours always travel with an icon or a word. Colour alone is not a
  signal.
- The accent is the only hue in the interface. The `agent-*` colours identify
  runners and nothing else.

### Surfaces

| Token            | Utility             | Dark      | Light     | Use                                                                                                                                          |
| ---------------- | ------------------- | --------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `canvas`         | `bg-canvas`         | `#151311` | `#f6f4f0` | The window and the main content area (chat, settings). The header shares it — no darker strip.                                               |
| `sidebar`        | `bg-sidebar`        | `#1b1916` | `#eeebe5` | The sidebar. One step off `canvas`, closed by a `stroke` line.                                                                               |
| `surface`        | `bg-surface`        | `#1f1d1a` | `#ffffff` | Cards, section panels, the composer, tool blocks. Always with a `stroke` border, never a shadow.                                             |
| `surface-raised` | `bg-surface-raised` | `#282521` | `#ffffff` | Things that float: menus, listboxes, dialogs, toasts, the command palette. The only surface that carries `shadow-popover` / `shadow-dialog`. |

### Controls and interaction fills

| Token             | Utility              | Dark        | Light       | Use                                                                                                                                        |
| ----------------- | -------------------- | ----------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `control`         | `bg-control`         | `#2a2723`   | `#ffffff`   | Fill of text fields, Select triggers, secondary buttons, checkbox boxes.                                                                   |
| `control-hover`   | `bg-control-hover`   | `#322f2a`   | `#f7f5f1`   | The same controls under the pointer.                                                                                                       |
| `control-pressed` | `bg-control-pressed` | `#25221f`   | `#f0ede7`   | Secondary button while pressed.                                                                                                            |
| `fill-hover`      | `bg-fill-hover`      | `#fff5e60f` | `#2a1e0a0d` | Hover for anything with no fill of its own: subtle buttons, menu items, sidebar rows, list rows.                                           |
| `fill-pressed`    | `bg-fill-pressed`    | `#fff5e608` | `#2a1e0a08` | Pressed state of the `fill-hover` family.                                                                                                  |
| `fill-selected`   | `bg-fill-selected`   | `#fff5e614` | `#2a1e0a12` | The current item in navigation and lists, an open chip, inline code. Neutral on purpose — the colour is carried by the `accent` indicator. |

### Lines

| Token           | Utility            | Dark      | Light     | Use                                                                                                                                                      |
| --------------- | ------------------ | --------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stroke`        | `bg-stroke`        | `#35312b` | `#e3ded5` | Decorative hairline: card and surface borders, dividers, the sidebar edge, the header's bottom border.                                                   |
| `stroke-strong` | `bg-stroke-strong` | `#807a6e` | `#8a8478` | The line that identifies a control: a field's bottom border, checkbox box, switch track, timeline rail. Clears 3:1 on `canvas`, `surface` and `control`. |

### Text

| Token       | Utility          | Dark      | Light     | Use                                                                                                                                     |
| ----------- | ---------------- | --------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `fg`        | `text-fg`        | `#ece7df` | `#1e1b16` | Primary text and active icons.                                                                                                          |
| `fg-muted`  | `text-fg-muted`  | `#a8a196` | `#5a554c` | Secondary text, descriptions, the key half of a chip, resting icons. At least 5.2:1 on every surface.                                   |
| `fg-subtle` | `text-fg-subtle` | `#979084` | `#6b655b` | Placeholders, timestamps, metadata, hints. At least 4.5:1 on every surface — the floor for text; never fade text with opacity below it. |

### Accent (mango)

| Token            | Utility             | Dark        | Light       | Use                                                                                                                              |
| ---------------- | ------------------- | ----------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `accent`         | `bg-accent`         | `#f5a623`   | `#f0a020`   | Fill of the primary button, a checked switch or checkbox, the current-page bar, the streaming caret. Always carries `on-accent`. |
| `accent-hover`   | `bg-accent-hover`   | `#f7b44a`   | `#f2ad3c`   | Primary button under the pointer.                                                                                                |
| `accent-pressed` | `bg-accent-pressed` | `#e0961a`   | `#e09114`   | Primary button while pressed; the divider inside a primary split button.                                                         |
| `on-accent`      | `text-on-accent`    | `#241600`   | `#241600`   | Text and icons on `accent` (8.2:1 or better). Dark in both themes so the mango stays orange in light mode.                       |
| `accent-fg`      | `text-accent-fg`    | `#f5a623`   | `#8f5a00`   | Mango as text or an icon on a surface: links, a marked menu item, drop hints. 4.8:1 or better.                                   |
| `accent-subtle`  | `bg-accent-subtle`  | `#f5a62324` | `#f5a62329` | A mango wash for a quiet active state: the drop hint, an accent badge.                                                           |
| `focus`          | `bg-focus`          | `#f5a623`   | `#8f5a00`   | The keyboard focus ring: 2px, offset 2px, on every control. 4.8:1 or better on every surface.                                    |

### Status

| Token            | Utility             | Dark        | Light       | Use                                                                          |
| ---------------- | ------------------- | ----------- | ----------- | ---------------------------------------------------------------------------- |
| `success`        | `bg-success`        | `#4ade80`   | `#15803d`   | Text and icon for success. Always with an icon or a word.                    |
| `success-subtle` | `bg-success-subtle` | `#4ade801f` | `#15803d1a` | Fill of a success badge or callout.                                          |
| `warning`        | `bg-warning`        | `#ffd166`   | `#b45309`   | Text and icon for attention. Always with an icon or a word.                  |
| `warning-subtle` | `bg-warning-subtle` | `#ffd1661f` | `#b453091a` | Fill of a warning badge or callout.                                          |
| `danger`         | `bg-danger`         | `#f87171`   | `#c42b1c`   | Text and icon for errors, and the status dot. Always with an icon or a word. |
| `danger-subtle`  | `bg-danger-subtle`  | `#f871711f` | `#c42b1c14` | Fill of an error badge or callout; hover of a destructive menu item.         |
| `danger-solid`   | `bg-danger-solid`   | `#c42b1c`   | `#c42b1c`   | Fill of the destructive button (delete, revoke). Always with `on-danger`.    |
| `on-danger`      | `text-on-danger`    | `#ffffff`   | `#ffffff`   | Text on `danger-solid` (5.7:1).                                              |
| `info`           | `bg-info`           | `#7cb8ff`   | `#1f63c4`   | Text and icon for neutral information and notes.                             |
| `info-subtle`    | `bg-info-subtle`    | `#7cb8ff1f` | `#1f63c414` | Fill of an info badge or callout.                                            |

### Overlay and identity

| Token           | Utility            | Dark        | Light       | Use                                                                                                                                            |
| --------------- | ------------------ | ----------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `scrim`         | `bg-scrim`         | `#0000008c` | `#1e1b1652` | The veil behind a dialog or the mobile sidebar. A flat tint, never a blur.                                                                     |
| `agent-mango`   | `bg-agent-mango`   | `#f5a623`   | `#a86400`   | MangoStudio's own runner: the dot, the composer border, the prompt mark. Light value darkened to `#a86400` (4.7:1) because it is read as text. |
| `agent-claude`  | `bg-agent-claude`  | `#e0836a`   | `#b9553a`   | Claude Code runner identity.                                                                                                                   |
| `agent-codex`   | `bg-agent-codex`   | `#5cc8e8`   | `#1f7a99`   | Codex runner identity.                                                                                                                         |
| `agent-cursor`  | `bg-agent-cursor`  | `#a78bfa`   | `#6d4fd8`   | Cursor runner identity.                                                                                                                        |
| `agent-generic` | `bg-agent-generic` | `#8b8579`   | `#736d63`   | A runner with no identity of its own.                                                                                                          |

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

One interface family and one mono. The stacks fall through to what the platform
ships, so a native build reads in its own system font with the same scale.

| Family                | Stack                                                                            |
| --------------------- | -------------------------------------------------------------------------------- |
| `font-sans` (default) | Inter → Segoe UI Variable Text → Segoe UI → Adwaita Sans → Cantarell → system-ui |
| `font-mono`           | JetBrains Mono → Cascadia Mono → Adwaita Mono → ui-monospace                     |

| Utility         | Size / line      | Weight          | Use                                                                                 |
| --------------- | ---------------- | --------------- | ----------------------------------------------------------------------------------- |
| `text-headline` | 28 / 36, −0.01em | 600             | One greeting per screen: the Home heading, an onboarding step title.                |
| `text-title`    | 20 / 28          | 600             | Page and dialog titles.                                                             |
| `text-base`     | 16 / 24          | 600             | Section titles inside a page; large card headings.                                  |
| `text-sm`       | 14 / 20          | 400 · 500 · 600 | The default: fields, menu items, chat titles, message text. Button labels at 500.   |
| `text-xs`       | 12 / 16          | 400 · 500       | Descriptions, metadata, badges, toasts. The smallest size for running text.         |
| `text-micro`    | 11 / 16          | 500             | The floor for any text. Mono metadata, counters, and `.micro-label` group headings. |

- Weights are 400 (text), 500 (labels, buttons, the current item) and 600 (titles).
  There is no bold.
- Sentence case everywhere. The one upper-case is `.micro-label`, applied by the
  class, never by `uppercase` on an element.
- The chat's own size (13/14/16px) is a preference: `--chat-font-size` drives
  message bodies only.
- Mono is for content that is technical — `key: value` chips, paths, code, tool
  output — and for group labels. Titles, buttons and prose are never mono.

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

`2.5` and `3.5` (10px, 14px) are off the grid and rejected by the conformance
test. Reading content is centred in a column of at most 760px (`max-w-3xl` is the
nearest utility; settings pages and the chat use the width their layout defines).

### Heights

| Token  | px | Use                                                                  |
| ------ | -- | -------------------------------------------------------------------- |
| `h-7`  | 28 | Compact controls: toolbar buttons, composer tool chips, dense rows.  |
| `h-8`  | 32 | The default for a button, field, Select trigger, menu item, nav row. |
| `h-10` | 40 | The primary action of login, onboarding and empty screens.           |
| `h-12` | 48 | The header and the sidebar's brand row, so they share a baseline.    |

32px is WinUI's own control height and is within two pixels of libadwaita's.

## Radius

Four radii by role, plus the pill. The theme empties Tailwind's own scale, so a
name outside this list compiles to nothing.

| Utility        | px | Applies to                                                                                             |
| -------------- | -- | ------------------------------------------------------------------------------------------------------ |
| `rounded-xs`   | 4  | Checkboxes, keycaps, inline code, thumbnails.                                                          |
| `rounded-sm`   | 6  | **Everything clickable**: buttons, fields, Select, chips, menu items, nav rows, segmented tabs.        |
| `rounded-md`   | 8  | Containers: cards, tool blocks, menus, toasts, code blocks, callouts.                                  |
| `rounded-lg`   | 12 | Large surfaces: dialogs, the composer, the command palette, the user's message.                        |
| `rounded-full` | —  | **Status only**: badges, status dots, avatars, the switch track and knob. Nothing clickable is a pill. |

A control and the container it sits in differ by one step (a `rounded-sm` button
in a `rounded-md` card) so the corners never look like they were guessed.

## Elevation

Flat by default. A card, a button and the composer rely on surface + stroke; none
of them casts a shadow. Only things that **float** do.

| Utility          | Use                                                          |
| ---------------- | ------------------------------------------------------------ |
| `shadow-popover` | Menus, listboxes, toasts, tooltips, the context-usage panel. |
| `shadow-dialog`  | Dialogs and the command palette.                             |

They are custom utilities backed by `--elevation-popover` / `--elevation-dialog`,
because Tailwind inlines a `--shadow-*` theme value into the utility and a
per-theme override of the variable would never reach it.

Floating surfaces are **solid**: `bg-surface-raised border border-stroke`. No
transparency and no backdrop blur — WinUI flyouts and libadwaita popovers are
drawn this way, so a native port has no material effect to undo. The `.dropdown-panel`
class bundles all of it for menus and listboxes.

## State

- **Focus**: a 2px solid `focus` outline, offset 2px, applied globally to
  `:focus-visible`. Components do not draw their own ring. Text fields add a
  border change (`focus:border-focus focus:ring-1 focus:ring-focus`) because the
  outline would collide with their neighbours.
- **Hover** changes the fill only, in 120ms. No scale, no lift, no glow, and no
  `transition-all`.
- **Pressed** goes one step darker (`accent-pressed`, `control-pressed`,
  `fill-pressed`).
- **Disabled** buttons turn neutral grey (`fill-selected` + `fg-subtle`) in every
  variant; other disabled controls drop to 50% opacity. A button that is merely
  *loading* keeps its colour and shows the spinner (`aria-busy` tells the two apart).
- **Selected** is a neutral fill, plus the 3px accent bar where a list has a
  current item.

## Motion

| Token              | Value                             | Use                                                                   |
| ------------------ | --------------------------------- | --------------------------------------------------------------------- |
| `--duration-quick` | 120ms                             | Hover and focus feedback — the default of a bare `transition-colors`. |
| `--duration-base`  | 200ms                             | Opening a menu, moving a switch knob, a border changing on focus.     |
| `--duration-slow`  | 320ms                             | A sliding panel (the mobile sidebar).                                 |
| `ease-standard`    | `cubic-bezier(0.2, 0, 0, 1)`      | Everything.                                                           |
| `ease-emphasized`  | `cubic-bezier(0.05, 0.7, 0.1, 1)` | Entrances.                                                            |

Menus and dialogs enter with a fade and a few pixels of travel; nothing bounces.
`prefers-reduced-motion` collapses every animation and transition.

## Icons

Lucide (`lucide-react`), stroked at 2px with round caps — the set the app already
used. Sizes are constants in `@/lib/icon-sizes`:

| Constant  | px | Use                                                      |
| --------- | -- | -------------------------------------------------------- |
| `ICON_SM` | 14 | Inside chips, badges and compact rows.                   |
| `ICON_MD` | 16 | Buttons, menu items, navigation rows.                    |
| `ICON_LG` | 20 | The mobile navigation tiles, toast glyphs, empty states. |

Icons inherit the text colour of their row; at rest that is `fg-muted`. A native
build swaps them for Segoe Fluent Icons or Adwaita symbolic icons at the same
metrics.

## Layout

- The sidebar is `size-sidebar`: 264px by default, user-resizable, `bg-sidebar`,
  closed by a `stroke` border. Below `md` it becomes a slide-over with a `scrim`.
- The header is `h-12` in every breakpoint. It carries the runner and workspace
  context on the left, the command palette and account actions on the right.
- Reading surfaces (chat, settings) centre their content in a single column.
  Settings and library pages use a two-column layout (nav + content) from `lg`.
