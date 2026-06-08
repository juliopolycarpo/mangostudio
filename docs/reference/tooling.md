# Tooling

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

| Task               | Cache | Notes                             |
| ------------------ | ----- | --------------------------------- |
| `dev`              | off   | Persistent — runs dev servers     |
| `build`            | on    | Depends on upstream `^build`      |
| `check:quick`      | on    | Lint / format checks              |
| `typecheck`        | on    | TypeScript type-checking          |
| `circular`         | on    | Circular dependency detection     |
| `test:unit`        | on    | Unit tests                        |
| `test:integration` | off   | Integration tests (always re-run) |
| `test:coverage`    | off   | Coverage reports (always re-run)  |

### Inspection Scripts

| Script                  | Purpose                                       |
| ----------------------- | --------------------------------------------- |
| `bun run turbo:version` | Print the installed Turborepo version         |
| `bun run turbo:dry`     | Dry-run the build graph (JSON output)         |
| `bun run turbo:graph`   | Export the build graph to `.turbo/graph.html` |

### Cache Directory

Turborepo writes its local cache to `.turbo/` at the repository root. This
directory is gitignored and should never be committed.

### Future Work

- Interactive TUI (`ui: "tui"`) — evaluated separately.
- Remote Cache for CI.
- `--affected` filtering in CI pipelines.
- Package-specific Turbo configuration once the base graph is stable.
