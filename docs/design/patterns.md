# Patterns

How the components in [`components.md`](./components.md) combine into screens. The
point of a pattern is that the same situation looks the same everywhere: a warning
on the Context page and a warning in the chat are one thing drawn once. Each rule
below names a page that already follows it; copy that page before inventing a layout.

## Pages

Every page has one `text-title` (20px/600) heading in `fg`. A description, when the page
needs one, sits under it as `text-sm` in `fg-muted` (`min-w-0 space-y-1` around the pair).
The two exceptions are the Home greeting and an onboarding step title, which are the
screen's one `text-headline`.

| Page                                     | Frame                                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Studio, Gallery, Terminal                | Scroll on their own with a `p-4 sm:p-6` gutter. Studio centres in `max-w-6xl`; Gallery and Terminal fill the width, left-aligned, at `gap-6 sm:gap-8`.                                                                                                                                     |
| Home                                     | `px-4 py-8 sm:px-6`, centred in `max-w-6xl`, `gap-8` between the greeting and the card grid.                                                                                                                                                                                               |
| Settings                                 | `max-w-6xl` with `px-4 py-6 sm:px-6 lg:px-8`. From `lg` a 14rem `SettingsNav` column beside the page, both on `canvas`; below `lg` the nav stacks above it.                                                                                                                                |
| Environments (and the library inside it) | `max-w-7xl` with `px-4 py-6 sm:px-6 lg:px-8` and `space-y-6`: the title and subtitle, the `TabNav` strip, then the tab's own content.                                                                                                                                                      |
| Chat                                     | One reading column, `CHAT_COLUMN_CLASS` (`max-w-4xl`), shared by the transcript, the notices and the composer. The transcript and the notices sit inside `CHAT_GUTTER_X_CLASS` (`px-3 sm:px-4 md:px-6`); the composer's footer writes the same steps itself, with a matching bottom inset. |
| Sign-in, sign-up, onboarding             | No shell. `BrandLockup` names the product above the page's own `Card`.                                                                                                                                                                                                                     |

- **The heading starts at the same place.** Pages the sidebar switches between share a
  gutter, so the heading does not jump sideways. `md:p-8` is not a page gutter (the
  gallery lightbox uses it, and it is an overlay).
- **Page headings never carry an icon tile.** Navigation already says where you are;
  the heading says what the page is.
- **Page-level actions sit on the title's line.** Add, Refresh, Import or a caption such
  as "Last updated" go right of the heading in an `h-7` box centred on its 28px line, so a
  44px touch button and a 16px caption share the title's centre. `SettingsPage` does this
  through `actions`; the Terminal page's title row does it by hand and raises its chips to
  `h-7` to match.
- **A page offers a destination once.** Studio has no card that says "Gallery" beside the
  recent strip's "View all" and the sidebar's Gallery item.

## Settings pages

A settings page is a `SettingsPage` holding `SettingsSection`s, which hold rows. Sections
stack at `space-y-8`; inside one, the heading, notice and card sit at `space-y-3`.

- **The first group has no heading.** The page title already names it (Appearance opens
  with an untitled section holding theme, font size and chat density).
- **Settings save as they change.** There is no Save button; `SettingsSaveIndicator` in
  the page header reports the write. So an on/off setting is a switch (`SettingToggle`),
  never a checkbox.
- **One row per setting** (`SettingsRow`): the name at 14px/500 and a 12px `fg-muted` hint
  on the left, the control on the right. Pick the `layout` by the control: `inline` for a
  switch, a checkbox, a small button or a number field; `field` for a `Select` or a text
  field; `stacked` for a slider, a textarea, a segmented control or a path.
- **A choice between two to four options** is `SettingsSegmented`; a longer one is a
  `Select`. A choice between records that need a line of description each (an agent, the
  place a key is stored) is a list of `PickOneRow`s in a `role="radiogroup"`.
- **A number** is an `Input type="number"` at `w-32 text-center`, with the unit in the hint
  ("Days, 1–365"), never in the label or after the field. A range of hundreds of steps is
  that field alone, because a slider at 0.7px a step cannot be dragged to a value. A
  coarse range is a `SettingsSliderRow`; add `withNumberInput` only when exactness
  matters. The live value goes in the number field when there is one, or in the row's
  `readout` when there is not, never in both.
- **Rows that only matter when a parent is on are not drawn while it is off.** A rule file
  that is switched off shows only its path and switch; its Injection role and Frequency
  rows return, with their values kept, when it is switched on (`RuleFileRows`).
- **Loading and failure** are `SettingsLoading` (skeletons in the shape of the content)
  and `SettingsLoadError` (a `danger` `Callout` with Retry), the same on every page.
- **A record editor** (an agent, an MCP server, a connector) is a form: `SettingsField` or
  `Input` per field, saved by an explicit button. See [Forms](#forms).

## Lists of rows

Most lists in the app are rows divided by `stroke` hairlines in one container. Never a
card per row, and never a card inside a card.

- **Inside a card.** A `Card padded={false}` holding a `<ul className="divide-y divide-stroke">`
  (the provider list, add `overflow-hidden` when rows have a hover fill), or a
  `SettingsSection` whose children are the rows (connectors, skills, tools). Each row pads
  itself `px-4 py-3`.
- **Outside a card** (the workspace rail's changes, history, worktrees and stashes):
  `RowList` (`features/workspace/components/RowList.tsx`), a `rounded-md` hairline box with
  no fill of its own and `divide-y divide-stroke` rows. The Terminal page's session list
  writes the same classes by hand.
- **A record of several rows** (a prompt rule file, an MCP server with its tools) is one
  card each, stacked at `space-y-3`: `SettingsSection cards`, or the cards themselves as
  `McpSettingsPage` lists them. The card edge separates records; the hairline separates
  rows inside one.
- **Row anatomy.** The name at `text-sm` (`font-semibold` when the row is a record with
  its own title, as a provider or connector is), badges on the same line and wrapping
  under it on a narrow screen, then one `text-xs` `fg-muted` line of summary.
- **A row that navigates** is a full-width `Link` with `hover:bg-fill-hover`, an inset
  focus ring (`focus-visible:-outline-offset-2`, so the card does not clip it) and a
  trailing `ChevronRight` at `ICON_MD` in `fg-subtle` (`ProviderSettingsRow`). A row that
  only navigates has no row actions.
- **The current row** is `fill-selected` with `SELECTION_BAR` and its name at 500, as in
  the sidebar and the Terminal page's session list.

## Menus and row actions

- **One or two actions** on a row are buttons at its end: `Button size="icon-sm"` for an
  icon, `size="sm"` for a word. A destructive one is `subtle-danger`, which rests in
  `fg-muted` so a list does not end in a column of red. An icon-only button carries both
  `aria-label` and `title`.
- **Actions revealed on hover** (the sidebar's rename and delete, the terminal tab's Rename
  and Pop out) are also revealed on focus (`group-focus-within:`), and a touch screen,
  which has no hover, shows them at rest (`pointer-coarse:inline-flex`, or
  `pointer-coarse:flex` for the sidebar's group). In a long list
  where every row would then carry them (the sidebar), only the current row does.
- **More than that** goes into one `⋮` `Menu`, with the frequent action left outside it.
  An MCP server row is Test, its switch, and a menu holding Edit, Rename…, Reset to
  default, a separator, then Delete server.
- **Inside a menu**, every item has its `ICON_MD` glyph, the same glyph the action wears
  elsewhere (Trash2 for delete, RotateCcw for discard). An item that opens a dialog or
  asks for more ends in `…` ("Rename…", "Stashes…", "Amend latest commit…"). An on/off
  preference is a `checked` item, not a second menu. A destructive item goes last, after a
  `MenuSeparator`, with `tone="danger"`, and it opens a `ConfirmDialog` rather than acting
  from the menu.
- **A failure from a menu item** has no row to land in once the menu closes, so it is a
  toast (`ToolIdentityMenu`'s reset), not silence.

## Forms

- **One field per line**, full width of its container: `Input` with its own `label`,
  `hint` and `error`, or `SettingsField` around a control that has no label of its own
  (`Select`, `Textarea`, a list of rows). The label is 14px/500 above the control, the hint
  12px `fg-muted` below it. An error replaces the hint, in `danger` with a `CircleX` at
  `ICON_SM`, and the field turns its border `danger` (`aria-invalid`).
- **A placeholder is an example**, never the instruction and never the label. What the
  field expects (a format, a range, a unit) is the hint.
- **Spacing.** Fields in a dialog sit at the body's `space-y-4`. A page form (sign-in,
  sign-up) separates its groups at `space-y-5` and the fields inside a group at
  `space-y-3`. A short number (days, seconds) is `w-32 text-center` here too, as Expires in
  is in the API key dialog.
- **Where a form lives.** In a `Dialog` (`md`), or in one `Card` on a page without a shell.
  Never two cards side by side to make a form wider.
- **Actions.** In a dialog footer, right-aligned at natural width: `secondary` Cancel first,
  the `primary` verb last. While the request is in flight the primary button shows
  `loading` and its label turns into the progressive form ("Creating…"), Cancel is
  disabled and `closeDisabled` stops Escape and the backdrop. A page form's single submit
  is a full-width `lg` primary button.
- **A submit failure** goes in the dialog's `notice` slot as a `danger` `Callout`, so it
  stays in view above the footer. A field-level problem goes on the field.
- **Optional fields.** There is no single convention yet. A form with several optional
  fields groups them under one `MicroLabel` legend ("Optional", as the add-environment
  dialog does); a lone optional field says so in its label ("Organization ID
  (optional)"). See [the open follow-ups](./migration.md#open-follow-ups).
- **On/off in a form.** A setting with an immediate effect is a `Toggle`; an option that is
  submitted with the form is a `Checkbox`, or a `CheckboxRow` in a pick-several list.

## Rows with a control

The common settings row: the title (`text-sm`, 500), the hint (`text-xs`, `fg-muted`) on
the left and the control on the right, `gap-4`, `px-4 py-3`, `stroke` between rows. The
control is a `Toggle`, a `Select`, a `w-32` number field or a `Button size="sm"`.
`SettingsRow` draws it; see [Settings pages](#settings-pages) for how to choose its layout.

## Notices

Use `Callout` for anything the user should read inline.

| Situation                                        | Tone                 |
| ------------------------------------------------ | -------------------- |
| Something failed and they must act               | `danger` + an action |
| They may want to do something, nothing is broken | `warning`            |
| A fact worth knowing, a note about a result      | `info`               |
| A completed step that stays on screen            | `success`            |
| Neutral context                                  | `neutral`            |

- **A notice the person must act on carries the action**: one `secondary` `sm` button in
  the `action` slot (Retry, Edit, Read the notice). In a narrow region such as the
  workspace rail (280px at its narrowest), the slot would squeeze the text into a column,
  so the action goes under the body instead (`TerminalUnavailableNotice`).
- **Raw detail is secondary.** A failure says what failed and what to do in the title and
  body; the raw transport or server error follows as `font-mono text-xs` detail (the MCP
  server's connection failure).
- **A quiet result inside a row** (a test that passed, a skipped entry) is a `StatusNote`:
  a status glyph and muted words, no fill.
- **A toast** is for something that already happened and needs no follow-up ("Copied"),
  or for a failure that has nowhere inline to land. It appears top-right under the header.
- Never colour the words of a notice; the glyph and the fill carry the tone.

## Status

Show state as a `Badge` (a word in a pill), a `StatusDot` beside a word, or a glyph in
the status colour **with** a word. Colour alone is never the signal.

- Prefer a `neutral` badge for "no state" over leaving it out: a row that sometimes has a
  badge and sometimes none reads as broken.
- **Pick the tone by what the person can do about it.** A thing that is simply absent and
  optional (an agent CLI that is not installed, an optional tool) is `neutral`. A thing the
  person can fix (signed out, needs approval) is `warning`. `error` is for a fault. A
  healthy account's landing page shows no red and no amber.
- When a list mixes the three, order it by what it asks of the person: what needs action,
  what can wait, then what is only worth knowing (the Environments health page:
  "Needs action", "Can wait", "For information"). When nothing needs action, say so in one
  muted line rather than an empty state, because the list under it is not empty.

## Dialogs and destructive actions

- **Size by content.** `sm` for a question, `md` (the default) for a form or a short list,
  `lg` for steps, a table of commands or a wizard.
- **Confirm only what is irreversible or costly**, with `ConfirmDialog`: a title phrased as
  the question ("Revoke this API key?"), a sentence naming the consequence, the thing's
  name quoted under it when the title does not name it, then Cancel and the destructive
  verb in a `danger` button. The verb repeats the question ("Revoke"), never "OK" or "Yes".
- **Focus lands on Cancel** for destructive confirmations; Escape and the backdrop cancel.
- **A change the person can reverse in place** (a switch, a rename) is done at once,
  without a dialog.
- **A dialog that must not be lost by accident** (the one-time API key reveal) passes
  `closeDisabled` and offers one way out (Done). A wizard (the library's `WizardFrame`)
  keeps Cancel in its footer on every step before the result, with Back beside it, and
  ends with Done.
- **The safe answer** is "Cancel", or names what is kept when the question is about
  losing something in git: "Keep branch", "Keep stash", "Keep worktree".

## Empty, loading and error

- **Empty**: `EmptyState` with an `ICON_LG` icon, what is missing, and how to get some.
  On a settings page it sits in a `Card padded={false}`. Offer the way out once, as the
  empty state's own `action` (a `secondary` `sm` button with a `Plus` at `ICON_SM`); the
  header button that does the same thing is not drawn while it shows (Connectors, Custom
  rules, Agents, MCP servers). Where there is nothing to do (Logs, Metrics) there is no
  action. A standing fact that is not an empty list (a repository with only
  its main worktree) is one line of `fg-muted` text, not an `EmptyState` title.
- **Unavailable**: a feature that cannot work here (the GitHub CLI is signed out,
  terminals are switched off) is not an empty list. It is a `Callout`, `warning` when the
  person can fix it or wait it out and `info` when it is a standing fact, left-aligned where
  the content would be, said once for the region it covers. The controls it makes inert
  (filters, a create button, a "Sessions" header with nothing under it) are not drawn
  beside it; a list that is still reachable (open terminals at the cap) stays. Its title
  names the cause ("Terminal limit reached", not only "Terminal is unavailable").
- **Loading**: `Skeleton` blocks in the shape of the content for lists and cards (the
  gallery's skeleton grid uses the same `GALLERY_GRID` as its tiles, so nothing jumps);
  `Spinner` for a single action. Never both on one region. A spinner that stands alone
  takes a `label`, so it is a named `role="status"`.
- **Error**: a `Callout tone="danger"` with the cause and a Retry `Button`. A toast is not
  an error state.
- **Full-page states** share one anatomy: a centred `Card` on `canvas` (`max-w-md`) with a
  `text-title` heading, a sentence in `fg-muted` and the way out. Not Found carries the
  `Logo` inside its card, because no shell names the product; the bootstrap failure leads
  with a `danger` `CircleX` at `ICON_LG` and Retry, and stands either over the whole
  surface or in the shell's content region. The wait before the first render is a
  `StartupSpinner`: a labelled `Spinner` alone on `canvas`.

## Copy

All interface text comes from `@mangostudio/shared/i18n`, with `en` and `pt-BR` kept on
exactly the same keys **(tested)**. `apps/shared/tests/unit/i18n-copy-rules.test.ts` holds both
dictionaries to the rules marked **(tested)**; the rest are held by review.

- Sentence case in buttons, titles, tabs, menu items and badges: "New chat", "Create pull
  request", "External agents". The file change badges render exactly as written, so they
  are capitalised in the dictionary **(tested)**. The only upper-case is `.micro-label`,
  applied by CSS.
- Buttons are verbs or short nouns: "Send", "Stop", "Create pull request". In a
  confirmation, repeat the verb of the question.
- The ellipsis is the single character `…`, never three dots **(tested)**: "Saving…",
  "Search chats…", "Rename…".
- A name quoted in a sentence takes typographic quotes, never the straight `"`:
  `Could not connect to “{name}”`, `No results for “{query}”`. An apostrophe is the
  typographic `’` ("Don’t have an account?").
- One word per concept. A session with a runner is a **chat**. The product is
  **MangoStudio**, one word **(tested)**.
- A count is never "chat(s)". A counted message is a pair of keys, `xOne` and `xOther`
  (`sessionsOne`: "{count} chat", `sessionsOther`: "{count} chats"), picked with
  `usePlural` (or `pluralMessage` outside a component), so each language agrees its nouns
  and adjectives its own way ("1 arquivo alterado", "3 arquivos alterados").
- Errors say what failed and what to do: "Could not start the chat on that runner. Try
  again."
- A value with a unit puts the unit in the hint or the readout, not in the label.
- No emoji in the interface.

## Density

The chat has three densities (compact, default, comfortable) that change only the gaps
between turns and between steps (`[data-chat-density]` in `index.css`). Control heights,
radii and type do not change with density: a compact chat is not a smaller interface.
