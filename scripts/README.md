# scripts/

Bun-native automation for the monorepo. Every script runs under `bun` (no
node/tsx/ts-node) and is invoked from the repo root, usually via a `package.json`
script (`bun run <name>`).

## Layout

```
scripts/
├── dev.ts            Start dev servers (bun run dev)
├── build.ts          Build workspaces or standalone binaries (bun run build)
├── check.ts          Biome + dprint + madge + tsc + workflow static analysis, in parallel (bun run check)
├── check-versions.ts Assert root + workspace + cargo-shim versions agree (bun run check:versions)
├── update-node-release-schedule.ts
│                     Refresh bundled Node lifecycle and latest-patch data
├── fix.ts            Apply Biome + dprint fixes (bun run fix)
├── test.ts           Run unit/integration/e2e/coverage lanes (bun run test)
├── verify.ts         check → test → build gate (bun run verify)
├── clean.ts          Remove build artifacts (bun run clean)
├── changelog.ts      git-cliff wrapper: init/preview/release (bun run changelog)
├── bench/            Hermetic performance measurement (startup.ts)
├── lib/              Shared toolkit (see below)
├── examples/         Runnable maintainer samples (dependency-free Bun scripts)
├── install/          Archive-install smoke fixture for the release dry-run (install.sh, not shipped; canonical installers live at mangostudio.dev)
├── qa-gate/          PR metrics collector, comment renderers + comment publisher
├── release/          Release-time packaging + publication (see below)
├── vendor/           Regenerate + drift-check committed vendor contracts (bun run vendor-contracts:regen)
└── tests/            Cross-cutting unit tests (co-located tests live beside sources)
```

## lib/ — shared toolkit

`lib/runner.ts` is a barrel re-exporting focused, single-concern modules — prefer
importing the specific module in new code:

| Module               | Concern                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `log.ts`             | Leveled console output + ANSI colors                                                                 |
| `args.ts`            | CLI argument + workspace-selection parsing                                                           |
| `git.ts`             | Change detection (`Bun.spawnSync`), workspace mapping                                                |
| `exec.ts`            | `runCommand`, `captureCommand`, `mapWithConcurrency`, `archiveConcurrency`, `runParallel`, `runTask` |
| `summary.ts`         | Pass/fail reporting + exit handling                                                                  |
| `fs.ts`              | Cross-platform `removePaths` (no spawned `rm`)                                                       |
| `fs-assert.ts`       | `assertFile`/`assertDirectory` (throw) + `fileError` (collect)                                       |
| `config.ts`          | Workspace definitions + root lint/format path lists                                                  |
| `changelog.ts`       | git-cliff arg/format logic (wrapped behind a project API)                                            |
| `npm-pack.ts`        | npm distribution manifest builders                                                                   |
| `release-version.ts` | Canonical release version resolver + lockstep consistency check                                      |
| `prepare-release.ts` | Two-phase lockstep version bump for release preparation                                              |
| `actions-lint/`      | Pinned workflow static analysis: manifest, bootstrap, tasks                                          |

## actions-lint/ — workflow static analysis

`bun run check` runs three pinned binaries against the repository's automation
surface, as does CI's Check job (same script):

- **actionlint** over `.github/workflows/**`, with ShellCheck applied to
  embedded `run:` scripts;
- **zizmor** over workflows + composite actions in blocking
  `--persona pedantic --min-confidence high` mode (offline audits only);
- **ShellCheck** over every tracked `*.sh` file.

`lib/actions-lint/manifest.ts` pins each tool's version, per-platform release
asset, and SHA-256. `lib/actions-lint/bootstrap.ts` downloads the archive,
verifies the checksum, rejects unsafe archive entry paths, and caches the
binary under the ignored `.mango/artifacts/tools/`; nothing unverified is ever
executed, and a populated cache works offline. Scoped runs (`--staged` /
`--changed`) trigger the lane only when `.github/**`, `*.sh`, or
`scripts/lib/actions-lint/**` changed — and then always repository-wide.

Dependabot cannot bump these pins. To update a tool: bump `version`, the asset
names, and the SHA-256s in `manifest.ts` in one commit, taking checksums from
the upstream release (`actionlint_<version>_checksums.txt` for actionlint;
`sha256sum` over the downloaded archives for zizmor/ShellCheck). The unit
tests and CI cache key (`lint.yml`) follow the manifest automatically.

Suppressions policy: fix findings at the source. When a finding is truly
unavoidable, suppress it at the narrowest scope (inline
`# zizmor: ignore[rule]` / `# shellcheck disable=SCnnnn`) with rule ID and
reason — never a global ignore.

## qa-gate/ — PR QA report automation

Powers the consolidated QA report comment on every PR. Collection runs
unprivileged inside CI (`ci.yml`); publishing runs in the trusted
`pr-qa-report.yml` workflow with default-branch tooling only:

- `collect-test-metrics.ts` — emit the test fragment (suite outcome, duration,
  failure counts and error headlines, coverage summaries) right after CI's
  single `bun run test --coverage` pass.
- `collect.ts` + `collect/*` — merge the test fragment with LoC, bundle,
  dependency, duplication, and tooling metrics into the versioned `qa-metrics`
  envelope (`metrics-envelope.ts`), uploaded for PR heads and main baselines.
  In CI, bundle stats measure the frontend `dist` artifact from the Build job
  (`QA_FRONTEND_DIST`); local runs build the frontend when that env var is unset.
- `metrics-envelope.ts` — TypeBox schema + provenance validation the publisher
  applies to untrusted artifact JSON (size cap, shape, repository/SHA/PR match).
- `render-report.ts` + `report-document.ts` + `render/*` + `commit-log.ts` —
  render the consolidated comment: commit summary, changelog preview, and the
  QA comparison (verdict headline, summary deltas, collapsed metric tables).
- `publish/report-pipeline.mjs` — trusted-side input resolution (open-PR
  lookup by exact head SHA, size-capped artifact downloads, exact-base
  baseline run lookup). Plain ESM so `actions/github-script` imports it.
- `publish/managed-comments.mjs` — publisher that updates the report comment
  in place by marker (update-or-create), cleans up legacy/duplicate managed
  comments, and skips publishing when the PR head has moved on.

## release/ — release-time packaging + publication

Run by `.github/workflows/release.yml`; each is also runnable locally:

| Script                        | Concern                                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `prepare-release.ts`          | Stage a release: lockstep bump + changelog + self-check (`bun run release:prepare`)                  |
| `archive-assets.ts`           | Assemble `release-assets/` (platform archives, installers, `SHA256SUMS`)                             |
| `bundle-distribution.ts`      | Create content-addressed scoped (checksums, assets, npm) and per-target distribution bundles         |
| `distribution-manifest.ts`    | Record and verify distribution identity, file sizes, and SHA-256 checksums                           |
| `extract-distribution.ts`     | Reject unsafe bundle paths, then extract a downloaded distribution                                   |
| `extract-target.ts`           | Safely materialize `.mango/out/<target>` from a verified target archive                              |
| `stage-docker-ctx.ts`         | Stage Linux glibc/musl binaries into `docker-ctx/` for Docker Buildx                                 |
| `pack-npm.ts`                 | Stage `.mango/out/<arch>` binaries into the npm distribution                                         |
| `publish-npm.ts`              | Idempotent npm publication with retry + required provenance policy (`--tag`, `--provenance-policy`)  |
| `verify-checksum.ts`          | Check one downloaded asset against `SHA256SUMS`                                                      |
| `template-renderer.ts`        | Shared renderer: fill `{{VERSION}}`/`{{SHA_*}}` from `SHA256SUMS`                                    |
| `update-homebrew.ts`          | Render `Formula/mangostudio.rb` from `SHA256SUMS` + `templates/`                                     |
| `update-scoop.ts`             | Render `bucket/mangostudio.json` from `SHA256SUMS` + `templates/`                                    |
| `push-dist-repo.ts`           | Push changed files into an external dist repo (tap/bucket), idempotently                             |
| `publish-summary.sh`          | Render a per-channel ✅/❌ publish table into the GitHub step summary                                |
| `retry.sh`                    | `retry_command` helper sourced by workflow shell steps                                               |
| `upload-release-assets.sh`    | `upload_release_assets` helper: delete conflicting assets by id, then upload (retry-safe)            |
| `create-or-update-release.sh` | `create_or_update_release` helper: stateful create/edit with post-failure `gh release view` recovery |

## examples/ — maintainer samples

Runnable Bun scripts for manual verification (no extra dependencies):

| Script                  | Purpose                                                           |
| ----------------------- | ----------------------------------------------------------------- |
| `external-api-smoke.ts` | Probe `/api/health` and an authenticated GET with `MANGO_API_KEY` |

```bash
MANGO_API_KEY='mango_…' bun run scripts/examples/external-api-smoke.ts http://localhost:3001
```

## bench/ — hermetic performance measurement

| Script       | Purpose                                                            |
| ------------ | ------------------------------------------------------------------ |
| `startup.ts` | Median process-start → first healthy `GET /api/health` of a binary |

```bash
bun run scripts/bench/startup.ts .mango/out/linux-x64/mangostudio --runs 10
bun run scripts/bench/startup.ts .mango/out/linux-x64/mangostudio --warm
```

Every run gets a temp `HOME`, database, uploads, and images directory, so the
developer's real `~/.mango` is never read or written. Cold (default) measures a
first run with every migration applying; `--warm` migrates once, discards that
run, and measures the restart cost — the only mode where framework and
module-load time are visible rather than buried under migration work.

Compare two binaries by building both and running the same command against
each; a startup claim is only worth as much as its median and spread.

## vendor/ — committed vendor contracts

Every vendor surface the external-agent adapters depend on is pinned and committed, so a version
bump shows up as a reviewable diff instead of a silent behaviour change.

```bash
bun run vendor-contracts:regen                    # recapture everything installed
bun run vendor-contracts:regen --only cursor-acp  # one set
bun run vendor-contracts:check                    # diff instead of writing (what CI runs)
bun run vendor-contracts:check --require-all      # also fail when a set was skipped
```

| Set              | Artifacts                                                        | Produced by                                          |
| ---------------- | ---------------------------------------------------------------- | ---------------------------------------------------- |
| `codex-protocol` | `codex/protocol/**` — the generated TypeScript API               | `bunx @openai/codex@<pinned> app-server generate-ts` |
| `cursor-acp`     | `cursor/contract/` — `initialize`, `session/new`, `session/list` | a live `cursor-agent acp` handshake                  |
| `claude-cli`     | `claude/contract/` — the CLI surface and `auth status` shape     | `claude --help` and `claude auth status`             |

Artifacts live beside the adapter that reads them; each set's `contract/manifest.json` records the
command, the build it came off, the date, and a checksum — without which a regeneration that
produced identical output is indistinguishable from one that was never run.

**Additive drift is reported, not failed.** A vendor removing or changing something a capture
recorded fails the check; a vendor adding something is noted. All three CLIs ship constantly, and a
check that failed on every release would train maintainers to rerun it rather than read it.

**Cursor and Claude captures are normalized**, keeping object keys and leaf types while discarding
values. `session/list` returns the operator's own session titles and working directories and
`claude auth status` returns an email address and an organization name, none of which is
reproducible or ours to publish. Values survive only where the value *is* the contract — a
negotiated `protocolVersion`, a permission mode's id.

Codex's generator is invoked as a **pinned package**, read from
`apps/runtime/src/services/external-agents/codex/pinned.ts`, so it reproduces on a machine with no
Codex installed. Bump the version there, rerun without `--check`, and commit the diff. Nothing under
`protocol/` or `*/contract/` is formatted by Biome — formatting vendor output would make every
regeneration report a diff that is ours rather than theirs.

## Conventions

- **Bun-native.** Use `Bun.spawn`/`Bun.spawnSync`/`Bun.file`/`node:fs` over shelling
  out. Pass command arguments as arrays, never interpolated shell strings.
- **Short, single-concern files.** Split anything large by responsibility, as
  `qa-gate/collect/*` and `qa-gate/render/*` do.
- **Every helper gets a test.** Put cross-cutting tests in `tests/`; tests that pin
  one module may sit beside it (`*.unit.test.ts`). All are picked up by `bun test scripts`.
- **Wrap third-party tools** behind a project-owned module (see `lib/changelog.ts`
  around git-cliff) so the integration is testable and swappable.

## Code health scan

`bun run check` runs Knip as a blocking repository-wide task. Use
`bun run code-health` for the standalone unused code and dependency report.
Register runtime-loaded files as narrow workspace entries in `knip.json`; dependency
ignores require execution evidence documented in `docs/reference/testing.md`.

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
lockstep; with `--expect <version>` it also requires `CHANGELOG.md` to carry the
`<version>` release section (the release workflow's pre-build gate).

`bun run release:prepare <version>` stages a release in one command: it bumps
every lockstep manifest (`lib/prepare-release.ts`), regenerates `CHANGELOG.md`
via `changelog --release`, and re-runs `check:versions --expect` as a
self-check. Committing and tagging stay manual.

`scripts/release/pack-npm.ts` turns `.mango/out/<arch>` binaries into the npm
distribution. See `docs/reference/releasing.md` for the full release flow.
