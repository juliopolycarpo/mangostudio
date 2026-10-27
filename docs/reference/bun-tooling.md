# Bun lint coverage

`bunfig.toml` keeps the repository's lint rules and generated-file exclusions. Bun's
recommended rules provide the general JavaScript and TypeScript checks. Explicit rules
cover the additional policies previously configured in Biome: typed promise and operand
checks, import restrictions, TypeScript style, React hooks, JSX keys, and labels. The
frontend override permits dictionary imports in i18n plumbing and tests; only the
live-versus-reload test may import API internals. The shared root import remains forbidden
including type-only imports. `scripts/tests/bun-lint.integration.test.ts` exercises these
boundaries and checks that Bun runs typed promise, hooks, and label rules.

Bun's `import/no-cycle` ignores type-only imports. The separate graph check in `scripts/lib/import-cycles.ts` includes
those edges and generated or gitignored source files. Both workspace and root checks
run it. QA counts deterministic DFS back-edge witnesses; overlapping graphs can have a
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
input. Repository schema and TypeScript checks remain separate.

The formatter retains 100-column lines, two-space indentation, single-quoted JavaScript,
and double-quoted CSS and YAML. Generated routes and runtime contracts, byte-sensitive
protocol/runtime fixtures, changelogs, lockfiles, and output caches are excluded.
`bun-format.integration.test.ts` checks all 18 former source/document extensions and
verifies that excluded files retain their bytes.
