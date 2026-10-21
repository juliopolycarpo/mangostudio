# Components

The shared components in `apps/frontend/src/components/ui/` and
`components/layout/`, and the pieces of the chat that carry the product's own
dialect (composer, timeline). Token names and utilities are defined in
[`foundations.md`](./foundations.md). Reach for one of these before repeating its
classes; if you need a variant that does not exist, add it to the component, not
to the call site.

## Actions

### `Button`

A 32px flat button with four roles and four sizes.

| `variant`   | Fill                             | Use                                                               |
| ----------- | -------------------------------- | ----------------------------------------------------------------- |
| `primary`   | `accent`, text `on-accent`       | **One** per region: Send, Save, New chat.                         |
| `secondary` | `control` + `stroke` border      | Alongside the primary: Cancel, Discard.                           |
| `subtle`    | none; hover `fill-hover`         | Toolbars, the header, row actions, icon buttons.                  |
| `danger`    | `danger-solid`, text `on-danger` | The final confirmation of something destructive, inside a dialog. |

| `size` | Height | Use                                                                                                  |
| ------ | ------ | ---------------------------------------------------------------------------------------------------- |
| `sm`   | 28px   | Dense bars and rows; text at 12px.                                                                   |
| `md`   | 32px   | Default; text at 14px.                                                                               |
| `lg`   | 40px   | The main action of login, onboarding and empty screens; onboarding's Back and Skip share its height. |
| `icon` | 32×32  | An icon-only button. It must carry an `aria-label` or `title`.                                       |

Weight 500, `rounded-sm`, transitions colour only. Hover and press shift the fill;
there is no shadow, no scale on press and no glow. A disabled `primary`,
`secondary` or `danger` button is a neutral grey tile (`fill-selected` + `fg-subtle`);
a disabled `subtle` or `subtle-danger` button has no tile and only turns its text
`fg-subtle`, so the inactive control never looks like the hovered or selected one.
`loading` shows a spinner, keeps the variant's colour and sets `aria-busy`.

### `SplitButton`

A primary action with a menu of variants attached ("Commit" / "Commit and push").
Both halves are `Button size="sm"`; the divider is a 1px `accent-pressed` line. While
the primary half is unavailable it is the neutral grey of any disabled button, so
the chevron drops to `secondary` and the divider to its `stroke` border — the menu
must not be the only mango in the region. A primary half that is only loading keeps
its accent, and so does the chevron. Use it only when the alternatives are
variations of the same action.

## Input

### `Input`

A 32px text field: `control` fill, `stroke` border on three sides and `stroke-strong`
underneath — the line that says "this is a field". Hover goes to `control-hover`.
Focus swaps the border for `focus` and adds a 1px ring. The shared classes are
exported as `FIELD_CLASS` so an inline field (the sidebar search, a rename input)
matches. `error` sets `aria-invalid`, turns the border `danger` and shows the
message with an icon.

- `label` sits above the field at 14px/500 and is always visible.
- `placeholder` is an example value in `fg-subtle`, never the instruction.

### `Select` and `ChipSelect`

`Select` is the form dropdown: the same face as `Input`, with a `ChevronDown` in
`fg-muted` and a `.dropdown-panel` listbox below. `ChipSelect` is the composer's
`key: value` variant and always opens upward. In both, hover and keyboard focus use
`fill-hover`, the selected option uses `fill-selected`, and the only accent is the
check mark in `accent-fg`.

### `Checkbox` and `Toggle`

`Checkbox` is a 16px box with `rounded-xs` and a `stroke-strong` border; checked it
fills `accent` with an `on-accent` tick. `Toggle` is the preference switch (36×20
track, 12px knob): off is `control` with a `stroke-strong` border and a muted knob;
on is `accent` with an `on-accent` knob. Use a switch for a setting with an
immediate effect and a checkbox for an option in a form or a list. On a touch
screen the 16px box does not grow (the 44px floor skips it); `Checkbox` and
`Radio` widen the hit area to 40px with a pseudo-element on the input itself, so
a tap beside the box still toggles it, with or without a wrapping `<label>`.

### `SettingsSegmented`

A row of two to four mutually exclusive segments (`components/settings/`): the 32px
`rounded-sm` face of a secondary button, `control` fill and `fg-muted` text at rest. The
selected segment is a neutral `fill-selected` with a `stroke-strong` border, `fg` text and
a 2px `accent` bar along its bottom edge, the mark of the current underline tab — never
the accent fill of a primary button, which would put a second primary next to Save
(decision 16). A longer list belongs in a `Select`.

## Status

### `Badge`

A 20px pill, 12px/500, sentence case: `neutral`, `accent`, `success`, `warning`,
`error`, with the matching `*-subtle` fill and status-coloured text. Pills are
reserved for status — nothing clickable is round. It carries a word or an icon, so
colour is never the only signal. A badge that states a live state (an MCP server's
last-known connection) may lead with a `StatusDot`, so it cannot be mistaken for the
neutral metadata badges beside it (transport, environment).

### `StatusDot`

An 8px dot beside a word. `accent`, `success`, `warning`, `error`, `neutral`; `pulse`
only for "running now". Never alone — it accompanies text or sits inside a control
that has an `aria-label`.

### `Chip`

The `key: value` pair in mono (`font-mono text-xs`, 24px, `rounded-sm`, a `stroke`
hairline, no fill). Static chips are information; with `onClick` they gain a
`fill-hover` hover. In the composer's status line they lose the border
(`.composer-chip`) and are separated by `·`.

### `KbdHint` and `MicroLabel`

`KbdHint` is a 20px keycap (`rounded-xs`, `control` fill, mono 11px) for a shortcut,
right-aligned where the action lives. `MicroLabel` is the group heading: mono 11px,
upper-case, `0.06em`, `fg-subtle` — the one place text is upper-cased.

### `Callout`

An inline notice: a `*-subtle` band with a status glyph and ordinary text colours.
Tone lives in the fill and the glyph, never in a coloured border or the words.
`tone`: `neutral`, `info`, `success`, `warning`, `danger`. Optional `title` (500),
body, and an `action`.

### `Spinner` and `Skeleton`

`Spinner` is a 2px ring with an `accent` arc; `sm` (16px) lives inside buttons and
rows, `md` (24px) inline, `lg` (40px) for a page waiting on data. `Skeleton` is a
`fill-selected` block that pulses opacity — no shimmer gradient. Both stop under
`prefers-reduced-motion`.

### `EmptyState`

A centred block: 20px icon (`ICON_LG`) in `fg-subtle`, a title at 14px/500, a hint at 12px in
`fg-muted` (max 320px) and an optional `secondary` action. No illustrations and no
coloured disc behind the icon.

## Navigation

### `TabNav`

Underline tabs for sibling subpages: 36px, `fg-muted` at rest, `fg` at 500 when
current, with a 2px `accent` underline sitting on the divider. Hover is `fill-hover`.
No tinted background and no folder corners. The strip is one row that scrolls
sideways when the tabs do not fit (it never wraps, which would strand the
underline on a row with no divider), and it scrolls the current tab into view.

### `NavItem` and the sidebar

A 32px row (`rounded-sm`): 16px icon, truncated title, optional mono metadata at
the end. The current page is `fill-selected` + `fg` at 500 + a 3px `accent` bar on
the leading edge. The sidebar is `sidebar`, 264px, with a 48px brand row that
shares the header's baseline; "New chat" is a full-width `primary` button with its
shortcut as a `KbdHint`; chat rows add a runner dot and a mono timestamp that yield
to the rename and delete buttons on hover.

### `Header`

48px, `canvas`, a `stroke` bottom border. Left: runner and workspace context.
Right: the command palette, account actions. Every button is `subtle`; there is no
primary action in the header.

### `Menu`

`Menu`, `MenuItem` and `MenuSeparator` render a `.dropdown-panel` (solid
`surface-raised`, `stroke` border, `rounded-md`, `shadow-popover`, 4px padding).
Items are 32px, `rounded-sm`, 14px, with a 16px `fg-muted` icon; hover and keyboard
focus use `fill-hover`; a marked item gets a check in `accent-fg`. A destructive item
goes last, after a separator, in `danger` with a `danger-subtle` hover.

## Containers

### `Card` and `SectionCard`

`Card` is a flat `surface` with a `stroke` border and `rounded-md`, padded `p-4`
(`sm:p-6`) unless `padded={false}`. `SectionCard` is a card headed by a
`MicroLabel` (with an optional `StatusDot`) and an action. Never nest a card in a
card; inside one, divide with a `stroke` line.

### `ConfirmDialog`

A modal over a flat `scrim`: `surface-raised`, `rounded-lg`, `shadow-dialog`, up to
`max-w-sm`. A left-aligned title in the form of a question, a sentence that names the
consequence and the entity, and a footer on `canvas` with the actions right-aligned
at natural width — "Cancel" then the destructive verb. No oversized icon disc.

### `Toast`

Bottom-right, 360px, `surface-raised`, `stroke` border, `rounded-md`,
`shadow-popover`. The type shows in the **glyph** only (`success`, `danger`, `info`);
the message stays in `fg`. It dismisses after 4s; an error that needs action belongs
in a `Callout`, not a toast.

## The chat's own components

### Composer (`InputBar`)

`surface`, `stroke` border, `rounded-lg` — and the one surface that wears the
runner's identity. `--composer-accent` (from the chat's runner) colours the border
while focused, the prompt mark `›`, the caret and the runner's own chip. Send is
**always** the product `accent`: one primary action, one colour, whoever is
answering. A status line on top carries mono `key: value` chips separated by `·`,
closed by a `stroke` line; the tool row below uses ghost buttons in the same
dialect. A toggle chip is `aria-pressed`: on, it takes `fill-selected` (the open
menu's wash) and tints its leading icon with `--composer-accent`, so on and open
never look alike; `create images`, which has no value chip beside it, also shows a
check from `sm` up.

The context ring is a 16px glyph with the figure beside it (`62%`, mono, 12px,
`fg-muted`) in the strip, and the 20px ring with the figure inside it in a sidebar
row, where a title is truncating next to it. The arc is `fg` while usage is normal
or informational and turns `warning` and `danger` as the tracker escalates; mango
is not used, because a healthy 62% is not the primary action, the current item or
focus.

### Timeline and tool blocks

The assistant turn is a 1px `stroke-strong` rail with 7px nodes: `fg-subtle` at
rest, `success` when finished, `danger` on error, `accent` while running (pulsing).
Tool blocks are `surface` cards with a 32px mono header and their output in mono on
`canvas`. The user's message is a `surface` balloon with a `stroke` border and
`rounded-lg`.

### Markdown

Headings are Inter 600; inline code is mono on `fill-selected` with `rounded-xs`;
code blocks are `surface` with a `stroke` border (Shiki keeps its own theme
background); links are `accent-fg`; a blockquote's rule is `stroke-strong`, not an
accent. A table sits in a `.markdown-table-scroll` wrapper that scrolls sideways
when its columns need more than the bubble, and inline code in a cell never
breaks at a hyphen.
