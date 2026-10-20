# MangoStudio design

MangoStudio is a working tool: people spend hours in it talking to agents, reading
diffs and running commands. The interface is **flat, calm and predictable** — solid
surfaces, one accent colour, hairlines — so the same screens can be redrawn in
WinUI 3 or GTK 4 / libadwaita and still read as one product.

| Page                                   | What it answers                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [`foundations.md`](./foundations.md)   | Colour, type, space, radius, elevation, state, motion, icons. The tokens and the rules for each. |
| [`components.md`](./components.md)     | Every shared component: anatomy, which tokens it uses, when to reach for it.                     |
| [`patterns.md`](./patterns.md)         | How the pieces combine: pages, forms, lists, notices, dialogs, status, copy.                     |
| [`native-ports.md`](./native-ports.md) | How each token and component maps to WinUI 3 and libadwaita.                                     |
| [`decisions.md`](./decisions.md)       | Why the system is shaped this way, one decision at a time.                                       |
| [`migration.md`](./migration.md)       | The old → new vocabulary, the conformance test, and how to add an exception.                     |

## Principles

1. **Flat before deep.** Hierarchy comes from the step between surfaces
   (`canvas` → `surface` → `surface-raised`) and a 1px `stroke`. No gradients, no
   glass (`backdrop-filter`), no coloured glow, and no shadow on anything that does
   not float.
2. **One accent.** Mango marks the primary action, the current item and focus.
   Everything else is warm neutral. The `agent-*` hues identify runners and nothing
   else.
3. **The platform's own rhythm.** 32px controls, 6px radius on whatever is
   clickable, a 48px header, 14px text. These are WinUI 3's measurements and within
   a couple of pixels of libadwaita's, so a native build does not have to rescale.
4. **Comfort over contrast theatre.** Text clears 4.5:1 in both themes; structure
   (borders, dividers) stays quiet. No text below 11px and no text faded by opacity.
5. **Terminal as dialect, not theme.** Mono appears where content is technical —
   `key: value` chips, paths, code, tool output, group labels. Titles, buttons and
   prose stay in the interface font.

## Working with it

- Write the class from [`foundations.md`](./foundations.md); do not invent a value.
  If a screen needs something the system does not have, change the system here
  first and say why in [`decisions.md`](./decisions.md).
- Prefer a shared component from `apps/frontend/src/components/ui/` over repeating
  its classes. [`components.md`](./components.md) lists them.
- All user-visible text comes from `@mangostudio/shared/i18n`, in sentence case.
- `apps/frontend/tests/unit/design-system-conformance.test.ts` reads every source
  file and fails on a class outside the vocabulary. Run it after a styling change;
  it prints `file:line` for each offender. [`migration.md`](./migration.md) explains
  the rules and the exception process.
- `apps/frontend/tests/unit/design-tokens-doc.test.ts` keeps the token table in
  [`foundations.md`](./foundations.md) in step with `index.css`.

## Where it lives in code

| Concern                                                  | File                                                     |
| -------------------------------------------------------- | -------------------------------------------------------- |
| Tokens, themes, utilities, the composer and timeline CSS | `apps/frontend/src/index.css`                            |
| Markdown typography                                      | `apps/frontend/src/styles/markdown-content.css`          |
| Shared components                                        | `apps/frontend/src/components/ui/`, `components/layout/` |
| Class merging that understands the scale                 | `apps/frontend/src/lib/utils.ts` (`cn`)                  |
| Icon sizes                                               | `apps/frontend/src/lib/icon-sizes.ts`                    |
