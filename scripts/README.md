# scripts/

Bun-native automation for the monorepo. Every script runs under `bun` (no
node/tsx/ts-node) and is invoked from the repo root, usually via a `package.json`
script (`bun run <name>`).

## Layout

```
scripts/
├── dev.ts            Start dev servers (bun run dev)
├── build.ts          Build workspaces or standalone binaries (bun run build)
├── check.ts          Biome + dprint + madge + tsgo, in parallel (bun run check)
├── check-versions.ts Assert root + workspace + cargo-shim versions agree (bun run check:versions)
├── fix.ts            Apply Biome + dprint fixes (bun run fix)
├── test.ts           Run unit/integration/e2e/coverage lanes (bun run test)
├── verify.ts         check → test → build gate (bun run verify)
├── clean.ts          Remove build artifacts (bun run clean)
├── changelog.ts      git-cliff wrapper: init/preview/release (bun run changelog)
├── lib/              Shared toolkit (see below)
├── qa-gate/          PR metrics collector, comment renderers + comment publisher
├── release/          Release-time packaging + publication (see below)
└── tests/            Cross-cutting unit tests (co-located tests live beside sources)
```

## lib/ — shared toolkit

`lib/runner.ts` is a barrel re-exporting focused, single-concern modules — prefer
importing the specific module in new code:

| Module               | Concern                                                         |
| -------------------- | --------------------------------------------------------------- |
| `log.ts`             | Leveled console output + ANSI colors                            |
| `args.ts`            | CLI argument + workspace-selection parsing                      |
| `git.ts`             | Change detection (`Bun.spawnSync`), workspace mapping           |
| `exec.ts`            | `runCommand`, `runWorkspaceScript`, `runParallel`, `runTask`    |
| `summary.ts`         | Pass/fail reporting + exit handling                             |
| `fs.ts`              | Cross-platform `removePaths` (no spawned `rm`)                  |
| `config.ts`          | Workspace definitions + root lint/format path lists             |
| `changelog.ts`       | git-cliff arg/format logic (wrapped behind a project API)       |
| `npm-pack.ts`        | npm distribution manifest builders                              |
| `release-version.ts` | Canonical release version resolver + lockstep consistency check |

## qa-gate/ — PR comment automation

Powers the bot comments the `pr-qa-gate.yml` workflow manages on every PR:

- `collect.ts` + `collect/*` — gather coverage, LoC, bundle, dependency,
  duplication, test, and tooling metrics into a `metrics.json`.
- `render.ts` + `render/*` — render the QA-gate comparison comment (verdict
  headline, summary deltas, collapsed metric tables) from base/head metrics.
- `render-commits.ts` + `commit-log.ts` — render the commit-summary comment
  (list + expandable full messages) from the PR's base..head range.
- `publish/managed-comments.mjs` — publisher that re-posts the managed
  comments at the bottom of the PR timeline (creates the new set, then deletes
  the previous one). Plain ESM so `actions/github-script` imports it directly;
  it skips publishing when the PR head has moved on.

## release/ — release-time packaging + publication

Run by `.github/workflows/release.yml`; each is also runnable locally:

| Script               | Concern                                                                  |
| -------------------- | ------------------------------------------------------------------------ |
| `archive-assets.ts`  | Assemble `release-assets/` (platform archives, installers, `SHA256SUMS`) |
| `pack-npm.ts`        | Stage `.mango/out/<arch>` binaries into the npm distribution             |
| `publish-npm.ts`     | Idempotent npm publication with retry + provenance fallback              |
| `verify-checksum.ts` | Check one downloaded asset against `SHA256SUMS`                          |
| `update-homebrew.ts` | Render `Formula/mangostudio.rb` from `SHA256SUMS` + `templates/`         |
| `push-dist-repo.ts`  | Push changed files into an external dist repo (tap/bucket), idempotently |
| `retry.sh`           | `retry_command` helper sourced by workflow shell steps                   |

## Conventions

- **Bun-native.** Use `Bun.spawn`/`Bun.spawnSync`/`Bun.file`/`node:fs` over shelling
  out. Pass command arguments as arrays, never interpolated shell strings.
- **Short, single-concern files.** Split anything large by responsibility, as
  `qa-gate/collect/*` and `qa-gate/render/*` do.
- **Every helper gets a test.** Put cross-cutting tests in `tests/`; tests that pin
  one module may sit beside it (`*.unit.test.ts`). All are picked up by `bun test scripts`.
- **Wrap third-party tools** behind a project-owned module (see `lib/changelog.ts`
  around git-cliff) so the integration is testable and swappable.

## Adding a script

1. Create `scripts/<name>.ts`; import helpers from `lib/`.
2. Add `"<name>": "bun ./scripts/<name>.ts"` to the root `package.json`.
3. Add a unit test under `scripts/tests/` for any non-trivial logic.
4. Run `bun run check && bun test scripts`.

## Changelog & releases

`bun run changelog` wraps [git-cliff](https://git-cliff.org) (config: `cliff.toml`):

- `--init [version]` — regenerate `CHANGELOG.md` from full history (default tag: the root `package.json` version)
- `--preview [--base <ref>]` — print the current branch's entries (used by the PR bot)
- `--release <version>` — regenerate `CHANGELOG.md` including `<version>`

The release version (build, npm packaging, and changelog) resolves through
`lib/release-version.ts`: the root `package.json` version, overridable by the
`VERSION` env var, validated as semver. `bun run check:versions` keeps the root,
workspace, and `packages/cargo-shim/Cargo.toml`/`Cargo.lock` versions in
lockstep.

`scripts/release/pack-npm.ts` turns `.mango/out/<arch>` binaries into the npm
distribution. See `docs/reference/releasing.md` for the full release flow.
