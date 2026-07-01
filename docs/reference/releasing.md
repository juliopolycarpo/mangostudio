# Releasing

MangoStudio ships as standalone binaries (GitHub Releases), as a Docker image on
GHCR, as an npm CLI (`mangostudio`), via a Homebrew tap, via a Scoop bucket
(Windows), and as a crates.io launcher crate (`cargo install mangostudio`). The
changelog is generated from Conventional Commits with [git-cliff](https://git-cliff.org);
nothing here is hand-edited.

## One-shot contract

Setting the secrets below and pushing a signed semver tag (`v0.2.0`) is the entire
release procedure. The workflow validates version lockstep, builds every artifact,
publishes each channel independently, and always opens a pull request updating
`CHANGELOG.md` on `main` (never a direct push).

| Secret                      | Used by                                                                          | Scope                                                                                                                                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NPM_TOKEN`                 | `npm-publish`, `npm-canary`                                                      | Publish rights on `mangostudio` and `@mangostudio/cli-*`                                                                                                                                                                     |
| `DIST_REPOS_TOKEN`          | `homebrew`, `scoop`                                                              | Fine-grained PAT with contents read/write on `juliopolycarpo/homebrew-tap` and `juliopolycarpo/scoop-bucket`                                                                                                                 |
| `CARGO_REGISTRY_TOKEN`      | `cargo-publish`, `crates-canary`                                                 | Temporary crates.io fallback until Trusted Publishing is registered and verified for the `mangostudio` crate                                                                                                                 |
| `CHANGELOG_PR_TOKEN`        | `update-changelog`                                                               | Fine-grained PAT with pull requests write (+ contents read) on this repository; opens the changelog PR, since the workflow `GITHUB_TOKEN` cannot create pull requests                                                        |
| *(built-in `GITHUB_TOKEN`)* | `github-release`, `docker`, `update-changelog`, the canary channel, attestations | No extra setup — workflow grants `packages: write` for GHCR, `contents: write` so `update-changelog` can write the GitHub-Verified changelog commit via the REST Contents API, and `id-token: write` for crates.io OIDC auth |

### One-time setup checklist

Complete these once per fork or org before the first tag push:

1. Create the shared Homebrew tap [`juliopolycarpo/homebrew-tap`](https://github.com/juliopolycarpo/homebrew-tap) with a `Formula/` directory.
2. Create the shared Scoop bucket [`juliopolycarpo/scoop-bucket`](https://github.com/juliopolycarpo/scoop-bucket) with a `bucket/` directory.
3. Reserve the `mangostudio` crate name on [crates.io](https://crates.io) and generate an API token for the initial publish.
4. Configure crates.io Trusted Publishing for the existing `mangostudio` crate: crate **Settings -> Trusted Publishing -> Add -> GitHub**, repository owner `juliopolycarpo`, repository name `mangostudio`, workflow filename `release.yml`, and no environment unless the release job is later moved behind a GitHub environment.
5. Add the repo secrets (`NPM_TOKEN`, `DIST_REPOS_TOKEN`, `CHANGELOG_PR_TOKEN`, and the temporary `CARGO_REGISTRY_TOKEN` fallback) to this repository.
6. After one release proves `cargo-publish` minted a Trusted Publishing token successfully, remove the `CARGO_REGISTRY_TOKEN` repo secret. Until then, the release job falls back to the secret if crates.io has not accepted the OIDC publisher yet.
7. After the first GHCR push, set the `ghcr.io/juliopolycarpo/mangostudio` package visibility to **public** in GitHub package settings.
8. No branch-protection tuning is required for the changelog: the `update-changelog` job always opens a pull request with `CHANGELOG_PR_TOKEN` through GitHub's REST API rather than pushing to `main` directly. The commit itself is written with the built-in `GITHUB_TOKEN` via the REST Contents API, so it lands GitHub-Verified and carries a DCO `Signed-off-by: github-actions[bot]` trailer. Review and merge that PR with a merge commit after checks pass.

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

Each platform archive has a **flat root**: `mangostudio` (or `mangostudio.exe`),
`public/`, and `README.md` — no nested platform directory. The binary resolves
its frontend sidecar beside the real executable path.

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
Pass `--expect <version>` to additionally require the committed version to match a
tag (the release workflow runs `bun run check:versions --expect <tag>`).

## Changelog

`bun run changelog` wraps git-cliff (config: `cliff.toml`):

| Command                                  | Effect                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| `bun run changelog --init [version]`     | Regenerate `CHANGELOG.md` from full history (default tag: root version) |
| `bun run changelog --preview [--base r]` | Print this branch's entries (powers the PR preview bot)                 |
| `bun run changelog --release <version>`  | Regenerate `CHANGELOG.md` including `<version>`                         |

Every PR gets a **Changelog Preview** bot comment showing the entries it would
add. It is published by the PR QA workflow (`.github/workflows/pr-qa-gate.yml`)
together with the commit summary and QA gate comments.

## Testing the release pipeline

`.github/workflows/release-dry-run.yml` runs automatically for PRs that touch
release workflows, release scripts, install scripts, binary build tooling, CLI
packages, or Dockerfiles. It also runs weekly as a drift check and can be started
manually with `workflow_dispatch`. (This is read-only and unrelated to the
[Canary channel](#canary-channel), which actually publishes from `main`.)

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
job in `.github/workflows/ci.yml` is gated on every other CI job passing and on a
push to `main`, so the commit that just went green is the canary source — there is
no separate trigger or SHA re-resolution. It calls the reusable
`.github/workflows/canary.yml`, whose jobs share the build and fan out per channel.

Docker and npm use `<root-version>-canary.<sha7>` (e.g.
`0.1.0-canary.1234abc`), where `<sha7>` is the 7-char short commit SHA. Cargo
uses a fixed `<root-version>-canary` prerelease (e.g. `0.1.0-canary`) whose
downloaded assets are refreshed by every green `main` commit. Consume any canary
channel:

```bash
# Docker — rolling tag (newest green) or the immutable per-commit tag
docker pull ghcr.io/juliopolycarpo/mangostudio:canary
docker pull ghcr.io/juliopolycarpo/mangostudio:canary-1234abc

# npm — the `canary` dist-tag; `latest` is never touched
npm install -g mangostudio@canary

# Cargo — fixed prerelease version backed by rolling GitHub release assets
cargo install mangostudio --version 0.1.0-canary
```

| Channel | Job             | What it publishes                                                                                                                       |
| ------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Docker  | `docker-canary` | Debian Bookworm multi-arch (amd64 + arm64) under the rolling `canary` tag and the immutable `canary-<sha7>` tag. Alpine stays tag-only. |
| npm     | `npm-canary`    | `mangostudio@<version>` under the `canary` dist-tag, so `npm i -g mangostudio` (latest) never resolves to a canary.                     |
| crates  | `crates-canary` | `mangostudio <root>-canary`, backed by a rolling `v<root>-canary` GitHub pre-release whose assets are clobbered each green main commit. |

Each channel is independent and idempotent, exactly like the tag release: a docker
failure never blocks npm or crates, and **Re-run failed jobs** re-runs only the failed
channel (the `canary-summary` job writes a per-channel ✅/❌ table naming
the job to re-run). The `canary-publish` concurrency group cancels superseded
in-flight runs so the rolling `canary` tag and dist-tag always track the newest
green commit; per-commit versions are unique, so a cancelled run never leaves a
conflicting half-publish.

Caveats:

- The crates.io canary deliberately does **not** publish
  `…-canary.<sha7>` versions. crates.io versions are permanent (only yankable,
  never deletable), so a compromised per-SHA canary crate could not be removed
  without contacting the crates.io team.
- crates.io has no npm-style mutable `canary` dist-tag for `cargo install`; Cargo
  canary is a fixed prerelease for the current root version, while the GitHub
  release assets behind that launcher are mutable.
- Canary-like `v<version>-canary.<sha7>` tags remain excluded from the tag release
  trigger (`!v*-canary*`) as a guard for legacy or manual per-SHA tags.

## Cutting a release

Releases are tag-driven. From an up-to-date `main`:

1. Bump the version to the same value in every lockstep `package.json` (root,
   `apps/*`, and `packages/cli`; see [Version source](#version-source)) and in
   `packages/cargo-shim/Cargo.toml`, then refresh the crate lockfile with
   `cargo update --workspace` (run inside `packages/cargo-shim/`).
2. Run `bun run check:versions` to confirm they agree, then commit the bump.
3. Tag and push (the tag must match the committed version):

   ```bash
   git tag -s v0.2.0 -m "v0.2.0"
   git push origin v0.2.0
   ```

`.github/workflows/release.yml` is designed to converge when a networked release
step flakes: **Re-run failed jobs** is always safe because channel jobs are
independent — one failing never blocks the others. Published npm versions are
skipped, release assets upload with clobber semantics, and the changelog push
rebases before retrying (or opens a REST-created PR if `main` is protected). For extra
durability: build artifacts retain for 30 days, the `docker` job retries each
multi-arch push and falls back to downloading the published GitHub Release when
its build artifact has expired (so it re-runs in isolation long after the run),
and the always-run `release-summary` job writes a per-channel ✅/❌ table naming
the exact job to re-run.

It runs 14 jobs — the publish channels, the gates that verify them, and a final
summary, listed here in workflow order:

| Job                | What it does                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build`            | Verifies versions are in lockstep with the tag, cross-compiles every platform binary (`build.ts`), assembles the npm distribution (`pack-npm.ts`), and uploads binary archives plus `SHA256SUMS`.                                                                                                                                                                            |
| `verify-build`     | Smoke-tests the freshly built linux-x64 archive (`smoke-binary.sh`) before any channel publishes, so a broken binary fails the release early. Gates `github-release`, `docker`, and `npm-publish`.                                                                                                                                                                           |
| `github-release`   | Creates the GitHub Release, or updates an existing one by refreshing notes and uploading assets with `--clobber`.                                                                                                                                                                                                                                                            |
| `docker`           | Stages Linux glibc and musl archives into `docker-ctx/` (`stage-docker-ctx.ts`) and publishes Bookworm and Alpine images for amd64 and arm64. It uses only `GITHUB_TOKEN` with `packages: write`.                                                                                                                                                                            |
| `verify-image`     | Pulls each published GHCR image (Bookworm and Alpine, amd64 and arm64) and boots it (`smoke-docker-image.sh`). Depends on `docker`; its matrix legs are non-blocking for the other channels.                                                                                                                                                                                 |
| `npm-publish`      | Publishes the platform packages, then the `mangostudio` wrapper; already-published versions are skipped, transient failures are retried, and provenance falls back to a warning-only publish if npm rejects it.                                                                                                                                                              |
| `homebrew`         | Renders `Formula/mangostudio.rb` from `SHA256SUMS` (`update-homebrew.ts`) and pushes it to `juliopolycarpo/homebrew-tap` (`push-dist-repo.ts`). No other job depends on it, so a tap failure never blocks npm or the Release.                                                                                                                                                |
| `scoop`            | Renders `bucket/mangostudio.json` from `SHA256SUMS` (`update-scoop.ts`) and pushes it to `juliopolycarpo/scoop-bucket` (`push-dist-repo.ts`). No other job depends on it, so a bucket failure never blocks npm or the Release.                                                                                                                                               |
| `cargo-publish`    | Publishes the `mangostudio` launcher crate (`packages/cargo-shim`) to crates.io using Trusted Publishing when crates.io has registered `.github/workflows/release.yml`, with `CARGO_REGISTRY_TOKEN` as a temporary fallback. Idempotent: already-published versions are skipped, publishes are retried, and an upload that lands despite an error is detected. Non-blocking. |
| `verify-release`   | Installs `mangostudio@<version>` from npm on Ubuntu, macOS, and Windows; downloads the matching release tarball, verifies `SHA256SUMS`, and runs `mangostudio --version`. Windows arm64 is published but not verified.                                                                                                                                                       |
| `verify-cargo`     | Installs `mangostudio` from crates.io, points the launcher at the GitHub Release assets, and checks `mangostudio --version`. Depends on `cargo-publish`.                                                                                                                                                                                                                     |
| `verify-homebrew`  | Taps `juliopolycarpo/homebrew-tap`, `brew install`s the formula on macOS, and checks `mangostudio --version`. Depends on `homebrew`.                                                                                                                                                                                                                                         |
| `update-changelog` | Regenerates `CHANGELOG.md` and lands it on `main` via `push-changelog.ts`: direct push (rebasing if another commit landed first), or a REST-created PR when branch protection rejects the push. A dedicated concurrency group serializes it across concurrent tag releases.                                                                                                  |
| `release-summary`  | Always runs (even when a channel fails) and writes a per-channel ✅/❌ status table to the run summary (`publish-summary.sh`), naming the exact job to re-run. Because the fan-out isolates failures, a partial release is recovered by re-running only the failed job(s).                                                                                                   |

`workflow_dispatch` accepts an explicit `version` input for a manual run; it is
validated against the committed version the same way.

## npm distribution

`mangostudio` is a thin wrapper: its `bin/mangostudio.js` shim resolves the
`@mangostudio/cli-<os>-<cpu>` optional dependency npm installed for the host and
execs the prebuilt binary (esbuild-style). Each platform package carries the
binary plus its `public/` frontend sidecar. Builders live in
`scripts/lib/npm-pack.ts`; staging in `scripts/release/pack-npm.ts`.

`scripts/release/publish-npm.ts` owns npm publication. It checks
`npm view <name>@<version> version` before publishing, uses `npm publish --access
public --provenance` for new versions, retries transient network/5xx failures,
and never retries a 403/version-conflict without first re-checking whether the
version became visible. `--dry-run` prints the same decisions without publishing,
and `--tag <dist-tag>` publishes under a non-default dist-tag (the
[Canary channel](#canary-channel) uses `--tag canary` so `latest` never moves):

```bash
bun ./scripts/release/publish-npm.ts dist-npm --dry-run
bun ./scripts/release/publish-npm.ts dist-npm --tag canary
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

Between tags, the [Canary channel](#canary-channel) publishes the same image under
the `canary` (rolling) and `canary-<sha7>` (immutable) tags — Bookworm multi-arch
only.

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

The formula installs the flat archive (`mangostudio` + `public/` + `README.md`)
into `libexec` and symlinks the binary, because the binary resolves its
`public/` frontend sidecar beside its real (symlink-resolved) executable path.

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
   Scoop bucket below) and save it as the **`DIST_REPOS_TOKEN`** repo secret.

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
   `"bin": "mangostudio.exe"`; Scoop's shim execs the real exe path, so the
   binary resolves its `public/` frontend sidecar beside it.
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

## crates.io launcher

`cargo install mangostudio` (and `cargo binstall mangostudio`) installs a thin
Rust launcher from `packages/cargo-shim/` — the only Rust in the repository. On
first run it downloads the platform archive matching the crate version from the
GitHub release into `~/.mango/dist/<version>/` (verified against `SHA256SUMS`,
same layout as the shell installer) and execs the real binary. See
[`packages/cargo-shim/README.md`](../../packages/cargo-shim/README.md).

Design notes:

- binstall's prebuilt strategies are **intentionally disabled** in the crate
  metadata: the app needs its `public/` sidecar beside the binary, and binstall
  only installs binaries out of an archive, which would drop the UI. binstall
  therefore falls back to compiling the launcher, which installs the complete
  archive on first run.
- musl is detected at compile time (`target_env = "musl"`); Alpine users should
  prefer the shell installer, which detects musl at runtime.
- The crate's CI lane (`.github/workflows/cargo-shim.yml`) is path-filtered to
  `packages/cargo-shim/**`, so Bun-only changes never wait on a Rust toolchain.
- The `cargo-publish` release job checks crates.io before publishing and
  re-checks between retries, so workflow re-runs converge instead of failing on
  "version already exists".
- The [Canary channel](#canary-channel) publishes only the fixed
  `<root>-canary` crate version for Cargo, never a per-SHA
  `…-canary.<sha7>` crate. The launcher refreshes canary assets on each run so
  installed canary users track the rolling `v<root>-canary` GitHub pre-release.

## Prerequisites

The [One-shot contract](#one-shot-contract) table lists every secret. In short:

- **`NPM_TOKEN`** repo secret with publish rights to `mangostudio` and the
  `@mangostudio/cli-*` platform packages.
- **`DIST_REPOS_TOKEN`** repo secret: fine-grained PAT with contents read/write
  on `juliopolycarpo/homebrew-tap` (see [Homebrew tap](#homebrew-tap)) and
  `juliopolycarpo/scoop-bucket` (see [Scoop bucket](#scoop-bucket)).
- **`CARGO_REGISTRY_TOKEN`** repo secret: crates.io API token with
  `publish-new` + `publish-update` scope for the `mangostudio` crate (see
  [crates.io launcher](#cratesio-launcher)).
- **`CHANGELOG_PR_TOKEN`** repo secret: fine-grained PAT with pull requests
  write (+ contents read) on this repository, used to open the changelog PR
  (the workflow `GITHUB_TOKEN` cannot create pull requests).
- Permission for the release workflow to land `CHANGELOG.md` on `main`: the
  `update-changelog` job grants `contents: write` so the built-in `GITHUB_TOKEN`
  can write the changelog commit via the REST Contents API (GitHub-Verified,
  with a DCO `Signed-off-by` trailer), then opens the pull request with
  `CHANGELOG_PR_TOKEN` — `main` stays protected and no branch-protection
  changes are needed.

The npm publish job grants `id-token: write` so token-based publishes can include
npm provenance. npm trusted publishing (OIDC without `NPM_TOKEN`) is the future
upgrade path once the packages are configured on npmjs.com.

The first release (`v0.1.0`) is cut by pushing the tag after this work merges.
