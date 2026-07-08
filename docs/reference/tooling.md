# Tooling

## TypeScript 7

The monorepo type-checks with [TypeScript 7](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/),
the native Go port. TS 7 ships a single `tsc` binary that parallelizes parsing,
type-checking, and emitting across cores, typically 8–12x faster than TS 6 on
full builds.

### Type-checking

Each workspace runs `tsc --noEmit` (pinned to `7.0.2`) via its `typecheck`
script. Turbo orchestrates these across workspaces in parallel, and each `tsc`
invocation further parallelizes internally — the two layers compose without
conflict.

### Parallelization tuning

TS 7 exposes experimental flags for fine-tuning parallelism:

| Flag               | Default | Purpose                                                                                                           |
| ------------------ | ------- | ----------------------------------------------------------------------------------------------------------------- |
| `--checkers N`     | 4       | Number of type-checker workers. Increase on machines with more cores; set to 1 on memory-constrained CI runners.  |
| `--builders N`     | 1       | Parallel project-reference builders under `--build`. Not used here — Turbo handles cross-workspace orchestration. |
| `--singleThreaded` | off     | Disables all parallelism. Useful for debugging order-dependent diagnostics.                                       |

The defaults are left in place; the monorepo is small enough that `--checkers 4`
is the sweet spot. If CI runners run low on memory, set `--checkers 2` or
`--checkers 1` in the workspace `typecheck` scripts.

### Compatibility API

TS 7.0 does not expose a stable programmatic API. The QA-gate coverage scripts
(`scripts/qa-gate/source-*-coverage.ts`) import the compiler API from
`@typescript/typescript6` (pinned to `6.0.2`), the official side-by-side
compatibility package. When TS 7.1 ships a new API, the compat dependency can
be removed.

## Turborepo

This monorepo uses [Turborepo](https://turborepo.dev) **2.x** (currently
`2.9.16`) as its shared build-system layer. Turborepo orchestrates task
execution across workspaces and provides a content-addressable cache so that
unchanged work is never rebuilt.

### Policy

- **Stable 2.x only.** The pinned version in the root `package.json` is the
  single source of truth. No canary builds, no floating ranges.
- **No Remote Cache yet.** Local cache only until the task model is proven.
- **Root Bun wrappers are the public interface.** `bun run dev`, `bun run build`,
  `bun run check`, and `bun run test` remain the canonical commands. Turborepo
  is invoked through them or via the `turbo:*` inspection scripts.

### Configuration

The task graph lives in `turbo.jsonc` at the repository root. The `.jsonc`
extension is used so that inline comments can document migration decisions.

Current task definitions:

| Task               | Cache | Outputs / Env                                      | Notes                                        |
| ------------------ | ----- | -------------------------------------------------- | -------------------------------------------- |
| `dev`              | off   | —                                                  | Persistent — runs dev servers                |
| `build`            | on    | `dist/**`; env `VITE_*`                            | Depends on upstream `^build`; restores dist  |
| `check:quick`      | on    | —                                                  | Lint / format; inputs scoped to `biome.json` |
| `typecheck`        | on    | —                                                  | Inputs scoped to root `tsconfig.json`        |
| `circular`         | on    | —                                                  | Circular dependency detection                |
| `test:unit`        | on    | env `DATABASE_PATH`, `CI`, `MANGOSTUDIO_*`         | Unit tests                                   |
| `test:integration` | off   | env `DATABASE_PATH`, `CI`, `MANGOSTUDIO_*`         | Integration tests (always re-run)            |
| `test:coverage`    | off   | `$TURBO_ROOT$/.mango/artifacts/coverage/**`; env ↑ | Coverage reports (always re-run)             |
| `//#test:scripts`  | on    | inputs `scripts/**`                                | Root scripts tests (cached via turbo)        |

### Inspection Scripts

| Script                  | Purpose                                       |
| ----------------------- | --------------------------------------------- |
| `bun run turbo:version` | Print the installed Turborepo version         |
| `bun run turbo:dry`     | Dry-run the build graph (JSON output)         |
| `bun run turbo:graph`   | Export the build graph to `.turbo/graph.html` |

### Cache Directory

Turborepo writes its local task-output cache to `.turbo/cache` at the repository
root. This directory is gitignored and should never be committed.

CI persists the local Turbo cache with `actions/cache` in the check, test, and
build lanes. Each lane uses a separate key prefix so the lanes never share a
cache entry — each saves and restores only its own snapshot:

```text
${{ runner.os }}-${{ env.CACHE_VERSION }}-turbo-<lane>-${{ github.sha }}
```

The `github.sha` suffix makes every successful run save a fresh cache, while the
lane restore prefix restores the most recent cache for that lane. Bumping
`CACHE_VERSION` still invalidates all CI caches when a cache-poisoning rollback
is needed.

The CI check lane still keeps its separate `.mango/artifacts/tsbuildinfo/` cache
because shared TypeScript build-info files are deliberately not Turbo task
outputs. Vite optimizer caches also remain separate because they are dependency
optimizer state, not task outputs.

### Future Work

- Remote Cache for CI.
- `--affected` filtering in CI pipelines.
- Package-specific Turbo configuration once the base graph is stable.
