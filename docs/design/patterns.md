# Patterns

How the components in [`components.md`](./components.md) combine into screens. The
point of a pattern is that the same situation looks the same everywhere: a warning
on the Context page and a warning in the chat are one thing drawn once.

## Pages

- **Reading column.** Chat and settings centre their content in one column. A page
  has a `text-title` heading (one per page), an optional description in `fg-muted`,
  then its sections at `space-y-8`.
- **Settings.** Two columns from `lg`: a nav on the left and the page on the right,
  both on `canvas`. Sections are `Card`s whose rows are separated by a `stroke`
  line, with the preference's name and hint on the left and its control on the right.
- **Lists and detail.** A list is a stack of 32px–40px rows with `fill-hover` hover;
  the current row is `fill-selected`. A detail pane sits beside it on `surface`.
- **Page headings never carry an icon tile.** Navigation already says where you are;
  the heading says what the page is.
- **Page gutter.** A page that scrolls on its own (Home, Studio, Gallery, Terminal)
  pads `px-4 sm:px-6` — 16px, then the 24px `6` step — so the heading starts at the
  same x when you move between them. Landings (Home, Studio) then centre their
  content in a `max-w-6xl` column; lists (Gallery, Terminal) fill the width and stay
  left-aligned. `md:p-8` is not a page gutter.
- **A page offers a destination once.** Studio does not carry a card that says
  "Gallery" beside the recent strip's "View all" and the sidebar's Gallery item.

## Forms

- One `Input` / `Select` per row, label above at 14px/500, hint below at 12px in
  `fg-muted`, error below in `danger` with an icon.
- Group related fields in a `Card`; separate groups with `space-y-5`. Never put two
  cards side by side to make a form wider.
- Actions sit bottom-right in the card's footer: `secondary` first, `primary` last,
  at natural width.
- A setting with an immediate effect is a `Toggle`; an option submitted with the form
  is a `Checkbox`.

## Rows with a control

The common settings row: title (`text-sm`), hint (`text-xs fg-muted`) on the left
and the control on the right, `gap-4`, 12px–16px vertical padding, `stroke` between
rows. The control is a `Toggle`, a `Select`, or a `Button size="sm"`.

A number is an inline row with a `w-32` centred field, on every page. A range of hundreds
of steps is not a slider (0.7px a step cannot be dragged to): it is that field alone. A
slider is for a coarse range, with a number field beside it only when exactness matters
and the unit in the hint. The row's live value goes in the field, not also on the name's
line.

Page-level actions (Add, Refresh, a caption such as "Last updated") sit on the title's
28px line and centre on it, so a 44px touch button and a 16px caption share the title's
centre instead of hanging from its top.

## Notices

Use `Callout` for anything the user should read inline.

| Situation                                        | Tone                 |
| ------------------------------------------------ | -------------------- |
| Something failed and they must act               | `danger` + an action |
| They may want to do something, nothing is broken | `warning`            |
| A fact worth knowing, a note about a result      | `info`               |
| A completed step that stays on screen            | `success`            |
| Neutral context                                  | `neutral`            |

A toast is for something that already happened and needs no follow-up ("Copied").
Never colour the words of a notice; the glyph and the fill carry the tone.

## Status

Show state as a `Badge` (a word in a pill), a `StatusDot` beside a word, or a glyph in
the status colour **with** a word. Colour alone is never the signal. Prefer `neutral`
for "no state" over leaving it out — a row that sometimes has a badge and sometimes
none reads as broken. A thing that is simply absent and optional (an agent CLI that
is not installed) is `neutral`, a thing the person can fix (signed out) is `warning`,
and `error` is for a fault: a healthy account's landing page shows no red.

## Dialogs and destructive actions

- Confirm only what is irreversible or costly. A title phrased as the question, a
  sentence naming the consequence and the thing, then "Cancel" and the destructive
  verb. The verb repeats the question — never "OK" or "Yes".
- Focus lands on "Cancel" for destructive confirmations.
- Anything that can be undone is done immediately and offers undo; it is not a dialog.

## Empty, loading and error

- **Empty**: `EmptyState` with an icon, what is missing, and how to get some. The way
  to get some is the empty state's own action button; a header button that does
  the same thing is not drawn while it is showing. A standing fact that is not an
  empty list (a repository with only its main worktree) is one line of `fg-muted`
  text, not an `EmptyState` title.
- **Unavailable**: a feature that cannot work here (the GitHub CLI is signed out,
  terminals are switched off) is not an empty list. It is a `Callout` — `warning`
  when the person can fix it, `info` when it is a standing fact — left-aligned
  where the content would be, said once for the region it covers. The controls it
  makes inert (filters, a create button, a "Sessions" header with nothing under it)
  are not drawn beside it; a list that is still reachable (open terminals at the
  cap) stays.
- **Loading**: `Skeleton` blocks for lists and cards; `Spinner` for a single action.
  Never both on one region.
- **Error**: a `Callout tone="danger"` with the cause and a retry `Button`. A toast
  is not an error state.
- **Full-page states**: a request every page depends on (the bootstrap failure), an
  address no route owns, and the wait before the first render are one anatomy where they
  have words: a centred `Card` on `canvas` with a `text-title` heading, a sentence in
  `fg-muted` and the way out; the page that has no shell to name the product carries the
  logo. A spinner standing alone is a `role="status"` with a name for a screen reader.

## Copy

- Sentence case in buttons, titles, tabs, menu items and badges: "New chat", "Save
  changes", "External agents". The only upper-case is `.micro-label`, applied by CSS.
- Buttons are verbs or short nouns: "Send", "Stop", "Create pull request". In a
  confirmation repeat the verb of the question.
- The ellipsis is the single character `…` ("Saving…", "Search chats…"). A name quoted in
  a sentence takes typographic quotes — “Scratch notes”, `No results for “zzz”` — never the
  straight `"`.
- One word per concept. A session with a runner is a **chat**; a list heading may say
  "Recent chats". The product is **MangoStudio**, one word.
- A count is never "chat(s)". A counted message is a pair of dictionary keys, `xOne` and
  `xOther`, picked with `usePlural` ("1 chat", "3 chats"), so each language agrees its
  nouns and adjectives its own way ("1 arquivo alterado", "3 arquivos alterados").
- Errors say what failed and what to do: "Could not start the chat with this runner.
  Try again."
- No emoji in the interface. All text comes from `@mangostudio/shared/i18n`, with the
  `en` and `pt-BR` dictionaries kept in step.

## Density

The chat has three densities (compact, default, comfortable) that change only the
gaps between turns and steps. Control heights, radii and type do not change with
density — a compact chat is not a smaller interface.
