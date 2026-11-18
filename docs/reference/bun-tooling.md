# Bun lint coverage

`bunfig.toml` keeps the repository's lint rules and generated-file exclusions. Bun's
recommended rules provide the general JavaScript and TypeScript checks. Explicit rules
cover the additional policies previously configured in Biome: typed promise and operand
checks, the i18n dictionary import restriction, TypeScript style, React hooks, JSX keys, and
labels. The i18n override permits dictionary imports in i18n plumbing and tests.
`scripts/tests/bun-lint.integration.test.ts` exercises it and checks that Bun runs typed
promise, hooks, and label rules.

Two import boundaries are deliberately not in `bunfig.toml`: the `@mangostudio/shared` root
ban (type-only imports included) and the frontend ban on `@mangostudio/api/internal/*`
(type-only imports allowed, one parity-test exception). Each is owned by one source scan in
`bun run check`, `scripts/lib/shared-root-import-boundary.ts` and
`scripts/lib/frontend-api-import-boundary.ts`. Bun's `no-restricted-imports` does not see
`import()`, `require()` or `import('x').T` types, so covering them in lint takes one
`no-restricted-syntax` selector per loader form, repeated in every override block that
replaces the rule's options. The shared root also stays out of `apps/shared/package.json`
`exports`, which is runtime truth, not a lint copy.

Bun's `import/no-cycle` ignores type-only imports. The separate graph check in `scripts/lib/import-cycles.ts` includes
those edges and generated or gitignored source files. Workspace and root checks skip
`dist`, `coverage`, `.turbo`, root `.mango`, and the Cargo target directories.
Source files over 4 MiB produce an error before parsing.
QA counts deterministic DFS back-edge witnesses; overlapping graphs can have a
different count from the former scanner.
Bun does not read `biome-ignore` comments; each suppression needs review and a Bun/ESLint
replacement when still necessary.

Some similarly named rules differ from Biome. For example, Bun's `require-await` reports
async adapters that intentionally satisfy a Promise-returning interface, and its
`no-base-to-string` reports `String()` on unknown values even when the conversion is
intentional. Bun's own type checker can infer different types for library calls. Review
these reports individually before applying fixes or adding a narrowly scoped suppression.

## File coverage

| Files                                | Checks                                                   |
| ------------------------------------ | -------------------------------------------------------- |
| JS, JSX, TS, TSX, MJS, CJS, MTS, CTS | Bun lint, Bun fmt, and the separate import-cycle scanner |
| JSON, JSONC, CSS, HTML               | Bun fmt syntax and formatting checks                     |
| Markdown, MDC, MDX, TOML, YAML       | Bun fmt                                                  |
| Rust                                 | Existing rustfmt, Clippy, and Cargo gates                |
| Dockerfiles                          | Excluded from formatting                                 |

Bun lint currently checks JavaScript and TypeScript. It does not replace Biome's
JSON, CSS, or HTML lint rules: for example, duplicate JSON keys remain valid formatter
input. Repository schema checks and type checking with `bun check --no-script` remain separate.

The formatter retains 100-column lines, two-space indentation, single-quoted JavaScript,
and double-quoted CSS and YAML. Generated routes and runtime contracts, byte-sensitive
protocol/runtime fixtures, changelogs, lockfiles, and output caches are excluded.
`bun-format.integration.test.ts` checks all 18 former source/document extensions and
verifies that excluded files retain their bytes.
