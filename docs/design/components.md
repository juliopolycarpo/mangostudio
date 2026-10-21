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
| `sm`   | 28px   | Dense bars and rows; text at 12px, its glyph `ICON_SM` (14px).                                       |
| `md`   | 32px   | Default; text at 14px, its glyph `ICON_MD` (16px).                                                   |
| `lg`   | 40px   | The main action of login, onboarding and empty screens; onboarding's Back and Skip share its height. |
| `icon` | 32×32  | An icon-only button. It must carry an `aria-label` or `title`.                                       |

Weight 500, `rounded-sm`, transitions colour only. Hover and press shift the fill;
there is no shadow, no scale on press and no glow. A disabled `primary`,
`secondary` or `danger` button is a neutral grey tile (`fill-selected` + `fg-subtle`);
a disabled `subtle` or `subtle-danger` button has no tile and only turns its text
`fg-subtle`, so the inactive control never looks like the hovered or selected one.
`loading` shows a spinner, keeps the variant's colour and sets `aria-busy`.

A destructive action that is not the final confirmation — Remove, Revoke, Delete on a
row — is `variant="subtle-danger"`: `fg-muted` at rest, and `danger` text on a
`danger-subtle` fill on hover, keyboard focus and press. It rests quiet because it
repeats: a list whose every row ends in a red trash can is a column of red that
outshouts the rows. An icon-only one (a trash can) carries both an `aria-label` and a
`title`, so the verb is discoverable. It is never a `subtle` button with a `text-danger` override, which
loses the press state and hovers neutral beside its siblings.

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
`key: value` variant: its listbox opens upward on the composer strip, at the foot of
the viewport, and downward (`placement="below"`) when the chip is placed in the header
or in a page's title row, where an upward panel would open above the window and be
clipped. In both, rows are the menu's 32px at 14px with a 12px `fg-muted` description,
hover and keyboard focus use `fill-hover`, the selected option uses `fill-selected`, and
the only accent is the check mark in `accent-fg`. A list taller than half the viewport
scrolls with the thin `app-scrollbar`, never a hidden one.

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

`LockedChip` is the composer chip for a fact rather than a choice: what a `ChipSelect`
becomes once its answer is settled (the agent and the environment, after a chat's first
turn). Key in `fg-muted`, value in `fg`, no chevron, and the reason as its `title` and as
screen-reader text. It is not drawn at 50% like a disabled control, because the text is
information ([decision 18](./decisions.md)).

### `KbdHint` and `MicroLabel`

`KbdHint` is a 20px keycap (`rounded-xs`, `control` fill, mono 11px) for a shortcut,
right-aligned where the action lives. The Return key is drawn as an icon
(`<KbdHint keys={<ReturnKey />} />`), not as the `⏎` text glyph, which is hairline-thin
at 11px and left the keycap looking empty. The palette's footer draws its other keys the
same way (`ArrowUpDown`, `ArrowRightToLine` at `ICON_SM`). No keycap is drawn on a coarse
pointer: a touch screen has no Esc or Ctrl+N, so `KbdHint` carries `pointer-coarse:hidden`
itself rather than leaving it to each call site, and the palette's footer goes with it.
`MicroLabel` is the group heading: mono 11px, upper-case, `0.06em`, `fg-subtle` — the one
place text is upper-cased.

### `Callout`

An inline notice: a `*-subtle` band with a status glyph and ordinary text colours.
Tone lives in the fill and the glyph, never in a coloured border or the words.
`tone`: `neutral`, `info`, `success`, `warning`, `danger`. Optional `title` (500),
body, and an `action`: one 28px control (44px on touch) that sits level with the first
line of text, so a single-line notice with a button is no taller than one without.

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
No tinted background and no folder corners. Each tab is sized for its 500 weight
(`TabLabel`), so the strip does not shift by a pixel when the current tab changes. The strip is one row that scrolls
sideways when the tabs do not fit (it never wraps, which would strand the
underline on a row with no divider), and it scrolls the current tab into view.

### `NavItem` and the sidebar

A 32px row (`rounded-sm`): a 16px icon in a centred 20px slot, truncated title, optional
mono metadata at the end. The current page is `fill-selected` + `fg` at 500 + a 3px
`accent` bar on the leading edge. The sidebar is `sidebar`, 256px by default, with a 48px
brand row that shares the header's baseline; "New chat" is a full-width `primary` button
with its shortcut as a `KbdHint`. Chat rows and page entries share one inset (`px-3`) and
one icon slot, so a selected page's pill and accent bar sit on the same edges as a
selected chat's and a page's label starts at the same x as a chat's title. A chat row adds
a git glyph and a runner dot, and from 320px wide the mono runner name beside the dot; both
yield to the rename and delete buttons on hover (on a coarse pointer, which has no hover,
only the open chat's row shows them, so the other rows keep their width for the title). Below 320px the dot stands alone, because
every character the metadata keeps is one the title loses (the name stays in the document,
so search and screen readers still read it). Home and Gallery do not share a glyph family:
a house and a grid, not two near-identical squares.

### `PickOneRow`

One entry of a list where exactly one is current (`components/settings/`): an agent to edit,
the place a key is stored. A `rounded-sm` row with a `stroke` hairline, a 16px glyph, a
title at 14px (500 while current) and one 12px line in `fg-muted`. The current row wears
the navigation's mark — `fill-selected` and the 3px `accent` bar — and the others are
`control` (inside a card or a dialog) or `surface` (`onCanvas`, straight on the page) with
a hover fill. The row is a `<label>` around a visually hidden radio, so the list is a real
radio group inside a `role="radiogroup"` that names it: one tab stop, arrow keys move the
choice, and a screen reader hears one choice rather than a set of toggles. A choice that is
listed but cannot be taken (`disabled`) does not fade, because its name is information
([decision 17](./decisions.md)): the glyph keeps its strength (an agent's identity dot stays
its hue), the name steps from `fg` to `fg-muted`, the hover goes, the radio cannot be focused,
and the row says why: in its description line, or in a status `Badge` beside the name
(`warning` for a sign-in the person can fix). It is the only pick-one idiom: the add-environment dialog's "how do you reach it", the WSL
distribution list, the container engine, the onboarding end state and the setup wizard's
"Choose who answers" all use it, and the
bordered check-mark tile they replaced no longer exists. Not for a short set of labels
(`SettingsSegmented`: the consent profiles, the avatar mode) and not for a pick-several
list (`CheckboxRow`).

### `Header`

48px, `canvas`, a `stroke` bottom border. Left: the runner picker, on the pages where a
chat starts or runs (Home and a chat) and nowhere else, then the workspace context.
Right: the command palette and the account block (the name, then Sign out), both at the
default `md` size so the cluster reads in one 14px size. Below `md` the sidebar is a slide-over,
so the header keeps "New chat" and folds the palette, Settings and Sign out into one account
`Menu` behind a single glyph; the runner's name keeps the row. From `md` up the header does not
repeat what the sidebar already shows. Every button is `subtle`;
there is no primary action in the header.

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

Top-right, 16px under the header (`top-16 right-4`), so it never covers a region's primary
action: the bottom corner is where the composer's Send sits. 360px (never wider than the
screen), `surface-raised`, `stroke` border, `rounded-md`, `shadow-popover`. The type shows in the **glyph** only (`success`, `danger`,
`info`); the message stays in `fg`. The stack is a labelled, polite live region and an
error toast is also an `alert`, so a toast is announced as well as seen. It dismisses after
4s, and the clock stops while the pointer is over the toast or focus is inside it; an error
that needs action belongs in a `Callout`, not a toast.

## The chat's own components

### Composer (`InputBar`)

`surface`, `stroke` border, `rounded-lg` — and the one surface that wears the
runner's identity. `--composer-accent` (from the chat's runner) colours the border
while focused, the prompt mark `›`, the caret and the runner's own chip. Send is
**always** the product `accent`: one primary action, one colour, whoever is
answering. A status line on top carries mono `key: value` chips separated by `·`,
closed by a `stroke` line; the tool row below uses the same borderless chips (28px, a
leading glyph, lowercase), with the `stroke` hairline returning only below `sm`, where
the label is gone and a bare 44px square on a screen with no hover needs something to say
it is a button. A toggle chip is `aria-pressed`: on, it takes `fill-selected` (the open
menu's wash) and tints its leading icon with `--composer-accent`, so on and open
never look alike; `create images`, which has no value chip beside it, also shows a
check from `sm` up. Below `sm` the tool chips are icon-only and their glyph is centred
in the square. Every chip that does something shows the pointer cursor and a static one
does not, which is what tells a toggle with no value beside it (`thinking`) from a fact.

The context ring is a 16px glyph with the figure beside it (`62%`, mono, 12px,
`fg-muted`) in the strip, and the 20px ring with the figure inside it in a sidebar
row, where a title is truncating next to it. The arc is `fg` while usage is normal
or informational and turns `warning` and `danger` as the tracker escalates; mango
is not used, because a healthy 62% is not the primary action, the current item or
focus. The track under it is the `stroke` hairline: a gauge's track is structure,
and an arc drawn over `fg-subtle` fused with it at 16px, so 62% read as a full ring.

### Timeline and tool blocks

The assistant turn is a 1px `stroke-strong` rail with 7px nodes: `fg-subtle` at
rest, `success` when finished, `danger` on error, `accent` while running (pulsing).
Tool blocks are `surface` cards with a 32px mono header and their output in mono on
`canvas`. The user's message is a `surface` balloon with a `stroke` border and
`rounded-lg`. Cards in a turn (task list, subagent trace, question, approval, notice,
error) end where the prose bubble ends: they sit one indent in from the rail, so they are
capped at `--timeline-card-max` (the 42rem measure minus that indent) rather than the full
measure. Tool rows and tool output are not cards and keep the whole column.

### Markdown

Headings are Inter 600; inline code is mono on `fill-selected` with `rounded-xs`;
code blocks are `surface` with a `stroke` border (Shiki keeps its own theme
background); links are `accent-fg`; a blockquote's rule is `stroke-strong`, not an
accent. A table sits in a `.markdown-table-scroll` wrapper that scrolls sideways
when its columns need more than the bubble, and inline code in a cell never
breaks at a hyphen. A labelled code block has a 2.5rem header row above its first line: the
language label sits at its left (1rem in) and the copy button at its right (0.5rem
in), both in a 28px box at a 0.5rem top inset so they share one vertical centre. The
label is always shown and never fades, because it never covers code. An unlabelled
snippet keeps the plain `1em` padding. The label is positioned against the block, so
it scrolls away with the code when a wide block is scrolled sideways. The table wrapper
draws a thin always-visible scrollbar with a track, so a table cut off at its third column
reads as scrollable.
