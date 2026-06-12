# Releasing

MangoStudio ships as standalone binaries (GitHub Releases), as a Docker image on
GHCR, as an npm CLI (`@mangostudio/cli`), via a Homebrew tap, via a Scoop bucket
(Windows), and as a crates.io launcher crate (`cargo install mangostudio`). The
changelog is generated from Conventional Commits with [git-cliff](https://git-cliff.org);
nothing here is hand-edited.

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
step flakes: using **Re-run failed jobs** is safe because published npm versions
are skipped, release assets are uploaded with clobber semantics, and the
changelog push rebases before retrying.

It runs nine jobs:

| Job                | What it does                                                                                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build`            | Verifies versions are in lockstep with the tag, cross-compiles every platform binary (`build.ts`), assembles the npm distribution (`pack-npm.ts`), and uploads binary archives plus `SHA256SUMS`.                                |
| `github-release`   | Creates the GitHub Release, or updates an existing one by refreshing notes and uploading assets with `--clobber`.                                                                                                                |
| `docker`           | Stages Linux glibc and musl archives into `docker-ctx/` (`stage-docker-ctx.ts`) and publishes Bookworm and Alpine images for amd64 and arm64. It uses only `GITHUB_TOKEN` with `packages: write`.                                |
| `npm-publish`      | Publishes the platform packages, then the `@mangostudio/cli` wrapper; already-published versions are skipped, transient failures are retried, and provenance falls back to a warning-only publish if npm rejects it.             |
| `homebrew`         | Renders `Formula/mangostudio.rb` from `SHA256SUMS` (`update-homebrew.ts`) and pushes it to `juliopolycarpo/homebrew-tap` (`push-dist-repo.ts`). No other job depends on it, so a tap failure never blocks npm or the Release.    |
| `scoop`            | Renders `bucket/mangostudio.json` from `SHA256SUMS` (`update-scoop.ts`) and pushes it to `juliopolycarpo/scoop-bucket` (`push-dist-repo.ts`). No other job depends on it, so a bucket failure never blocks npm or the Release.   |
| `cargo-publish`    | Publishes the `mangostudio` launcher crate (`packages/cargo-shim`) to crates.io. Idempotent: already-published versions are skipped, publishes are retried, and an upload that lands despite an error is detected. Non-blocking. |
| `verify-release`   | Installs `@mangostudio/cli@<version>` from npm on Ubuntu, macOS, and Windows; downloads the matching release tarball, verifies `SHA256SUMS`, and runs `mangostudio --version`. Windows arm64 is published but not verified.      |
| `update-changelog` | Regenerates `CHANGELOG.md` and commits it back to `main`, retrying the push after `git pull --rebase origin main` if another commit lands first.                                                                                 |

`workflow_dispatch` accepts an explicit `version` input for a manual run; it is
validated against the committed version the same way.

## npm distribution

`@mangostudio/cli` is a thin wrapper: its `bin/mangostudio.js` shim resolves the
`@mangostudio/cli-<os>-<cpu>` optional dependency npm installed for the host and
execs the prebuilt binary (esbuild-style). Each platform package carries the
binary plus its `public/` frontend sidecar. Builders live in
`scripts/lib/npm-pack.ts`; staging in `scripts/release/pack-npm.ts`.

`scripts/release/publish-npm.ts` owns npm publication. It checks
`npm view <name>@<version> version` before publishing, uses `npm publish --access
public --provenance` for new versions, retries transient network/5xx failures,
and never retries a 403/version-conflict without first re-checking whether the
version became visible. `--dry-run` prints the same decisions without publishing:

```bash
bun ./scripts/release/publish-npm.ts dist-npm --dry-run
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

## Prerequisites

- **`NPM_TOKEN`** repo secret with publish rights to the `@mangostudio` scope.
- **`DIST_REPOS_TOKEN`** repo secret: fine-grained PAT with contents read/write
  on `juliopolycarpo/homebrew-tap` (see [Homebrew tap](#homebrew-tap)) and
  `juliopolycarpo/scoop-bucket` (see [Scoop bucket](#scoop-bucket)).
- **`CARGO_REGISTRY_TOKEN`** repo secret: crates.io API token with
  `publish-new` + `publish-update` scope for the `mangostudio` crate (see
  [crates.io launcher](#cratesio-launcher)).
- Permission for the release workflow to push `CHANGELOG.md` to `main`
  (`contents: write`); adjust if branch protection blocks the bot.

The npm publish job grants `id-token: write` so token-based publishes can include
npm provenance. npm trusted publishing (OIDC without `NPM_TOKEN`) is the future
upgrade path once the packages are configured on npmjs.com.

The first release (`v0.1.0`) is cut by pushing the tag after this work merges.
