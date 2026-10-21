# MangoStudio design

MangoStudio is a working tool: people spend hours in it talking to agents, reading
diffs and running commands. The interface is **flat, calm and predictable** (solid
surfaces, one accent colour, hairlines) so the same screens can be redrawn in
WinUI 3, GTK 4 / libadwaita or AppKit and still read as one product.

## The pages, in reading order

1. [`README.md`](./README.md): this page. The principles, the index, and the tests
   that enforce the system.
2. [`foundations.md`](./foundations.md): every token and its rule. Colour in both
   themes, type, space, control heights, touch targets, radius, elevation, state,
   motion, icons and layout.
3. [`components.md`](./components.md): every shared component, its anatomy, the
   tokens it uses and when to reach for it.
4. [`patterns.md`](./patterns.md): how the components combine into pages, forms,
   lists, notices, dialogs, status and copy.
5. [`decisions.md`](./decisions.md): why the system is shaped this way, one numbered
   decision at a time. A decision is changed by a new entry, not by editing an old one.
6. [`native-ports.md`](./native-ports.md): how each token and component maps to
   WinUI 3, libadwaita and AppKit (macOS).
7. [`migration.md`](./migration.md): the old to new vocabulary, how the conformance
   test works, and how to add an exception.

## Principles

1. **Flat before deep.** Hierarchy comes from the step between surfaces
   (`canvas` → `surface` → `surface-raised`) and a 1px `stroke`. No gradients, no
   glass (`backdrop-filter`), no coloured glow, and no shadow on anything that does
   not float.
2. **One accent.** Mango marks the primary action, the current item, a checked
   control and focus.
   Everything else is warm neutral. The `agent-*` hues identify runners and nothing
   else.
3. **The platform's own rhythm.** 32px controls, 6px radius on whatever is
   clickable, a 48px header, 14px text. These are WinUI 3's measurements and within
   a couple of pixels of libadwaita's, so a native build does not have to rescale.
4. **Comfort over contrast theatre.** Text clears 4.5:1 in both themes; structure
   (borders, dividers) stays quiet. No text below 11px (an avatar monogram and the
   context ring's figure are glyphs, not text), and no text faded by opacity except on
   a control that is disabled and says nothing else.
5. **Terminal as dialect, not theme.** Mono appears where content is technical:
   `key: value` chips, paths, code, tool output, group labels. Titles, buttons and
   prose stay in the interface font.

## Working with it

- Write the class from [`foundations.md`](./foundations.md); do not invent a value.
  If a screen needs something the system does not have, change the system here
  first and say why in [`decisions.md`](./decisions.md).
- Prefer a shared component from `apps/frontend/src/components/ui/` over repeating
  its classes. [`components.md`](./components.md) lists them.
- All user-visible text comes from `@mangostudio/shared/i18n`, in sentence case.
- After a styling change, run the enforcement tests below. They print `file:line`
  or the token that broke.

## Enforcement

The docs are a contract because these tests read them, or read the code against them:

| Test                                                         | What it fails on                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/frontend/tests/unit/design-system-conformance.test.ts` | A class outside the vocabulary in any `.ts`, `.tsx` or `.css` under `apps/frontend/src`: retired colour and font names, glass and gradients, radii, shadows and type sizes off the scale, bold and light weights, `uppercase` and wide tracking, opacity tints, raw palette colours, arbitrary colour values, raw `black` / `white` overlays, 10px and 14px spacing steps, `transition-all` and `scale-*`, and a literal icon size on an `EmptyState`. |
| `apps/frontend/tests/unit/design-tokens-doc.test.ts`         | A colour token in `index.css` that is missing from the tables in [`foundations.md`](./foundations.md), or a value that differs in either theme. It parses the `\| Token \| Utility \| Dark \| Light \| Use \|` rows.                                                                                                                                                                                                                                   |
| `apps/frontend/tests/unit/design-token-contrast.test.ts`     | Status text under 4.5:1 on its own tint (success and warning over `canvas`, `sidebar` and `surface`; danger and info over `canvas` and `surface`), `on-scrim-media` under 4.5:1 over `scrim-media` on a white pixel, or that pair differing between themes.                                                                                                                                                                                            |
| `apps/frontend/tests/unit/stylesheet-cascade.test.ts`        | An unlayered rule that styles a replaced element (`img`, `svg`, `video`…) by its bare tag, the coarse-pointer 44px floor losing an exemption, or the timeline row height drifting from it.                                                                                                                                                                                                                                                             |
| `apps/frontend/tests/unit/stylesheet-downlevel.test.ts`      | A `color-mix()` in a stylesheet, a timeline density gap written without a unit, or `index.css` no longer compiling with both themes and the elevation variables.                                                                                                                                                                                                                                                                                       |
| `apps/frontend/tests/unit/lib/motion/tokens.test.ts`         | `lib/motion/tokens.ts` disagreeing with the duration and easing tokens in `index.css`.                                                                                                                                                                                                                                                                                                                                                                 |
| `apps/shared/tests/unit/i18n-copy-rules.test.ts`             | Copy that breaks the rules in [`patterns.md`](./patterns.md): three dots instead of `…`, "Mango Studio" in two words, lower-case file change badges, and keys that differ between `en` and `pt-BR`.                                                                                                                                                                                                                                                    |

Run them from the repository root:

```sh
bun test apps/frontend/tests/unit/design-system-conformance.test.ts \
  apps/frontend/tests/unit/design-tokens-doc.test.ts \
  apps/frontend/tests/unit/design-token-contrast.test.ts \
  apps/frontend/tests/unit/stylesheet-cascade.test.ts \
  apps/frontend/tests/unit/stylesheet-downlevel.test.ts \
  apps/frontend/tests/unit/lib/motion/tokens.test.ts \
  apps/shared/tests/unit/i18n-copy-rules.test.ts
```

`bun run test` runs them with everything else. A deliberate exception to the
conformance test goes in its `ALLOWED` map with the reason;
[`migration.md`](./migration.md) explains the process.

## Where it lives in code

| Concern                                                  | File                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------------- |
| Tokens, themes, utilities, the composer and timeline CSS | `apps/frontend/src/index.css`                                              |
| Markdown typography                                      | `apps/frontend/src/styles/markdown-content.css`                            |
| Shared components                                        | `apps/frontend/src/components/ui/`, `apps/frontend/src/components/layout/` |
| Settings building blocks (rows, sections, segments, nav) | `apps/frontend/src/components/settings/`                                   |
| The current-item bar                                     | `apps/frontend/src/components/ui/selection-bar.ts`                         |
| Class merging that understands the custom scale          | `apps/frontend/src/lib/utils.ts` (`cn`)                                    |
| Icon sizes                                               | `apps/frontend/src/lib/icon-sizes.ts`                                      |
| Runner identity colours (`dotClass`, `colorVar`)         | `apps/frontend/src/lib/agent-identity.ts`                                  |
| The chat column and its gutter                           | `apps/frontend/src/features/chat/lib/chat-column.ts`                       |
| Controls on a picture (`MEDIA_CONTROL_CLASS`)            | `apps/frontend/src/features/gallery/components/media-control.ts`           |
| Motion tokens and presets for JavaScript animation       | `apps/frontend/src/lib/motion/`                                            |
