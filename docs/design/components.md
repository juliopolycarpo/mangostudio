# Components

The shared components in `apps/frontend/src/components/ui/`, `components/settings/` and
`components/layout/`, a few feature-owned pieces that other features copy (named with
their file), and the parts of the chat that carry the product's own dialect (composer,
timeline). Token names and utilities are defined in [`foundations.md`](./foundations.md).
Reach for one of these before repeating its classes. If you need a variant that does not
exist, add it to the component, not to the call site.

Every entry gives the component's purpose, its variants and sizes, the props that change
how it looks or behaves, and its accessibility contract. Icon sizes are the three constants
in `lib/icon-sizes.ts`: `ICON_SM` (14px), `ICON_MD` (16px) and `ICON_LG` (20px).

## Actions

### `Button`

The one button (`ui/Button.tsx`): flat, weight 500, `rounded-sm`, transitions colour only.
Hover and press shift the fill. There is no shadow, no scale on press and no glow.

| `variant`       | Fill                                                        | Use                                                               |
| --------------- | ----------------------------------------------------------- | ----------------------------------------------------------------- |
| `primary`       | `accent`, text `on-accent`                                  | **One** per region: Send, Save, New chat. The default.            |
| `secondary`     | `control` + `stroke` border                                 | Alongside the primary: Cancel, Discard. An empty state's action.  |
| `subtle`        | none; hover `fill-hover`, press `fill-pressed`              | Toolbars, the header, row actions, icon buttons.                  |
| `subtle-danger` | none, text `fg-muted`; reached: `danger` on `danger-subtle` | A destructive action that is not the final confirmation.          |
| `danger`        | `danger-solid`, text `on-danger`; hover brightens           | The final confirmation of something destructive, inside a dialog. |

| `size`    | Box   | Use                                                                                              |
| --------- | ----- | ------------------------------------------------------------------------------------------------ |
| `sm`      | 28px  | Dense bars and rows; text at 12px, its glyph `ICON_SM`.                                          |
| `md`      | 32px  | The default; text at 14px, its glyph `ICON_MD`.                                                  |
| `lg`      | 40px  | The main action of sign-in, sign-up and onboarding; onboarding's Back and Skip share its height. |
| `icon`    | 32×32 | An icon-only button.                                                                             |
| `icon-sm` | 28×28 | An icon-only button in a dense row: the sidebar's rename and delete, a gallery tile's download.  |

- **`loading`** shows a spinner, disables the button, sets `aria-busy` and keeps the
  variant's colour, so "working" never looks like "unavailable".
- **Disabled** is not the variant faded. `primary`, `secondary` and `danger` turn into a
  neutral grey tile (`fill-selected` + `fg-subtle`, no border). `subtle` and
  `subtle-danger` have no tile to turn grey, so they only turn their text `fg-subtle`
  ([decisions 10 and 14](./decisions.md)): an inactive control must not look like the
  hovered or selected one.
- **`subtle-danger`** (Remove, Revoke, Delete on a row) rests in `fg-muted` and turns
  `danger` text on a `danger-subtle` fill on hover, keyboard focus and press
  ([decision 22](./decisions.md)). It rests
  quiet because it repeats: a list whose every row ends in a red trash can is a column of
  red that outshouts the rows. It is never a `subtle` button with a `text-danger`
  override, which loses the press state and hovers neutral beside its siblings.
- **Accessibility.** An icon-only button carries an `aria-label`; an icon-only
  `subtle-danger` button carries both `aria-label` and `title`, so the verb is
  discoverable by pointer too. On a coarse pointer every button grows to the 44px touch
  floor ([decision 15](./decisions.md)).

`buttonClassName(variant, size)` returns the same classes for something that must look
like a button but cannot be a `<button>`: a router `<Link>`, a download `<a>`.

### `SplitButton`

A primary action with a menu of its variants attached ("Commit" / "Commit and push"). Use
it only when the alternatives are variations of the same action.

- Both halves are `Button size="sm"`; the divider is a 1px `accent-pressed` line.
- While the primary half is disabled it is the neutral grey of any disabled button, so
  the chevron drops to `secondary` and the divider to its `stroke` border: the menu must
  not be the only mango in the region. A primary half that is only `loading` keeps its
  accent, and so does the chevron.
- `menuDisabled` is separate from `disabled`, because the menu's actions have their own
  preconditions. `menu` takes `MenuItem` and `MenuSeparator` children; `open` and
  `onOpenChange` are controlled.
- **Accessibility.** `menuLabel` is the chevron's `aria-label` and `title`.

### Controls on a picture (`MEDIA_CONTROL_CLASS`)

A control laid on the `scrim-media` veil (the gallery lightbox's Close, a gallery tile's
download) is a `subtle` button plus `MEDIA_CONTROL_CLASS`
(`features/gallery/components/media-control.ts`). The veil is the same black in both
themes, because a photograph is not themed, so the control cannot be themed either: the
glyph is `on-scrim-media`, hover and press are `fill-media-hover` and `fill-media-pressed`,
and the focus outline is `on-scrim-media`, since the light theme's dark `focus` would
vanish on the veil. Do not use `secondary` there: its `control` fill follows the theme
and drew a bright white tile on black in the light theme. The lightbox's Download stays
`primary`, with the same `on-scrim-media` focus outline ([decision 23](./decisions.md)).

## Input

### `Input`

A 32px text field: `control` fill, a `stroke` border on three sides and `stroke-strong`
underneath (the line that says "this is a field"). Hover goes to `control-hover`. Focus
swaps the border for `focus` and adds a 1px ring. Disabled fades to 50%.

- **`label`** sits above the field at 14px/500 and is always visible.
- **`hint`** sits under the field in 12px `fg-muted`. It is the instruction ("Days,
  1–365"), which a placeholder never is.
- **`error`** sets `aria-invalid`, turns the border `danger` and replaces the hint with
  the message and a `CircleX` glyph. A field shows one message at a time.
- **`placeholder`** is an example value in `fg-subtle`, never the instruction.
- **Accessibility.** The label is a `<label htmlFor>`. The hint or error is added to the
  field's `aria-describedby`, after any id the caller passes.

`FIELD_CLASS` is the field's class string, exported so an inline field (the sidebar
search, a rename input, the collapsed settings nav) has the same face.

### `Textarea`

A multi-line field in the same face (`FIELD_CLASS`), at least 96px tall (`min-h-24`),
resizable vertically only. Mono for a prompt or other technical text is a call-site
`className`. It has no `label` prop: name it with `SettingsField` or a `<label htmlFor>`.

### `Select`

The form dropdown: `Input`'s face with a `ChevronDown` in `fg-muted`. It replaces the
native `<select>`, whose OS-drawn popup no CSS can style.

- The listbox is a `.dropdown-panel` rendered into `document.body` and placed by hand
  under the trigger, so a scrolling dialog cannot clip it. It is capped at 256px. It
  opens above the trigger only when less than 96px is free below and more is free above.
- Rows are 32px at 14px, with an optional 12px `fg-muted` `description` line. Hover and
  the keyboard cursor use `fill-hover`, the selected option `fill-selected` and weight
  500, and the only accent is the check in `accent-fg`. A disabled option fades and
  cannot be picked. A long list scrolls with the thin `app-scrollbar`.
- `placeholder` shows when `value` matches no option (a model the catalog no longer
  lists).
- **Accessibility.** The trigger is `role="combobox"` with `aria-expanded` and
  `aria-activedescendant`; focus stays on it while the arrow keys move the cursor. Name it
  with `id` plus a `<label htmlFor>`, or with `ariaLabel`.

### `ChipSelect`

The composer's `key: value` dropdown: a `.composer-chip` trigger (at most 13rem wide) with
an optional `icon`, an `adornment` (a status dot) and a `label` as the key. It shares
`Select`'s keyboard model and row anatomy, so two menus opened from one strip match.

- **`placement="above"`** (the default) opens a `ComposerPopover`, docked 8px above the
  composer shell with its left edge level with the chip. Use it on the composer, at the
  foot of the viewport.
- **`placement="below"`** opens a panel hanging off the chip. Use it in the header or a
  page's title row, where an upward panel would open above the window and be clipped.
- The panel scrolls past half the viewport (`max-h-[50vh]`) with the thin
  `app-scrollbar`. `panelClassName` sets its width (`w-56` by default).
- An open chip takes `fill-selected`. A disabled chip fades to 50%; once its answer is
  settled for good, use `LockedChip` instead.
- **Accessibility.** `ariaLabel` is required, because a chip's visible text is a fragment.
  `describedBy` and `title` pass through to the trigger.

### `Checkbox` and `Radio`

`Checkbox` is a 16px box with `rounded-xs` and a `stroke-strong` border; checked, it
fills `accent` with an `on-accent` tick. `Radio` is the same box with a round face and an
`on-accent` dot, so the two read as one family. Both keep a real `appearance: none` input
rather than a hidden proxy, so the thing the pointer hits is the thing the browser
checks.

- Disabled fades the whole control to 50% (on the wrapper, so tick and box fade
  together).
- **Touch.** The 16px box does not grow: the 44px floor skips it. A pseudo-element on
  the input widens the hit area to 40px, so a tap beside the box still toggles it, with
  or without a wrapping `<label>`.
- **Accessibility.** Give each one a `<label>` or an `aria-label`.

### `Toggle` and `ToggleSwitch`

The preference switch: a 36×20 track with a 12px knob. Off is `control` with a
`stroke-strong` border and an `fg-muted` knob that turns `fg` on hover; on is `accent`
with an `on-accent` knob. The knob does not grow and has no shadow. Disabled fades the
track to 50%.

- `ToggleSwitch` is the bare switch, for a row that is itself the `<label>`
  (`SettingToggle`, a rule file's path row).
- `Toggle` adds its own 14px label to the right. It derives the input's id from the label
  unless you pass `id`; pass one when two toggles on a page share a label.
- Use a switch for a setting that takes effect at once, and a checkbox for an option in a
  form or a list.
- **Accessibility.** The input is a visually hidden checkbox with `role="switch"`; the
  focus outline is drawn on the track. A bare `ToggleSwitch` needs an `aria-label`.

### `SettingsSegmented`

A row of two to four mutually exclusive segments (`components/settings/`): the 32px
`rounded-sm` face of a secondary button, `control` fill and `fg-muted` text at rest. The
selected segment is a neutral `fill-selected` with a `stroke-strong` border, `fg` text and
a 2px `accent` bar along its bottom edge, the mark of the current underline tab. It is
never the accent fill of a primary button, which would put a second primary next to Save
([decision 16](./decisions.md)). A longer list belongs in a `Select`.

- **`kind="buttons"`** (the default): pressed and unpressed buttons (`aria-pressed`) in a
  group named by `ariaLabel`, for a choice that applies at once.
- **`kind="radio"`**: a native radio group (`role="radiogroup"`, arrow keys move the
  choice) for a choice inside a record, such as a rule file's role and frequency. Pass a
  `name` unique on the page.

### `PickOneRow`

One entry of a list where exactly one is current (`components/settings/`): an agent to
edit, the place a key is stored. Use it for any pick-one list whose entries need more than
a word: the add-environment dialog's "how do you reach it", the WSL distribution list, the
container engine, the onboarding end state and the setup wizard's "Choose who answers"
all use it. The bordered check-mark tile it replaced no longer exists. It is not for a
short set of labels (`SettingsSegmented`: the consent profiles, the avatar mode) and not
for a pick-several list (`CheckboxRow`).

- **Anatomy.** A `rounded-sm` row with a `stroke` hairline: a 16px `icon` in `fg-muted`, a
  `title` at 14px (500 while current) and one 12px `description` line in `fg-muted`. The
  description truncates, and a string description is also the row's `title` tooltip.
- **Current.** The navigation's mark: `fill-selected` and the 3px `accent` bar
  (`SELECTION_BAR`).
- **Surface.** Other rows are `control` (inside a card or a dialog) or `surface` with
  `onCanvas` (straight on the page), each with its hover fill.
- **`disabled`** is a choice that is listed but cannot be taken. It does not fade,
  because its name is information ([decisions 17 and 21](./decisions.md)): the glyph keeps its
  strength (an agent's identity dot stays its hue), the name steps from `fg` to
  `fg-muted`, the hover goes, the cursor is `not-allowed` and the radio cannot be focused.
  The row says why, in its description or in a status `Badge` beside the name (`warning`
  for a sign-in the person can fix).
- **`testId`** lands on the radio input, the element that is checked and disabled.
- **Accessibility.** The row is a `<label>` around a visually hidden radio; every row of
  one list shares `name`. Wrap the rows in `role="radiogroup"` with an `aria-label` that
  names the choice: one tab stop, arrow keys move the choice, and a screen reader hears
  one choice rather than a set of toggles.

### `CheckboxRow`

One option in a pick-several list (`components/settings/`): a `Checkbox` and its 14px/500
`label` in a `control` row with a `stroke` hairline, the whole row the click target. An
optional `description` is a technical second line in mono 11px `fg-muted` (an identifier,
a slug). The checked box is the only accent, so a screenful of rows stays neutral.
Disabled fades the row to 50%, once (the box inside does not fade a second time).

### `ChoiceButton`

One answer on a question or form card in the chat
(`features/chat/components/ChoiceButton.tsx`, used by `QuestionCard` and
`ElicitationCard`). A bordered `rounded-sm` row whose 16px leading face says what a click
does: `kind="one"` draws a round face (pick one), `kind="several"` a square one (pick
several), the shapes of `Radio` and `Checkbox`. Picked, the face fills `accent` (a dot or a
tick in `on-accent`) and the row takes `fill-selected`. A read-only card (already
answered) keeps full-strength text, because the pick is the record.

- **Accessibility.** The button carries `aria-pressed`. The card puts the options in a
  `fieldset` named by the question (`aria-labelledby`), so a pressed button reads as one
  answer among its siblings.

## Status

### `Badge`

A 20px pill, 12px/500, sentence case, never upper-cased. Pills are reserved for status:
nothing clickable is round. It carries a word or an icon, so colour is never the only
signal.

| `variant` | Fill             | Text        |
| --------- | ---------------- | ----------- |
| `neutral` | `fill-selected`  | `fg-muted`  |
| `accent`  | `accent-subtle`  | `accent-fg` |
| `success` | `success-subtle` | `success`   |
| `warning` | `warning-subtle` | `warning`   |
| `error`   | `danger-subtle`  | `danger`    |
| `info`    | `info-subtle`    | `info`      |

A badge that states a live state (an MCP server's last-known connection) may lead with a
`StatusDot`, so it cannot be mistaken for the neutral metadata badges beside it
(transport, environment).

### `StatusDot`

An 8px dot. `tone`: `accent`, `success`, `warning`, `error`, `neutral` (`stroke-strong`).
`pulse` is for a state that is getting somewhere (connecting, probing), not one that has
arrived. A runner's identity dot is a `StatusDot` whose colour comes from
`lib/agent-identity` through `className` (`MANGO_IDENTITY.dotClass`,
`agentIdentityTokens(targetId).dotClass`).

- **Accessibility.** It is `aria-hidden`. Never use it alone: it accompanies visible
  text, `sr-only` text, or sits inside a control that has an `aria-label`.

### `Chip`

The `key: value` pair outside the composer (`.terminal-chip`): mono 12px, 24px tall,
`rounded-sm`, a `stroke` hairline, no fill. The key (`label`) is `fg-muted`, the value
`fg`. A static chip is information. With `onClick` it becomes a button with a
`fill-hover` hover, and disabled fades to 50%.

The composer does not use `Chip`: its strip draws the borderless `.composer-chip`
(see the composer section), and `ChipSelect` and `LockedChip` wear that class.

### `LockedChip`

The composer chip for a fact rather than a choice: what a `ChipSelect` becomes once its
answer is settled (the agent and the environment after a chat's first turn, the
environment when there is only one). Key in `fg-muted`, value in `fg`, no chevron, and
the `reason` as its `title` and as `sr-only` text, because a tooltip is not announced and
does not exist on touch. It is not drawn at 50% like a disabled control, because the text
is information ([decision 18](./decisions.md)). Its wrapper mirrors `ChipSelect`'s, so the
strip's `·` sits beside it in the same place.

### `KbdHint` and `MicroLabel`

`KbdHint` is a 20px keycap (`rounded-xs`, `control` fill, `stroke` border, mono 11px in
`fg-muted`) for a shortcut, right-aligned where the action lives.

- The Return key is drawn as an icon (`<KbdHint keys={<ReturnKey />} />`), not as the `⏎`
  text glyph, which is hairline-thin at 11px and left the keycap looking empty. The
  palette's footer draws its other keys the same way (`ArrowUpDown`, `ArrowRightToLine` at
  `ICON_SM`).
- No keycap is drawn on a coarse pointer: a touch screen has no Esc or Ctrl+N. `KbdHint`
  carries `pointer-coarse:hidden` itself, so call sites do not add it, and a caller's
  `sm:inline-flex` cannot bring it back. The palette's footer hides with it.
- **Accessibility.** The keys are `aria-hidden`, so the hint never renames the button it
  sits in ("Send", not "Send ⏎").

`MicroLabel` is the group heading (`.micro-label`): mono 11px, weight 500, upper-case,
`0.06em` tracking, `fg-subtle`. It is the one place text is upper-cased. Pass `as="h2"` or
`as="h3"` when it heads a section.

### `Callout`

An inline notice: a `rounded-md` band in the tone's fill, a status glyph at `ICON_MD`, a
title in `fg` at 500 and a body in `fg-muted`. Tone lives in the fill and the glyph, never
in a coloured border or in the words.

| `tone`              | Fill             | Glyph                        |
| ------------------- | ---------------- | ---------------------------- |
| `neutral` (default) | `fill-selected`  | `Info` in `fg-muted`         |
| `info`              | `info-subtle`    | `Info` in `info`             |
| `success`           | `success-subtle` | `CircleCheck` in `success`   |
| `warning`           | `warning-subtle` | `TriangleAlert` in `warning` |
| `danger`            | `danger-subtle`  | `CircleX` in `danger`        |

- **`action`** is one `sm` control (28px, 44px on touch) that sits level with the first
  line of text, so a single-line notice with a button is no taller than one without. In a
  narrow column (the workspace rail, which can be as narrow as 280px) put the action under
  the body instead, or the text is squeezed to a sliver.
- **`icon`** replaces the tone's glyph; `null` draws none.
- **Accessibility.** The glyph is `aria-hidden`. Pass `role="status"` or `role="alert"`
  when the notice appears in answer to something the person just did.

Use a `Callout` for a notice the person has to read or act on. For a one-line result
beside the thing it reports on, use `StatusNote`.

### `StatusNote`

A one-line result inside a row or a card (`components/settings/`): an `ICON_SM` glyph in
the status colour and the words in 12px `fg-muted`. `tone`: `success` (`CircleCheck`),
`warning` (`TriangleAlert`), `danger` (`CircleX`), `info` (`Info`). `as="span"` for a
phrasing-only parent such as a `<label>`. Use it for a test result, a skipped entry, a
read that failed: the quiet kind of status that needs no action.

### `Spinner` and `Skeleton`

`Spinner` is a 2px ring: a `stroke-strong` track with an `accent` arc. `size`: `sm`
(16px) inside buttons and rows, `md` (24px, the default) inline, `lg` (40px) for a page
waiting on data.

- **`label`** names the wait. With it, the spinner is `role="status"` with the label as
  `sr-only` text: pass it wherever the spinner stands alone. Without it, the spinner is
  `aria-hidden`: leave it off where words already sit beside it ("Saving…"), or the wait
  is announced twice.

`Skeleton` (`.skeleton-block`) is a `fill-selected` block that pulses opacity, with no
shimmer gradient. Shape and size come from `className`. It is `aria-hidden`, so the
region that shows skeletons also carries the word for a screen reader (as
`SettingsLoading` does). Both animations stop under `prefers-reduced-motion`.

### `EmptyState`

A centred block for an empty list, a clean tree or a search with no results: an icon, a
title at 14px/500 in `fg`, a `hint` at 12px in `fg-muted` (at most 320px wide) and an
optional `action`. No illustrations and no coloured disc behind the icon.

- **`icon`** is a Lucide glyph at `ICON_LG` (20px). The conformance test rejects an
  `EmptyState` icon whose `size` is a literal number.
- **`tone`** colours the icon only: `neutral` (default) is `fg-subtle`, a step quieter
  than the title, because the glyph is decoration and the words are the message;
  `success`, `warning` and `error` carry their meaning in the colour.
- **`action`** is a `secondary` `sm` button, with a leading `ICON_SM` glyph (`Plus` for an
  action that adds something). While the empty state shows, the page does not draw a
  header button that does the same thing ([`patterns.md`](./patterns.md)).

### `ToolAvatar`

The chip that stands in for a tool: its own image, or a monogram of up to two characters
on a colour derived from its `subjectKey` (`<kind>:<id>`), so renaming a tool does not
change its colour. The palette in `ui/tool-avatar-palette.ts` gives each slot a stated
background and foreground per theme, so the monogram's contrast is tested, not hoped for.
A failed image load falls back to the monogram.

| `size`         | Box  | Radius       | Use                                           |
| -------------- | ---- | ------------ | --------------------------------------------- |
| `2xs`          | 16px | `rounded-xs` | Inline in a chat timeline row.                |
| `xs`           | 20px | `rounded-xs` | Dense lists (the capability inspector).       |
| `sm`           | 24px | `rounded-sm` | Compact rows: an MCP server, a version table. |
| `md` (default) | 36px | `rounded-md` | A tool's identity header.                     |
| `lg`           | 48px | `rounded-lg` | The identity editor's preview.                |

`TOOL_AVATAR_SIZE_CLASS` exports the same box classes for a chip drawn beside an avatar.

- **Accessibility.** The avatar is `aria-hidden` with the tool's `name` as its `title`:
  every surface prints the name next to it, so announcing it would say the name twice.

## Navigation

### `TabNav`

Underline tabs for sibling subpages, one bookmarkable URL per tab. Tabs are 36px,
`fg-muted` at rest with a `fill-hover` hover, and `fg` at 500 when current, with a 2px
`accent` underline sitting on the divider. No tinted background and no folder corners.

- Each tab is sized for its 500 weight (`TabLabel`), so the strip does not shift by a
  pixel when the current tab changes.
- The strip is one row that scrolls sideways when the tabs do not fit. It never wraps,
  which would strand the underline on a row with no divider, and it scrolls the current
  tab into view.
- **`exact`** lights a tab only on its own URL: a surface root whose path prefixes its
  siblings would otherwise stay lit on all of them.
- **`current`** lights a tab whose URL the page does not live under: a resource's own page
  lights the tab of its kind.
- Strips may nest: a section with a second level renders its own strip under its parent's.
- **Accessibility.** The strip is a `<nav>` named by `label`. The current tab carries
  `aria-current="page"`, including one forced by `current`. The focus ring is drawn
  inside the tab, so the scrolling list cannot clip it.

### `Tabs`

The same look as `TabNav` for views held in state rather than in the URL: the git panel's
Changes and History, the terminal's sessions, a repository's sections. `TAB_CLASSES` holds
the look once for both, so neither can drift.

- `active` may be `null` (a session strip before one opens). `trailing` sits after the
  tablist (the button that adds a tab).
- A tab can carry `actions` (close, rename) after its label; the tab is a Tailwind
  `group`, so an action can reveal itself with `group-hover:`. `editor` replaces the label
  while renaming in place, and the arrow keys skip that tab. `title` is a tooltip for a
  truncated label.
- **Accessibility.** `role="tablist"` named by `label`, `role="tab"` with
  `aria-selected`. The strip is one tab stop (the selected tab); Arrow keys, Home and End
  move between tabs and select as they go, wrapping at the ends.

### `NavItem` and the sidebar

`NavItem` (`features/sidebar/components/NavItem.tsx`) is one page entry. On the desktop
rail it is a 32px `rounded-sm` row: a 16px icon in a centred 20px slot, a truncated 14px
label and, when `badgeLabel` is set, a warning count at the end (a `warning-subtle` pill,
mono 11px). On the phone's shortcut grid (`orientation="vertical"`) it is a 20px icon over
a 12px label, with no count. The current page is `fill-selected` + `fg` at 500, and on the
rail also the 3px `accent` bar (`SELECTION_BAR`) on the leading edge; it carries
`aria-current="page"`.

The sidebar is `sidebar`, 256px by default and resizable from 240px to 420px, with a 48px
brand row that shares the header's baseline. "New chat" is a full-width `primary` button
with its shortcut as a `KbdHint`. Chat rows and page entries share one inset (`px-3`) and
one icon slot, so a selected page's pill and accent bar sit on the same edges as a selected
chat's, and a page's label starts at the same x as a chat's title. A chat row adds a git
glyph and the runner's identity dot in mono 11px `fg-subtle`. From 320px wide the branch
name and its ahead/behind counts join the glyph, and the runner's name joins the dot. That
metadata yields to the rename and delete buttons (`icon-sm`; `subtle` and `subtle-danger`)
on hover and keyboard focus. On a coarse pointer, which has no hover, only the open chat's
row shows them, so the other rows keep their width for the title. Below 320px the dot
stands alone, because every character the metadata keeps is one the title loses (the name
stays in the document, so search and screen readers still read it). Home and Gallery do
not share a glyph family: a house and a grid, not two near-identical squares.

### `EdgeResizeHandle`

The drag edge of a resizable pane (`components/layout/EdgeResizeHandle.tsx`), shared by the
sidebar and the workspace rail. An 8px hit area straddles the pane's edge at all times. The
visible mark, a 4×48px `rounded-xs` pill, is drawn only on hover (`stroke-strong`) and on
keyboard focus (`focus`): at rest a pill on every edge read as a stray scrollbar thumb.

- **Keyboard.** The arrow keys move the edge 16px, Home and End jump to the minimum and
  maximum. The width is saved once, on pointer-up, key-up or blur, so a held key is one
  settings write.
- **Accessibility.** A focusable `<hr>` with `aria-orientation="vertical"`, named by
  `label`, carrying `aria-valuemin`, `aria-valuemax` and `aria-valuenow`.

### `Header`

48px, `canvas`, a `stroke` bottom border (`components/layout/Header.tsx`). Every button is
`subtle`; there is no primary action in the header.

- **Left:** below `md`, the menu button that opens the sidebar slide-over. Then the runner
  picker, on the pages where a chat starts or runs (Home and a chat) and nowhere else;
  the environment chip from `sm` up; the workspace context from `md` up.
- **Right:** an external runner's quota pill when there is one. From `md` up, the command
  palette (a search glyph and its `KbdHint`) and the account block (the name, then Sign
  out), both at the default `md` size so the cluster reads in one 14px size. From `md` up
  the header does not repeat what the sidebar already shows.
- **Below `md`** the header keeps "New chat" (glyph only below `sm`, named by
  `aria-label` and `title`) and folds the palette, Settings and Sign out into one account
  `Menu` behind a single `UserRound` glyph, so the runner's name keeps the row.

### Runner picker

The header's runner trigger (`components/layout/RunnerSelector.tsx`) is a `subtle` button:
a `StatusDot`, the runner's name and a chevron, with `fill-selected` while open.

- **The dot is identity.** It is the runner's colour (`agent-mango`, or `agent-<target>`
  through `lib/agent-identity`), the same dot the sidebar, the palette and Home draw. It is
  never availability and never the accent.
- **Availability is a glyph after the name**, at `ICON_SM`, drawn only when the runner
  cannot take a turn, or when that is not yet known: `Info` in `fg-muted` for a runner
  that is absent here, `TriangleAlert` in `warning` for one that is fixable or whose
  sign-in or discovery is unknown, `CircleX` in `danger` for a fault, `Spinner size="sm"`
  while discovery loads. A ready runner shows no glyph, so a healthy header carries no
  status colour.
- **Accessibility.** The trigger's `aria-label` names the control ("Who runs this chat");
  the availability sentence is its `aria-describedby` and the glyph's `title`.

Rows in the open picker carry the same identity dots, kept at full strength on a disabled
row, whose name steps down to `fg-muted` ([decisions 17 and 21](./decisions.md)).

### `Menu`

`Menu`, `MenuItem` and `MenuSeparator` render a `.dropdown-panel` (solid `surface-raised`,
`stroke` border, `rounded-md`, `shadow-popover`, 4px padding) below the trigger, aligned
`right` by default (`align="left"` to flip), `w-56` unless `panelClassName` says otherwise.

- Items are 32px, `rounded-sm`, 14px, with a 16px icon in `fg-muted`. Hover uses
  `fill-hover`; keyboard focus draws the shared focus outline. A disabled item fades to 50%.
- `checked` makes an item a toggle with a check in `accent-fg`.
- A destructive item (`tone="danger"`) goes last, after a separator, in `danger` text with
  a `danger-subtle` hover; its icon stays `fg-muted`.
- **Accessibility.** `trigger` is a render prop: spread the props it receives
  (`aria-haspopup="menu"`, `aria-expanded`, `onClick`) onto the trigger. Items are
  `role="menuitem"`, or `menuitemcheckbox` with `aria-checked` when `checked` is set. Arrow
  keys move between items; Escape closes the menu (and only the menu, inside a dialog) and
  returns focus to the trigger.

## Containers

### `Card` and `SectionCard`

`Card` is a flat `surface` with a `stroke` border and `rounded-md`, padded `p-4` and
`sm:p-6`. For any other padding pass `padded={false}` and put the padding in `className`
(`<Card padded={false} className="p-4">`): a bare `p-4` override would still be `p-6` from
`sm` up. A card that holds a list of rows is `padded={false}` with
`divide-y divide-stroke`, and the rows carry their own `px-4 py-3`. `Card` does not forward `data-*`
attributes; put a test id on a wrapper.

`SectionCard` is a card padded `p-4`, headed by a `MicroLabel` (an `h3`) with an optional
`StatusDot` (`tone`) and an `action` on the right. Use it for a few facts grouped under one
heading, as the workspace hub does. Inside a staggered grid it takes the grid's entrance
animation; elsewhere it mounts plain.

Never nest a card in a card; inside one, divide with a `stroke` line.

### `Dialog`

The modal frame every dialog shares (`ui/Dialog.tsx`): a flat `scrim` backdrop and a
`surface-raised` panel with a `stroke` border, `rounded-lg` and `shadow-dialog`
(`DIALOG_SURFACE_CLASS`, which the command palette also wears). Inside: a header at 24px
padding with a left-aligned `text-title` (20px/600) title, a body that scrolls when the
dialog outgrows the viewport, and a footer on `canvas` above a `stroke` line with the
actions right-aligned at natural width, the quiet one first and the primary last.

| `size`         | Width       | Use                                             |
| -------------- | ----------- | ----------------------------------------------- |
| `sm`           | `max-w-sm`  | A question: a sentence and two buttons.         |
| `md` (default) | `max-w-lg`  | A form or a short list.                         |
| `lg`           | `max-w-3xl` | A list of steps, a table of commands, a wizard. |

- **Name.** Either `title` (the visible title, also the accessible name) or `ariaLabel`
  for a dialog with no visible title. The types allow one or the other, never neither.
- **Slots.** `description` is one muted sentence under the title. `eyebrow` is a line
  above the title, `leading` an element before it (an avatar), `headerAction` a control on the
  title line (Close, for a dialog with no Cancel). `toolbar` is pinned between header and
  body (a search field, a step bar). `notice` is a `Callout` between body and footer, so a
  failure stays in view. `truncateTitle` keeps a title that holds a person's own text on
  one line.
- **`flush`** hands the body to a layout with its own panes and scroll regions: no
  padding, no scroll, and a hairline under the header.
- **`onSubmit`** wraps the dialog in a `<form>`, so the footer's submit button submits it.
- **`closeDisabled`** makes Escape and the backdrop do nothing, as a disabled Cancel does,
  while a write is in flight.
- **Accessibility.** `role="dialog"`, `aria-modal`, named by the title and described by
  `description`. Focus moves in (unless a control inside takes it with `autoFocus`), Tab
  stays inside, Escape and a click on the backdrop call `onClose`, and focus returns to
  whatever opened it. A drag that starts in the panel and ends on the backdrop does not
  close it. The dialog mounts on `document.body`, so a transformed ancestor cannot cut
  the scrim short.

### `ConfirmDialog`

A `Dialog` at `size="sm"` for a destructive confirmation. A title in the form of a
question, a `description` that names the consequence, the `entityName` quoted under it in
`fg` at 500 when the title does not already name it, and a footer of `secondary` Cancel
then a `danger` button with the verb. No oversized icon disc. `children` adds controls
(a checkbox) between the copy and the buttons.

- **Accessibility.** Focus lands on Cancel, the safe answer. While `isPending`, the
  confirm button shows its spinner, Cancel is disabled, and Escape and the backdrop wait.

### `Toast`

`ToastProvider` draws the stack; `useToast().toast(message, type)` adds one, with `type`
`success`, `error` or `info` (the default).

- **Position.** Top-right, 16px under the header (`top-16 right-4`), so it never covers a
  region's primary action: the bottom corner is where the composer's Send sits
  ([decision 25](./decisions.md)).
- **Face.** 360px wide (never wider than the screen), `surface-raised`, `stroke` border,
  `rounded-md`, `shadow-popover`. The type shows in the `ICON_LG` glyph only
  (`CircleCheck` in `success`, `CircleX` in `danger`, `Info` in `info`); the message stays
  in `fg`. A `subtle` icon button dismisses it.
- **Timing.** It dismisses after 4s. The clock stops while the pointer is over the toast
  or focus is inside it, and resumes with the time that was left.
- **Accessibility.** The stack is a `region` named "Notifications" and a polite live
  region; an error toast is also `role="alert"`, so a toast is announced as well as seen.
- An error that needs action belongs in a `Callout`, not a toast.

## Settings

The building blocks of every settings page live in `components/settings/`. A page is a
`SettingsPage` holding `SettingsSection`s, which hold `SettingsRow`s.

### `SettingsPage`

The frame of a settings page: a `text-title` heading, an optional `description` in
`fg-muted`, then the page's sections at `space-y-8`. The auto-save indicator and the
`actions` (Add, Refresh, a "last updated" caption) sit right-aligned and centred on the
title's line; on a narrow screen they wrap under the description. No page draws its own title card
or puts an icon tile beside its title.

### `SettingsNav`

The settings navigation: every settings page under its group heading (`MicroLabel` as
`h2`), in one list in the DOM. From `lg` up it is a sticky column on the canvas beside the
content; below `lg` it collapses behind a field-shaped toggle (`FIELD_CLASS`) that names
the current page, and closes on every navigation. The current entry is `fill-selected`,
`fg` at 500 and the `SELECTION_BAR`. The route list lives once in `settings-nav.ts`, which
the command palette also reads.

### `SettingsSection`

A titled group of settings in one flat `Card`: a 16px/600 `title`, an optional
`description` in `fg-muted`, and an `action` (Add, Refresh) centred on the title line.
Omit `title` for the untitled first card under the page title.

- By default the children are `SettingsRow`s divided by `stroke` lines.
- **`padded`** gives free-form content (a preview, a grid of tiles) a `p-4` body instead.
- **`cards`** gives every child its own card, stacked at `space-y-3`, for units of several
  rows such as a rule file: a card edge, not one more hairline, separates them.
- **`notice`** is a `Callout` between the heading and the card.

### `SettingsRow`, `SettingToggle` and `SettingsSliderRow`

`SettingsRow` is one setting: its `label` (14px/500) and `hint` (12px `fg-muted`), and its
control. The row owns its `px-4 py-3` padding; the hairlines between rows come from the
section's card.

| `layout`           | Where the control sits                                                                | For                                                   |
| ------------------ | ------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `inline` (default) | Right of the name, at its own width, at every breakpoint.                             | A switch, a checkbox, a small button or number field. |
| `field`            | Right of the name, 16rem wide, from `sm` up; under the name at full width below `sm`. | A `Select` or a text field.                           |
| `stacked`          | Under the name, full width.                                                           | A slider, a textarea, a segmented control, a path.    |

- `htmlFor` makes the name a `<label>` for the control; `as="label"` makes the whole row
  the label, so a click anywhere on it toggles a lone switch or checkbox.
- `aside` is trailing content on the name's line: a live readout (`30s`) or a small
  action (Reset).

`SettingToggle` is a `SettingsRow` (`as="label"`) whose control is a `ToggleSwitch`. Settings
save as they change, so their on/off control is a switch, not a checkbox.

`SettingsSliderRow` is a `stacked` row whose control is a range slider: a `.range-field`
pill with an `accent` fill over the travelled part, around a `.range-input` thumb. `readout`
is the value in words on the name's line, tabular so the digits do not jitter.
`withNumberInput` adds a `w-32` number field for exact entry, which clamps on blur. A range
with hundreds of steps is a plain number field in an `inline` row instead, because nobody
can set it by dragging.

### `SettingsField`

One field in a record editor: its `label` above (14px/500, a `<label htmlFor>` when
`htmlFor` is set), the control, and a `hint` below (12px `fg-muted`). Use it for a control
that does not draw its own label (`Select`, `Textarea`, a list of rows) and for an `Input`
that needs a hint, so every field in an editor aligns the same way.

### `SettingsLoading`, `SettingsLoadError` and `SettingsSaveIndicator`

`SettingsLoading` is skeleton blocks in the shape of the content, `shape="row"` (32px) or
`"card"` (96px), `count` of them, inside a `role="status"` that also says "Loading" to a
screen reader. No spinner on top: it would say the same thing twice.

`SettingsLoadError` is the failed-load state: a `danger` `Callout` with the `message` and,
when `onRetry` is given, a `secondary` `sm` Retry. It stays on screen until the load works;
a toast is not an error state.

`SettingsSaveIndicator` sits in `SettingsPage`'s header and reports auto-save, since there
is no Save button: a `Spinner` and "Saving…" in `fg-muted`, a `success` check and "Saved"
in `fg-muted`, or a `CircleX` and "Not saved", both in `danger`. It is 12px, in a polite
`role="status"`, and draws nothing while idle. The glyph carries the state and the word
repeats it.

`RuleFileRows` (one prompt rule file as rows of a `cards` section) and
`ThemePreviewSample` (a code sample drawn in a Shiki theme's own literal colours, which
must not follow the app's tokens) are page parts, not primitives.

## Brand

### `Logo` and `BrandLockup`

`Logo` is the product mark as an image; its `alt` defaults to "MangoStudio logo"
(`t.common.mangoStudioLogo`). Size it with `className`.

`BrandLockup` (`components/layout/BrandLockup.tsx`) is the product's name above the pages
that have no shell: sign-in, sign-up and onboarding. The `Logo` at 48px (`size-12`) over
"MangoStudio" at 14px/500 in `fg-muted`, 8px apart. It is a wordmark, not a heading (each
page's own title is its `h1`), and the mark inside it has an empty `alt`, because the word
beside it already names the product. Not Found and the bootstrap error keep the logo inside
their card instead.

## The chat's own components

### Composer (`InputBar`)

`surface`, `stroke` border, `rounded-lg` (`.composer-shell`), and the one surface that
wears the runner's identity. `--composer-accent` (from the chat's runner, through
`features/chat/lib/composer-accent.ts`) colours the border while focused, the prompt mark
`›`, the caret and the runner's own chip. Send is **always** the product `accent`: one
primary action, one colour, whoever is answering.

A status line on top carries mono `key: value` chips (`.composer-chip`: 24px, borderless,
`fg-muted` key, `fg` value) closed by a `stroke` line. From `sm` up the chips are separated
by a `·` that the strip (`.composer-chip-row`) draws itself. Every child of the strip is a
gapless slot around one chip, never the chip itself and never a nested strip; a component
with several chips returns a fragment of slots. The dot has a fixed 8px box and a 4px lead
against the strip's 4px gap, so every chip, dot, chip run is 16px with the dot centred. A
unit test enforces the slot contract.

The tool row below uses the same borderless chips (`.composer-tool-chip`: 28px, a leading
glyph, lowercase), with the `stroke` hairline returning only below `sm`, where the label is
gone and a bare 44px square on a screen with no hover needs something to say it is a
button. A toggle chip is `aria-pressed`: on, it takes `fill-selected` (the open menu's
wash) and tints its leading icon with `--composer-accent`, so on and open never look alike;
`create images`, which has no value chip beside it, also shows a check from `sm` up. Below
`sm` the tool chips are icon-only and their glyph is centred in the square. Every chip that
does something shows the pointer cursor and a static one does not, which is what tells a
toggle with no value beside it (`thinking`) from a fact. Chip hover fills apply only on a
pointer that can hover.

### `ComposerPopover`

The surface every menu over the composer wears (the model, permission, MCP and
slash-command menus, the capability inspector, and every `ChipSelect` that opens upward): a
`.dropdown-panel`, `w-80` by default, docked 8px above the composer shell, whichever chip
opened it. Its left edge stays level with the `anchor` control, clamped so it never
overhangs the composer. The panel's positioned ancestor is `.composer-shell`, so the
wrapper around the trigger must not be `relative`. `animated` fades and rises it in, as
every chip menu does; a palette that follows typing stays still. Padding, overflow and
spacing stay with the call site (`p-1` for a list, `p-3` for a form).

### Context ring (`ContextRing` and `ContextUsageChip`)

The context ring is a 16px glyph with the figure beside it (`62%`, mono, 12px, `fg-muted`)
in the composer strip (`showValue={false}`), and a 20px ring with the figure inside it in a
sidebar row, where a title is truncating next to it. That inner figure is 8px, 600, in
`fg`: a glyph that belongs to the drawing, below the type scale on purpose
([decision 26](./decisions.md)). The 2.5px arc is `fg` while usage is
`normal` or `info`, and turns `warning`, then `danger` (`danger` and `critical`) as the
tracker escalates. Mango is not used, because a healthy 62% is not the primary action, the
current item or focus. The track under it is the `stroke` hairline: a gauge's track is
structure, and an arc drawn over `fg-subtle` fused with it at 16px, so 62% read as a full
ring.

`ContextUsageChip` is the strip's ring and percentage as a `.composer-chip` button with
no click of its own: the figures behind it (token counts, the window, each reported scope)
open in a `.dropdown-panel` above it, growing leftward, on hover or keyboard focus. Its
`aria-label` holds the whole breakdown and the panel is `aria-hidden`, so a screen reader
hears it once. With no ratio to draw it shows `fallback` instead of the ring.

### Timeline and tool blocks

The assistant turn is a 1px `stroke-strong` rail with 7px nodes: `fg-subtle` at rest,
`success` when finished, `danger` on error, `stroke-strong` when muted, and `accent-fg`
while running (pulsing), because a bead has to clear 3:1 against the canvas on its own.
A row is 24px, or 44px on a coarse pointer, so the node stays centred on a row that the
touch floor raised.

A tool call is a timeline row with its name in mono. Expanded, it opens onto a `surface`
panel with a `stroke` border and `rounded-md` (`TimelineDisclosure`). Inside, each section
(arguments, output, an Edit's file diff) has a 32px header with a `MicroLabel` or the file's
path, then its content as a full-bleed `canvas` band in mono. The user's message is a
`surface` balloon with a `stroke` border and `rounded-lg`. Cards in a turn (task list,
subagent trace, question, approval, notice, error) end where the prose bubble ends: they sit
one indent in from the rail, so they are capped at `--timeline-card-max` (the 42rem measure
minus that indent) rather than the full measure. Tool rows and tool output are not cards and
keep the whole column.

### `TurnMetaRow`

The line that closes a turn (`features/chat/components/TurnMetaRow.tsx`): how long it took
and how it ended. One anatomy for every turn kind (a MangoStudio text turn, an image turn,
an external agent's turn): one indent in from the rail (`pl-4`), mono 11px in `fg-subtle`,
an `ICON_SM` glyph in the same colour, 6px apart. The glyph names the outcome: `Sparkles`
for completed, `CircleX` for failed, `CircleStop` for stopped. It stays `fg-subtle` rather
than a status colour, because the words carry the outcome and the row must stay quieter
than the turn above it.

### Markdown

Headings are Inter 600; inline code is mono on `fill-selected` with `rounded-xs`; code
blocks are `surface` with a `stroke` border (Shiki keeps its own theme background); links
are `accent-fg`; a blockquote's rule is `stroke-strong`, not an accent. A table sits in a
`.markdown-table-scroll` wrapper that scrolls sideways when its columns need more than the
bubble, and inline code in a cell never breaks at a hyphen. A labelled code block has a
2.5rem header row above its first line: the language label sits at its left (1rem in) and
the copy button at its right (0.5rem in), both in a 28px box at a 0.5rem top inset so they
share one vertical centre. The label is always shown and never fades, because it never
covers code. The copy button (`.copy-code-btn`) appears when the pointer is over the block,
and stays visible on a screen that cannot hover. An unlabelled snippet keeps the plain `1em` padding. The label is positioned
against the block, so it scrolls away with the code when a wide block is scrolled sideways.
The table wrapper draws a thin always-visible scrollbar with a track, so a table cut off at
its third column reads as scrollable.

## Shared class strings

Some looks are exported as class strings rather than components, for an element that must
match a component without being one.

| Export                   | File                                           | What it is                                                                          |
| ------------------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| `buttonClassName()`      | `ui/Button.tsx`                                | A `Button`'s classes for a `<Link>` or an `<a>`.                                    |
| `FIELD_CLASS`            | `ui/Input.tsx`                                 | The text field's face, for an inline field or a field-shaped toggle.                |
| `DIALOG_SURFACE_CLASS`   | `ui/Dialog.tsx`                                | The floating panel's surface, shared by `Dialog` and the command palette.           |
| `TAB_CLASSES`            | `ui/Tabs.tsx`                                  | The underline-tab look, shared by `TabNav` and `Tabs`, with `TabLabel`.             |
| `SELECTION_BAR`          | `ui/selection-bar.ts`                          | The 3px `accent` bar of the current item in a vertical list. The row is `relative`. |
| `TOOL_AVATAR_SIZE_CLASS` | `ui/ToolAvatar.tsx`                            | The `ToolAvatar` box per size.                                                      |
| `MEDIA_CONTROL_CLASS`    | `features/gallery/components/media-control.ts` | A `subtle` button's face on the `scrim-media` veil.                                 |
