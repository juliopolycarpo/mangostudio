# Releasing

MangoStudio ships as standalone binaries (GitHub Releases), as a Docker image on
GHCR, as an npm CLI (`mangostudio`), via a Homebrew tap, via a Scoop bucket
(Windows), and through crates.io (`cargo binstall mangostudio` or
`cargo install mangostudio`). The changelog is generated from Conventional
Commits with [git-cliff](https://git-cliff.org) at release preparation and
enforced at tag time; nothing here is hand-edited.

## One-shot contract

With the secrets below set, releasing is `bun run release:prepare <version>`, one
commit, and a signed semver tag push (`v0.2.0`). The workflow validates version
lockstep and the pre-tag changelog, builds every artifact, and publishes each
channel independently. The tag ships its own `CHANGELOG.md` — nothing writes back
to `main` after the release.

| Secret                      | Used by                                                      | Scope                                                                                                         |
| --------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `NPM_TOKEN`                 | `npm-publish` (env), `npm-canary` (repo)                     | `release` environment secret for stable publish; repository secret kept for canary (validated in those jobs)  |
| `DIST_REPOS_TOKEN`          | `homebrew`, `scoop`                                          | `release` environment secret — fine-grained PAT with contents read/write on the Homebrew tap and Scoop bucket |
| `CARGO_REGISTRY_TOKEN`      | `cargo-publish` (optional)                                   | Legacy crates.io token used only when `workflow_dispatch` sets `allow_legacy_cargo_token=true`                |
| *(built-in `GITHUB_TOKEN`)* | `github-release`, `docker`, the canary channel, attestations | No extra setup — tag releases grant `packages: write` for GHCR and `id-token: write` for crates.io OIDC auth  |

### `release` environment

Stable publish credentials live in the GitHub Environment named `release`, not
as free-floating repository secrets:

- **Deployment branches and tags:** restricted to tags matching `v*.*.*`.
- **Required reviewers:** none — a tag push still releases unattended.
- **Jobs that declare it:** `github-release`, `docker`, `npm-publish`,
  `homebrew`, `scoop`, and `cargo-publish`. Adding a new publish channel means
  joining this environment, not adding a repository secret.
- **Canary is excluded:** `.github/workflows/canary.yml` publishes on every
  green push to `main`, which the tag rule would block. It keeps using the
  repository-scoped `NPM_TOKEN`.
- **Manual dispatch:** because the environment is tag-restricted, a
  `workflow_dispatch` run of `release.yml` must target a `v*.*.*` tag ref
  (`gh workflow run release.yml --ref v0.2.0`), not a branch.

### One-time setup checklist

Complete these once per fork or org before the first tag push:

1. Create the shared Homebrew tap [`juliopolycarpo/homebrew-tap`](https://github.com/juliopolycarpo/homebrew-tap) with a `Formula/` directory.
2. Create the shared Scoop bucket [`juliopolycarpo/scoop-bucket`](https://github.com/juliopolycarpo/scoop-bucket) with a `bucket/` directory.
3. Reserve the `mangostudio` crate name on [crates.io](https://crates.io) and generate an API token only if you need the temporary legacy fallback.
4. Configure crates.io Trusted Publishing for the existing `mangostudio` crate: crate **Settings -> Trusted Publishing -> Add -> GitHub**, repository owner `juliopolycarpo`, repository name `mangostudio`, workflow filename `release.yml`, and leave the environment field empty. The `cargo-publish` job declares `environment: release`, but crates.io configs with no environment still match — do not set an environment on the crates.io side unless you intentionally want to require one.
5. Create the `release` GitHub Environment (tag rule `v*.*.*`, no required reviewers) and add `NPM_TOKEN` and `DIST_REPOS_TOKEN` as **environment** secrets. Keep a repository-scoped `NPM_TOKEN` for canary. Keep `CARGO_REGISTRY_TOKEN` only while you still need the explicit `allow_legacy_cargo_token` dispatch escape hatch. After a green release through the environment, delete the repository-level `DIST_REPOS_TOKEN`.
6. After a release proves `cargo-publish` minted a Trusted Publishing token successfully, revoke and delete `CARGO_REGISTRY_TOKEN`. Do not leave a long-lived crates.io write token in the repository once OIDC is proven.
7. Configure npm Trusted Publishing for `mangostudio` and each `@mangostudio/cli-*` package (npm package **Settings -> Trusted Publisher**) against `.github/workflows/release.yml` / `.github/workflows/canary.yml` once you are ready to drop `NPM_TOKEN`. Until that cutover, token auth still requires provenance (`--provenance-policy required`).
8. After the first GHCR push, set the `ghcr.io/juliopolycarpo/mangostudio` package visibility to **public** in GitHub package settings.
9. No branch-protection tuning or extra token is required for the changelog: `CHANGELOG.md` lands on `main` in the release-prep commit (`bun run release:prepare`) **before** the tag is pushed, and the release workflow only verifies it is there.

## Release asset naming

Every downstream channel (Homebrew, Scoop, Cargo launcher, the mangostudio.dev
install scripts) hardcodes these public asset names. Do not rename them without
updating every template and installer in the same release.

| Asset                                        | Notes                                                                                                                      |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `mangostudio-<version>-<platform>.tar.gz`    | Linux and macOS platforms (`linux-x64`, `linux-arm64`, `linux-x64-musl`, `linux-arm64-musl`, `darwin-x64`, `darwin-arm64`) |
| `mangostudio-<version>-<platform>.zip`       | Windows platforms (`windows-x64`, `windows-arm64`)                                                                         |
| `mangostudio-<version>-frontend-dist.tar.gz` | Frontend bundle only (`apps/frontend/dist`)                                                                                |
| `SHA256SUMS`                                 | Checksums for every asset above                                                                                            |

Each platform archive has a **flat root**: `mangostudio` (or `mangostudio.exe`)
and `README.md` — no nested platform directory. The binary embeds the frontend
UI; no sibling asset directory is required at runtime.

`scripts/release/archive-assets.ts` assembles the full set; `scripts/lib/release-assets.ts`
defines the naming contract and is covered by unit tests.

Install scripts are **not** release assets. The canonical installers are hosted at
[mangostudio.dev](https://mangostudio.dev) (`install.sh` / `install.ps1`) and download
the platform archives above, verifying them against `SHA256SUMS`. The repo keeps
`scripts/install/install.sh` only as a dry-run/test fixture (see below).

## Version source

There is **one** release version. The root `package.json` `version` is canonical;
the `VERSION` environment variable (set by the release workflow from the pushed
tag) overrides it. `scripts/lib/release-version.ts` resolves it for the binary
build, the npm packaging step, and the changelog, validating semver so a typo
fails before any artifact is produced — no silent `0.0.0` / `0.0.1` fallbacks.

The root and every shipped workspace must carry the same version and release in
lockstep:

- `package.json`
- `apps/api/package.json`, `apps/frontend/package.json`, `apps/shared/package.json`
- `packages/cli/package.json`
- `packages/cargo-shim/Cargo.toml` **and** `packages/cargo-shim/Cargo.lock` (the
  lockfile records the crate's own version and the release publishes with
  `--locked`, so both must move together)

`bun run check:versions` enforces this; it also runs as part of `bun run check`.
Pass `--expect <version>` to additionally require the committed version to match
a tag **and** `CHANGELOG.md` to carry the `<version>` release section (the
release workflow runs `bun run check:versions --expect <tag>` before building
any artifact). `bun run release:prepare <version>` stages all of the above in
one command.

## Changelog

The changelog is generated at release preparation — `bun run release:prepare`
regenerates `CHANGELOG.md` alongside the version bump, so the section for a
release lands on `main` **before** its tag is pushed. The release workflow only
gates on it being there; no job writes the changelog back after the fact.

`bun run changelog` wraps git-cliff (config: `cliff.toml`):

| Command                                             | Effect                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| `bun run changelog --init [version]`                | Regenerate `CHANGELOG.md` from full history (default tag: root version) |
| `bun run changelog --preview [--base r] [--head r]` | Print this branch's entries (powers the PR preview bot)                 |
| `bun run changelog --release <version>`             | Regenerate `CHANGELOG.md` including `<version>`                         |

Every PR gets a changelog preview as part of the single managed QA report
comment, published by `.github/workflows/pr-qa-report.yml` together with the
commit summary and QA metrics comparison.

## Testing the release pipeline

`.github/workflows/release-dry-run.yml` triggers on every PR, but a cheap
`changes` job runs the actual dry-run lanes only for PRs that touch release
workflows, release scripts, install scripts, binary build tooling, CLI packages,
or Dockerfiles; its always-reporting `Release Dry Run / Gate` check makes the
workflow safe to require in branch protection (see
[`ci.md`](./ci.md#branch-protection--required-checks)). It also runs weekly as a
drift check and can be started manually with `workflow_dispatch`. (This is
read-only and unrelated to the [Canary channel](#canary-channel), which actually
publishes from `main`.)

The dry-run is read-only: it verifies lockstep versions, builds one Linux binary
with a synthetic prerelease version, assembles and validates the matching npm
distribution, runs the npm publisher in `--dry-run` mode, archives the binary,
verifies `SHA256SUMS`, installs the local tarball through `install.sh --local`,
and renders Homebrew and Scoop manifests into the runner temp directory. PRs
that touch `packages/cargo-shim/**` also run `cargo publish --dry-run --locked`;
scheduled and manual dry-run runs include that cargo check as well.

Only a real signed tag exercises registry and repository side effects: npm
publication, GHCR push, GitHub Release upload, Homebrew tap push, Scoop bucket
push, crates.io publication, and the cross-platform `verify-release` matrix.
Those steps stay in `.github/workflows/release.yml`.

## Canary channel

Every commit that lands green on `main` is published as a **canary**. The canary
job in `.github/workflows/ci.yml` is gated on the aggregate `CI / Gate` job — the
single definition of a green commit, which fails on any mandatory job failure,
cancellation, or unexpected skip — and on a push to `main`, so the commit that
just went green is the canary source — there is no separate trigger or SHA
re-resolution. It calls the reusable
`.github/workflows/canary.yml`, whose jobs share the build and fan out per channel.

npm uses `<root-version>-canary.<sha7>` (e.g. `0.1.0-canary.1234abc`), where
`<sha7>` is the 7-char short commit SHA. GitHub Releases uses a rolling
`v<root-version>-canary` pre-release whose notes record the source SHA and full
canary version. Its asset names stay fixed at `<root-version>-canary` so the
already-published Cargo canary launcher can keep resolving them. Consume canary
builds with npm or the GitHub pre-release archives:

```bash
# npm — the `canary` dist-tag; `latest` is never touched
npm install -g mangostudio@canary

# GitHub Releases — rolling pre-release archives and SHA256SUMS
gh release download v0.1.0-canary --repo juliopolycarpo/mangostudio

# Cargo — existing fixed prerelease launcher backed by the rolling assets
cargo install mangostudio --version 0.1.0-canary
```

| Channel         | Job                     | What it publishes                                                                                                                      |
| --------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub Releases | `github-release-canary` | Rolling `v<root>-canary` pre-release assets and `SHA256SUMS`, clobbered each green main commit and named for the fixed Cargo launcher. |
| npm             | `npm-canary`            | `mangostudio@<version>` under the `canary` dist-tag, so `npm i -g mangostudio` (latest) never resolves to a canary.                    |

Each channel is independent and idempotent, exactly like the tag release: a
GitHub release upload failure never blocks npm, and **Re-run failed jobs**
re-runs only the failed channel (the `canary-summary` job writes a per-channel
✅/❌ table naming the job to re-run). The `canary-publish` concurrency group
cancels superseded in-flight runs so the rolling pre-release and npm dist-tag
always track the newest green commit; per-commit npm versions are unique, so a
cancelled run never leaves a conflicting half-publish.

Caveats:

- `ghcr.io/juliopolycarpo/mangostudio:canary` and
  `ghcr.io/juliopolycarpo/mangostudio:canary-<sha7>` are no longer updated.
  Existing GHCR canary tags remain in the registry until manually cleaned up.
  Docker users who need between-tag builds should switch to the npm canary
  (`npm install -g mangostudio@canary`) or download the GitHub pre-release
  archives. Tagged releases still publish the full Docker image set.
- The workflow no longer publishes crates.io canaries. The currently published
  `<root>-canary` launcher keeps working because the rolling GitHub pre-release
  assets keep refreshing under the same asset names. A future root-version bump
  will not get a new `<root>-canary` crate unless Cargo canary publishing is
  intentionally reintroduced.
- Canary-like `v<version>-canary.<sha7>` tags remain excluded from the tag release
  trigger (`!v*-canary*`) as a guard for legacy or manual per-SHA tags.

## Nightly distribution health

`.github/workflows/nightly-distribution-health.yml` runs daily at 06:00 UTC (plus
`workflow_dispatch`) and verifies the **published** channels — the bytes users
actually install — instead of rebuilding source targets that per-PR CI already
smokes on every pull request.

A `resolve` job pins one immutable identity up front: the exact npm version
behind the channel dist-tag, the matching GitHub release tag, the canary version
recorded in that release's notes, and a snapshot of its `SHA256SUMS` (handed to
the matrix as a run artifact). Every lane consumes that pin, so a canary publish
landing mid-run can never make jobs disagree — it surfaces as an explicit
checksum or version mismatch instead. If the npm canary and the rolling
pre-release diverge (one channel failed its last publish), the resolve job emits
a warning naming both versions.

| Lane                               | Unique signal                                                                                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm <os>` (Linux, macOS, Windows) | Fresh `npm install -g` of the exact resolved version, `--version` assert, hermetic `doctor` in a throwaway home; then upgrade from the pinned stable. |
| `Archive <os>`                     | Download the release archive, verify it against the pinned `SHA256SUMS`, extract, and run `scripts/release/smoke-binary.sh`.                          |

Dispatch inputs: `channel` (`canary` default, or `stable`), `version` (exact npm
version override), and `deep_diagnostics` (runs `doctor --all`).

Deliberate boundaries:

- No build or dependency caches — the lanes test published bytes and installer
  metadata, not source reproducibility.
- Homebrew and Scoop have no canary channel; their stable manifests are rendered
  and verified by the release pipeline (`update-homebrew.ts` / `update-scoop.ts`),
  so the nightly does not reinstall them.
- A migration/recovery lane against an older database is deferred until a
  checked-in, non-secret fixture policy exists.

Failures rely on the standard failed-scheduled-run notification (no auto-filed
issues); npm debug logs are uploaded only on failure and retained for 14 days.
Reproduce a lane locally:

```bash
# npm lane (any OS with node)
npm install -g mangostudio@<exact-version>
mangostudio --version && mangostudio doctor

# archive lane (substitute the resolved tag/platform)
gh release download v0.1.1-canary -p 'mangostudio-0.1.1-canary-linux-x64.tar.gz' -p SHA256SUMS
bun ./scripts/release/verify-checksum.ts SHA256SUMS mangostudio-0.1.1-canary-linux-x64.tar.gz
tar -xzf mangostudio-0.1.1-canary-linux-x64.tar.gz
scripts/release/smoke-binary.sh ./mangostudio <canary-version-from-release-notes>
```

The workflow contract (pinned identity, no caches, failure-only diagnostics) is
enforced by `scripts/tests/nightly-distribution-health.unit.test.ts`.

## Cutting a release

Releases are tag-driven. From an up-to-date `main`:

1. Stage the release — one command bumps every lockstep manifest (see
   [Version source](#version-source)), regenerates `CHANGELOG.md` with
   git-cliff, and re-runs `check:versions --expect` as a self-check:

   ```bash
   bun run release:prepare 0.2.0
   ```

2. Commit the staged tree as the release-prep commit (`cliff.toml` skips
   `chore(release)` commits, so it never re-enters a future changelog):

   ```bash
   git add -A && git commit -s -S -m "chore(release): v0.2.0"
   ```

3. Land that commit on `main` (via the normal PR flow), then tag it and push
   (the tag must match the committed version):

   ```bash
   git tag -s v0.2.0 -m "v0.2.0"
   git push origin v0.2.0
   ```

A tag whose commit lacks the changelog section or a lockstep version fails in
the `prepare` job before any artifact is produced, naming the fix
(`bun run release:prepare`). The same job refuses to release a commit that is
not an ancestor of `origin/main` or whose aggregate **`CI / Gate`** check (API
check-run name `Gate`) did not conclude `success`. A tag push cannot skip that
provenance gate. **`workflow_dispatch`** may set `allow_unverified_source=true`
only as a deliberate break-glass path (logged as a workflow warning); use it
when check runs have aged out of the API but the commit is still the intended
release, and call out the bypass in the release notes.

`.github/workflows/release.yml` is designed to converge when a networked release
step flakes: **Re-run failed jobs** is always safe because channel jobs are
independent — one failing never blocks the others. Published npm versions are
skipped and release assets upload with clobber semantics. For extra
durability: build artifacts retain for 30 days, the `docker` job retries each
multi-arch push against the verified distribution artifact, and the always-run
`release-summary` job writes a per-channel ✅/❌ table naming the exact job to
re-run, plus auth/provenance outcomes for npm and crates.io.

It runs 14 jobs — preparation, the publish channels, the gates that verify them, and a final
summary, listed here in workflow order:

| Job               | What it does                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepare`         | Resolves the release version and source SHA, verifies versions are in lockstep with the tag and that `CHANGELOG.md` carries the release section (`check:versions --expect`), and requires the tagged commit to be a green ancestor of `origin/main` (`CI / Gate` / API name `Gate`) unless dispatch sets `allow_unverified_source=true`.                                           |
| `build`           | Cross-compiles every platform binary (`build.ts`), assembles the npm distribution (`pack-npm.ts`), and uploads binary archives plus `SHA256SUMS`.                                                                                                                                                                                                                                  |
| `verify-build`    | Smoke-tests the freshly built linux-x64 archive (`smoke-binary.sh`) before any channel publishes, so a broken binary fails the release early. Gates `github-release`, `docker`, and `npm-publish`.                                                                                                                                                                                 |
| `github-release`  | Creates the GitHub Release, or updates an existing one by refreshing notes and uploading assets with `--clobber`.                                                                                                                                                                                                                                                                  |
| `docker`          | Stages Linux glibc and musl archives into `docker-ctx/` (`stage-docker-ctx.ts`) and publishes Bookworm and Alpine images for amd64 and arm64. It uses only `GITHUB_TOKEN` with `packages: write`.                                                                                                                                                                                  |
| `verify-image`    | Pulls each published GHCR image (Bookworm and Alpine, amd64 and arm64) and boots it (`smoke-docker-image.sh`). Depends on `docker`; its matrix legs are non-blocking for the other channels.                                                                                                                                                                                       |
| `npm-publish`     | Publishes the platform packages, then the `mangostudio` wrapper; already-published versions are skipped, transient failures are retried, and provenance is **required** (never silently dropped).                                                                                                                                                                                  |
| `homebrew`        | Renders `Formula/mangostudio.rb` from `SHA256SUMS` (`update-homebrew.ts`) and pushes it to `juliopolycarpo/homebrew-tap` (`push-dist-repo.ts`). No other job depends on it, so a tap failure never blocks npm or the Release.                                                                                                                                                      |
| `scoop`           | Renders `bucket/mangostudio.json` from `SHA256SUMS` (`update-scoop.ts`) and pushes it to `juliopolycarpo/scoop-bucket` (`push-dist-repo.ts`). No other job depends on it, so a bucket failure never blocks npm or the Release.                                                                                                                                                     |
| `cargo-publish`   | Publishes the `mangostudio` launcher crate (`packages/cargo-shim`) to crates.io using Trusted Publishing OIDC. Already-published versions are skipped before minting credentials. A legacy `CARGO_REGISTRY_TOKEN` path exists only when `workflow_dispatch` sets `allow_legacy_cargo_token=true` and is labeled `legacy-explicit` in the summary. Non-blocking for other channels. |
| `verify-release`  | Installs `mangostudio@<version>` from npm on Ubuntu, macOS, and Windows; downloads the matching release tarball, verifies `SHA256SUMS`, and runs `mangostudio --version`. Windows arm64 is published but not verified.                                                                                                                                                             |
| `verify-cargo`    | Installs `mangostudio` from crates.io, points the launcher at the GitHub Release assets, and checks `mangostudio --version`. Depends on `cargo-publish`.                                                                                                                                                                                                                           |
| `verify-homebrew` | Taps `juliopolycarpo/homebrew-tap`, `brew install`s the formula on macOS, and checks `mangostudio --version`. Depends on `homebrew`.                                                                                                                                                                                                                                               |
| `release-summary` | Always runs (even when a channel fails) and writes a per-channel ✅/❌ status table plus auth/provenance rows to the run summary (`publish-summary.sh`), naming the exact job to re-run. Because the fan-out isolates failures, a partial release is recovered by re-running only the failed job(s).                                                                               |

`workflow_dispatch` accepts an explicit `version` input for a manual run; it is
validated against the committed version the same way. Optional boolean inputs:
`allow_unverified_source` (skip main ancestry and `CI / Gate` provenance —
break-glass only) and `allow_legacy_cargo_token` (legacy crates.io token when OIDC
mint fails). Point the dispatch at a
`v*.*.*` tag ref (`gh workflow run release.yml --ref v0.2.0`) — the publish jobs
run in the tag-restricted [`release` environment](#release-environment), so a
dispatch from a branch is rejected before any channel publishes.

## npm distribution

`mangostudio` is a thin wrapper: its `bin/mangostudio.js` shim resolves the
`@mangostudio/cli-<os>-<cpu>` optional dependency npm installed for the host and
execs the prebuilt binary (esbuild-style). Each platform package carries the
binary (frontend embedded at build time). Builders live in
`scripts/lib/npm-pack.ts`; staging in `scripts/release/pack-npm.ts`.

`scripts/release/publish-npm.ts` owns npm publication. It checks
`npm view <name>@<version> version` before publishing, uses `npm publish --access
public --provenance` for new versions under `--provenance-policy required`
(stable and canary), retries transient network/5xx failures, and never retries a
403/version-conflict without first re-checking whether the version became
visible. Provenance rejection is fatal under `required` — there is no silent
downgrade. `--dry-run` prints the same decisions without publishing, and
`--tag <dist-tag>` publishes under a non-default dist-tag (the
[Canary channel](#canary-channel) uses `--tag canary` so `latest` never moves):

```bash
bun ./scripts/release/publish-npm.ts dist-npm --dry-run
bun ./scripts/release/publish-npm.ts dist-npm --tag canary --provenance-policy required
```

Release archives are accompanied by `SHA256SUMS`; the verification job checks the
runner-specific archive against that manifest before executing the extracted
binary's `--version` command.

## Docker image

`ghcr.io/juliopolycarpo/mangostudio:<version>` is the default Debian Bookworm
image and is built from the Linux glibc release archives rather than compiling
inside Docker. The release workflow extracts the `linux-x64`, `linux-arm64`,
`linux-x64-musl`, and `linux-arm64-musl` tarballs into `docker-ctx/`, then Docker
Buildx publishes two-platform manifests for the Bookworm and Alpine variants.
The bare version and `latest` tags point to Bookworm; Alpine is published under
the `-alpine` version suffix:

```bash
docker pull ghcr.io/juliopolycarpo/mangostudio:0.1.0
docker run -p 3001:3001 -v mango-data:/data \
  -e BETTER_AUTH_SECRET="change-me-to-32-plus-chars" \
  ghcr.io/juliopolycarpo/mangostudio:0.1.0

docker pull ghcr.io/juliopolycarpo/mangostudio:0.1.0-alpine
```

The image stores runtime state below `/data` by setting `HOME=/data`; mount that
path for config, SQLite, uploads, generated images, agent files, logs, and run
state. No extra registry secret is required because the release job grants
`packages: write` to the workflow `GITHUB_TOKEN`. On first publication, make the
GHCR package public in the repository package settings if public pulls are
desired.

The [Canary channel](#canary-channel) no longer updates Docker images. Existing
`canary` and `canary-<sha7>` GHCR tags remain available until manually removed,
but they do not track new `main` commits. Tagged releases still publish the full
Bookworm and Alpine image set.

## Homebrew tap

`brew install juliopolycarpo/tap/mangostudio` works on macOS and Linux via the
**shared** tap repo [`juliopolycarpo/homebrew-tap`](https://github.com/juliopolycarpo/homebrew-tap)
(`homebrew-<tap>` → `brew tap juliopolycarpo/tap`). It is shared so future
projects reuse the same distribution route: each project owns one
`Formula/<name>.rb` and a release job that rewrites only that file.

The `homebrew` job updates the formula on every tag push:

1. `scripts/release/update-homebrew.ts` parses `SHA256SUMS`, validates that all
   four `mangostudio-<version>-{darwin,linux}-{arm64,x64}.tar.gz` archives are
   present (failing loud on naming-contract drift), and renders
   `scripts/release/templates/mangostudio.rb.tmpl`.
2. `scripts/release/push-dist-repo.ts` clones the tap, copies the formula only
   if its content changed (re-runs are no-ops), commits as
   `github-actions[bot]`, and pushes with up to three attempts, rebasing onto
   the remote between each. It only ever touches the mapped files, never other
   formulas.

The formula installs the flat archive (`mangostudio` + `README.md`) into
`libexec` and symlinks the binary so the real executable path resolves correctly.

`push-dist-repo.ts` is distribution-agnostic — the [Scoop bucket](#scoop-bucket)
reuses it with a different `--repo` and `--file` mapping:

```bash
bun ./scripts/release/push-dist-repo.ts \
  --repo juliopolycarpo/homebrew-tap \
  --token-env DIST_REPOS_TOKEN \
  --message "mangostudio 0.1.0" \
  --file tap/Formula/mangostudio.rb:Formula/mangostudio.rb
```

The renderer is shared too: `scripts/release/dist-manifest.ts` fills `{{VERSION}}`
and the per-platform `{{SHA_*}}` placeholders from `SHA256SUMS`, and the two thin
entrypoints (`update-homebrew.ts`, `update-scoop.ts`) bind it to their template and
placeholder map.

One-time setup (already done; documented for future projects):

1. Create the shared tap repo: `gh repo create juliopolycarpo/homebrew-tap --public`,
   seeded with a `README.md` and a `Formula/` directory.
2. Create a fine-grained PAT with **contents read/write on the tap repo** (and the
   Scoop bucket below) and save it as the **`DIST_REPOS_TOKEN`** secret on the
   `release` GitHub Environment.

## Scoop bucket

`scoop install mangostudio` works on Windows via the **shared** bucket repo
[`juliopolycarpo/scoop-bucket`](https://github.com/juliopolycarpo/scoop-bucket).
Users add the bucket once under the `juliopolycarpo` alias, then install any app
published there:

```powershell
scoop bucket add juliopolycarpo https://github.com/juliopolycarpo/scoop-bucket
scoop install mangostudio
```

Like the tap, it is shared so future projects reuse the same route: each project
owns one `bucket/<name>.json` and a release job that rewrites only that file.

The `scoop` job updates the manifest on every tag push, mirroring `homebrew`:

1. `scripts/release/update-scoop.ts` parses `SHA256SUMS`, validates that both
   `mangostudio-<version>-windows-{x64,arm64}.zip` archives are present (failing
   loud on naming-contract drift), and renders
   `scripts/release/templates/mangostudio.json.tmpl`. The manifest declares
   `"bin": "mangostudio.exe"`; Scoop's shim execs the real exe path.
2. `scripts/release/push-dist-repo.ts` clones the bucket, copies the manifest only
   if its content changed (re-runs are no-ops), commits as `github-actions[bot]`,
   and pushes with rebase-retry — the same machinery the tap uses.

The manifest also carries Scoop `checkver`/`autoupdate` metadata, so the
community excavator bots can refresh it from the GitHub release even if the push
job ever lags.

One-time setup (already done; documented for future projects):

1. Create the shared bucket repo: `gh repo create juliopolycarpo/scoop-bucket --public`,
   seeded with a `README.md` and a `bucket/` directory.
2. Extend the `DIST_REPOS_TOKEN` PAT with **contents read/write on the bucket
   repo** (the same PAT already covers the Homebrew tap).

## crates.io installs

`cargo binstall mangostudio` installs the prebuilt app binary directly from the
GitHub release archive matching the crate version and target. binstall extracts
only the `mangostudio` binary, so it **omits the bundled `cursor-sidecar/`** that
the archive ships on Cursor-supported platforms — the Cursor provider is
unavailable on a binstall install. Use the shell installer or `cargo install`
(below) for the full Cursor SDK. For Node.js requirements, supported platforms,
and `mangostudio doctor` probes, see
[docs/providers/cursor.md](../providers/cursor.md).

The binstall binary does not use the launcher
cache under `~/.mango/dist/`.

`cargo install mangostudio` builds the thin Rust launcher from
`packages/cargo-shim/` — the only Rust in the repository. On first run it
downloads the platform archive matching the crate version from the GitHub
release into `~/.mango/dist/<version>/` (verified against `SHA256SUMS`, same
layout as the shell installer) and execs the real binary. Both install paths
report the same `mangostudio --version`. See
[`packages/cargo-shim/README.md`](../../packages/cargo-shim/README.md).

Design notes:

- binstall metadata maps Rust target triples to the release archive platform ids
  (`linux-x64`, `darwin-arm64`, `windows-x64`, and so on). The archives have a
  flat root: `mangostudio` (or `mangostudio.exe`), `README.md`, and — on
  Cursor-supported platforms — a `cursor-sidecar/` tree. binstall installs only
  the binary; the sidecar is dropped (binstall installs binaries, not archive
  trees), which is why `cargo install`/the shell installer remain the paths that
  deliver the Cursor SDK.
- musl is detected at compile time (`target_env = "musl"`); Alpine users should
  prefer the shell installer, which detects musl at runtime.
- The crate's CI lane (`.github/workflows/cargo-shim.yml`) triggers on every PR,
  but a cheap `changes` job skips the Rust toolchain unless
  `packages/cargo-shim/**` changed; the always-reporting `Cargo Shim / Gate`
  check makes the lane safe to require in branch protection (see
  [`ci.md`](./ci.md#branch-protection--required-checks)).
- The `cargo-publish` release job checks crates.io before publishing and
  re-checks between retries, so workflow re-runs converge instead of failing on
  "version already exists".
- The [Canary channel](#canary-channel) no longer publishes crates.io canaries.
  Existing installs of the current `<root>-canary` launcher continue to track the
  rolling `v<root>-canary` GitHub pre-release because those assets keep
  refreshing under stable names.

## Prerequisites

The [One-shot contract](#one-shot-contract) table lists every secret. In short:

- **`NPM_TOKEN`** — `release` environment secret with publish rights to
  `mangostudio` and the `@mangostudio/cli-*` platform packages (checked in
  `npm-publish`), plus a repository-scoped copy for `npm-canary`.
- **`DIST_REPOS_TOKEN`** — `release` environment secret: fine-grained PAT with
  contents read/write on `juliopolycarpo/homebrew-tap` (see
  [Homebrew tap](#homebrew-tap)) and `juliopolycarpo/scoop-bucket` (see
  [Scoop bucket](#scoop-bucket)), checked in those jobs only. Delete any
  leftover repository-level copy after a green release through the environment.
- **`CARGO_REGISTRY_TOKEN`** optional legacy secret: crates.io API token with
  `publish-new` + `publish-update` scope, used only when a maintainer sets
  `allow_legacy_cargo_token=true` on `workflow_dispatch`. Prefer Trusted
  Publishing OIDC and revoke this token after a successful OIDC publish.

No token or write permission is needed for the changelog: it lands on `main` in
the release-prep commit before the tag exists, so the release workflow never
writes to the repository.

The npm publish jobs grant `id-token: write`, install Node ≥22.14, publish via
`npx npm@11.5.1`, and require `--provenance`. npm trusted publishing (OIDC without
`NPM_TOKEN`) is the next cutover once the packages are configured on npmjs.com and
a live publish has proven the path.
