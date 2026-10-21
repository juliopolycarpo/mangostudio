# Migration and conformance

The record of how `apps/frontend` moved from the Material-style, glass-and-gradient
vocabulary to the flat one, the rules new code follows so it stays there, and how to
add a deliberate exception. The why behind each choice is in
[`decisions.md`](./decisions.md).

## What changed

### Vocabulary

Every class on the left was rewritten to the token on the right; the conformance test now
rejects the left-hand names.

| Old (Tailwind utility suffix)                                | New                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `background`, `surface`, `surface-dim`                       | `canvas`                                                                 |
| `surface-container-low` (the sidebar)                        | `sidebar`                                                                |
| `surface-container`, `-low`, `-high` (cards, panels)         | `surface`                                                                |
| `surface-container-lowest` (fields, chips)                   | `control`                                                                |
| `surface-container-highest`                                  | `fill-selected` (resting) · `fill-hover` (hover)                         |
| `hover:bg-surface-container-*`                               | `hover:bg-fill-hover`                                                    |
| `outline-variant` (+ `/10` … `/60`)                          | `stroke`                                                                 |
| `outline`                                                    | `stroke-strong`                                                          |
| `on-surface`, `on-background`                                | `fg`                                                                     |
| `on-surface-variant` (+ `/60`, `/70`, `/80`)                 | `fg-muted`                                                               |
| `on-surface-variant/40`, `/50`, `on-surface/30`              | `fg-subtle`                                                              |
| `primary` as a fill                                          | `accent`                                                                 |
| `primary` as text or an icon                                 | `accent-fg`                                                              |
| `primary/5` … `/30`, `primary-container`, `accent-muted`     | `accent-subtle`                                                          |
| `focus:border-primary…`, `ring-primary…`, `outline-primary`  | `focus`                                                                  |
| `on-primary`                                                 | `on-accent`                                                              |
| `error`, `on-error`                                          | `danger`, `on-danger` (`danger-solid` for a solid button)                |
| `error/5` … `/30`                                            | `danger-subtle`                                                          |
| `warning/…`, `success/…` (tints)                             | `warning-subtle`, `success-subtle`                                       |
| `tertiary`                                                   | `info`                                                                   |
| Tailwind palette hues (`amber-500`, `blue-400`)              | a status or accent token                                                 |
| `bg-background/80`, `bg-black/60` (overlays)                 | `bg-scrim`                                                               |
| `bg-black/…`, `text-white` over a picture                    | `bg-scrim-media`, `text-on-scrim-media`, `fill-media-hover` / `-pressed` |
| `glass-panel`, `glass-elevated`, `.dropdown-panel` (blurred) | `surface-raised` + `stroke` + `shadow-popover` (`.dropdown-panel`)       |
| `font-headline`, `font-body`, `font-label`                   | `font-sans` (the default: drop the class)                                |
| `rounded-xl`, `rounded-lg`                                   | `rounded-md` (container) or `rounded-sm` (clickable)                     |
| `rounded-2xl`, `rounded-3xl`                                 | `rounded-lg`                                                             |
| `shadow-2xl`, `shadow-lg` …                                  | `shadow-dialog` / `shadow-popover`, or none                              |
| `text-[10px]`, `text-[11px]`                                 | `text-micro` (mono metadata, group labels) or `text-xs`                  |
| `text-lg`, `text-xl` …                                       | `text-base`, `text-title`, `text-headline`                               |
| `font-bold`                                                  | `font-semibold` (titles) or `font-medium` (labels, buttons)              |
| `uppercase tracking-widest`                                  | sentence case, or `MicroLabel` (`.micro-label`) for a group heading      |
| `size={13}`, `size={18}`, `size={24}` on an icon             | `ICON_SM`, `ICON_MD`, `ICON_LG` from `@/lib/icon-sizes`                  |
| `variant="ghost"` on `Button`                                | `variant="subtle"`                                                       |
| `subtle` with a `text-danger` override                       | `variant="subtle-danger"`                                                |
| `<Card variant="solid" \| "glass">`                          | `<Card>` (`padded={false}` plus `className` for other padding)           |

### Components

Shared pieces that replaced per-area markup. Each is documented in
[`components.md`](./components.md).

- **New in `components/ui/`**: `Callout`, `Dialog` (every hand-drawn modal moved onto it,
  and `ConfirmDialog` is built on it), `Tabs` (with `TAB_CLASSES` shared with `TabNav`),
  `Textarea`, `Radio`, `LockedChip`, `ComposerPopover` (moved from the chat feature) and
  `SELECTION_BAR` in `selection-bar.ts`.
- **Changed in `components/ui/`**: `Button` gained `buttonClassName()`, the `lg` and
  `icon-sm` sizes and the `subtle-danger` variant, and greys out when disabled instead of
  fading; `Badge` gained `info`; `Input` gained `hint` and exports `FIELD_CLASS`; `Spinner`
  gained `label`; `TabNav` gained `current`; `Toggle` gained `ToggleSwitch`; `KbdHint`
  takes any node as `keys` (`ReturnKey` draws ⏎ as an icon) and is not drawn on a coarse
  pointer; `ChipSelect` gained `placement`; `ContextRing` gained `showValue`;
  `ConfirmDialog`'s `entityName` became optional; `Toast` moved from bottom-right to
  top-right; `Card` lost `variant`.
- **New in `components/settings/`**: `SettingsPage`, `SettingsSection`, `SettingsRow`,
  `SettingToggle`, `SettingsSegmented`, `SettingsSliderRow`, `SettingsField`,
  `SettingsLoading` and `SettingsLoadError` (`SettingsStates.tsx`), `StatusNote`,
  `PickOneRow`, `CheckboxRow` and `RuleFileRows` (which replaced `RuleFileCard`).
- **New in `components/layout/`**: `BrandLockup` (sign-in, sign-up, onboarding) and
  `NotFound`.
- **Feature-owned pieces other features copy**: `RowList`, `DialogBlocks` and
  `IconButton` (workspace; the GitHub panel imports `IconButton`),
  `TurnMetaRow` and `ChoiceButton` (chat), `CHAT_COLUMN_CLASS` and `CHAT_GUTTER_X_CLASS`
  (`features/chat/lib/chat-column.ts`), `MEDIA_CONTROL_CLASS` (gallery), `WizardFrame`
  (library).
- **Settings lists became rows**: `ProviderSettingsCard` → `ProviderSettingsRow`,
  `ConnectorCard` → `ConnectorRow`, `SkillCard` → `SkillRow`, `ToolSettingsCard` →
  `ToolSettingsRow`, each a row inside one card instead of a card per item.
- **Copy**: sentence case, the single-character ellipsis, one product name, counted
  messages as `xOne` / `xOther` pairs picked with `usePlural`, and the dead keys removed
  from both dictionaries.

### Removed

- `.glass-panel`, `.glass-elevated`, `--glass-*`, `--gradient-primary`.
- The Manrope font file, its `@font-face` and its preload.
- `skeleton-shimmer` (a gradient animation), in favour of a pulse.
- Tailwind's own colour palette, and every radius, shadow and type size the theme does not
  name (`--color-*`, `--radius-*`, `--shadow-*` and `--text-*` start from `initial`).
- The `Card` `variant` prop, `Button`'s `ghost` name and every `color-mix()` in the
  stylesheets.
- The composer's seven derived `--composer-*` tints, `--composer-send-fill` and the
  runner-tinted status band.

## Rules for new code

- Reach for a component in [`components.md`](./components.md) before writing its classes,
  and add a missing variant to the component, not to the call site.
- Colours are tokens from [`foundations.md`](./foundations.md). A tint is a `*-subtle` or
  `fill-*` token, never an opacity modifier or an arbitrary value. Text over a picture uses
  the `scrim-media` family.
- Sizes come from the scales: radii `xs` / `sm` / `md` / `lg` / `full`, type `micro` /
  `xs` / `sm` / `base` / `title` / `headline`, weights 500 and 600, spacing steps
  `0.5` / `1` / `1.5` / `2` / `3` / `4` / `5` / `6` / `8` / `12` (never `2.5` or `3.5`),
  icons at `ICON_SM` / `ICON_MD` / `ICON_LG`.
- Only floating things cast a shadow: `shadow-popover` or `shadow-dialog`.
- Hover and press change colour only: no `scale-*`, no `transition-all`.
- Merge classes with `cn()` from `lib/utils.ts`, which knows the custom type and shadow
  names.
- Text comes from `@mangostudio/shared/i18n`, in both `en` and `pt-BR`, following the copy
  rules in [`patterns.md`](./patterns.md#copy).

## The conformance test

`apps/frontend/tests/unit/design-system-conformance.test.ts` reads every `.ts`, `.tsx` and
`.css` file under `apps/frontend/src` (except the generated `routeTree.gen.ts`) as text,
and fails with one `file:line  offender  ← rule` line per hit. Comments are stripped
first, except for the first three rules: a comment that still describes a retired token
is stale documentation. Rules marked "source only" skip the stylesheets, which may use the
property the rule bans in a class.

| Rule                            | Rejects                                                                                                                                                                                                                | Use instead                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Material-era colours            | `surface-container`, `on-surface`, `on-primary`, `on-background`, `outline-variant`, `primary-container`, `accent-muted`, `surface-dim`, `--color-primary` and friends, `bg-primary`, `text-error`, `border-outline` … | the tokens in the table above                              |
| Glass and gradients             | `glass-*`, `--glass-`, `backdrop-blur`, `backdrop-filter`, `bg-gradient`, `linear-gradient()` and the other gradient functions, `--gradient-`                                                                          | `surface-raised` + `stroke`, or a solid fill               |
| Retired font roles              | `font-headline`, `font-body`, `font-label`, their variables, Manrope                                                                                                                                                   | `font-sans` (the default) or `font-mono`                   |
| Radii                           | a bare `rounded`, and `rounded-xl` and larger on any side or corner                                                                                                                                                    | `rounded-xs`, `-sm`, `-md`, `-lg`, `-full`                 |
| Shadows                         | a bare `shadow`, `shadow-xs` … `shadow-2xl`, `shadow-inner`, `drop-shadow-*`                                                                                                                                           | `shadow-popover`, `shadow-dialog`, or none                 |
| Type sizes                      | `text-lg` … `text-6xl`, `text-[13px]` and other arbitrary sizes                                                                                                                                                        | `text-micro`, `-xs`, `-sm`, `-base`, `-title`, `-headline` |
| Weights                         | `font-bold`, `font-extrabold`, `font-black`, `font-light` and lighter                                                                                                                                                  | `font-medium`, `font-semibold`                             |
| Case and tracking (source only) | `uppercase`, `tracking-wide`, `tracking-wider`, `tracking-widest`                                                                                                                                                      | sentence case, or `MicroLabel`                             |
| Opacity tints                   | an opacity modifier on any semantic colour (`bg-accent/10`, `text-fg/60`)                                                                                                                                              | a `*-subtle` or `fill-*` token                             |
| Raw palette                     | Tailwind hues (`bg-amber-500`, `text-blue-400/50`)                                                                                                                                                                     | a token                                                    |
| Arbitrary colours (source only) | `bg-[#…]`, `[rgb()]`, `[hsl()]`, `[oklch()]`, `[color-mix()]`, `[var(--color-…)]`, `[color:…]` in a colour utility                                                                                                     | a token                                                    |
| Black and white overlays        | `bg-black`, `bg-white`, `text-white`, `border-black/40` and the like                                                                                                                                                   | `bg-scrim`, or `bg-scrim-media` and `text-on-scrim-media`  |
| Motion                          | `scale-*` (with or without `hover:`, `active:`, `focus:`), `transition-all`                                                                                                                                            | a colour change; `transition-colors`                       |
| Empty-state icons (source only) | `<EmptyState icon={<Icon size={24} />}>` with a literal size                                                                                                                                                           | `size={ICON_LG}`                                           |
| Off-grid spacing                | `2.5` and `3.5` as padding, margin, gap or `space-*` (`px-2.5`, `-mt-3.5`)                                                                                                                                             | a step on the 4px grid; `size-3.5` for a box is allowed    |

A second test fails when `ALLOWED` names a file that no longer exists, so an exception
cannot outlive the code it excused.

The other gates (the token table in `foundations.md`, contrast, the touch-target cascade,
`color-mix()` in stylesheets, motion tokens and the copy rules) are listed with what they
fail on in the [README](./README.md#enforcement).

## Adding an exception

An exception is for a deliberate use the rule was not written for, never for a class that
is simply convenient.

1. Open `ALLOWED` in `design-system-conformance.test.ts`. Its keys are file paths relative
   to `apps/frontend/src`.
2. Under the file, add the rule's `why` string, copied exactly from `RULES` (the test
   matches it as text), mapped to your reason.
3. Write the reason as what the element is and why the rule does not fit it. An exception
   that cannot say why will not pass review.

The exception covers that rule in that whole file, so keep it to the file that needs it.
Two exist today:

- `components/ui/ToolAvatar.tsx` may use type sizes off the scale and upper-case: the
  monogram is a glyph inside a 16–24px tile, not running text.
- `components/ui/ContextRing.tsx` may use a type size off the scale: the percentage drawn
  inside the 20px ring of a sidebar row is a data glyph.

## Changing the vocabulary

To add, rename or retire a token: change `index.css`, then the colour table in
[`foundations.md`](./foundations.md) (`tests/unit/design-tokens-doc.test.ts` parses its
`| Token | Utility | Dark | Light | Use |` rows and fails when they disagree with the
stylesheet), then the conformance rule (`SEMANTIC_COLORS` lists the tokens the opacity
rule knows), then the platform mapping in [`native-ports.md`](./native-ports.md), and add
a numbered entry to [`decisions.md`](./decisions.md).

## Open follow-ups

- **Analyzer severity for optional tools.** A finding reads as neutral ("For information")
  only when the runtime's analyzer marks it `severity: 'info'`. One it leaves unmarked
  falls back to the frontend's code table in `features/environments/format.ts`, where
  `not-found` is a fail, so an absent optional tool can still show as a fault. The fix
  belongs in the analyzer, not the frontend.
- **Real image aspect ratios.** Gallery tiles, their skeletons and the generating-image
  skeleton reserve a square, because `GeneratedImageArtifact` carries no dimensions.
  Drawing each image at its own ratio needs a contract change in `apps/shared`.
- **A flat logo.** The mark (`assets/logo.png`) is still an illustrated, shaded mango, the
  one non-flat asset ([decision 1](./decisions.md)). A flat mark is a brand decision.
- **A convention for optional fields.** Forms mark them two ways: a `MicroLabel` legend
  over a group (the add-environment dialog) or "(optional)" in a label (the commit
  description, the connector's organization ID). Pick one, and decide whether `Input` and
  `SettingsField` should draw the marker themselves.
- **Straight quotes and apostrophes in `en.ts`.** The copy rule asks for `’` and `“…”`, but
  nineteen strings still use a straight apostrophe ("destination's"), and five quote a
  name with `"` (`Committed "{subject}"`, `Line numbers for "{path}"`); `pt-BR.ts` has the same
  quotes. Six more wrap a command or a literal in `"` ("cargo build …", `"mcpServers"`),
  which may stay straight. A sweep of both dictionaries, and a rule in
  `i18n-copy-rules.test.ts` to hold it, are open.
