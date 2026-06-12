# Releasing

MangoStudio ships as standalone binaries (GitHub Releases) and as an npm CLI
(`@mangostudio/cli`). The changelog is generated from Conventional Commits with
[git-cliff](https://git-cliff.org); nothing here is hand-edited.

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
   `apps/*`, and `packages/cli`; see [Version source](#version-source)).
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

It runs six jobs:

| Job                | What it does                                                                                                                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build`            | Verifies versions are in lockstep with the tag, cross-compiles every platform binary (`build.ts`), assembles the npm distribution (`pack-npm.ts`), and uploads binary archives plus `SHA256SUMS`.                             |
| `github-release`   | Creates the GitHub Release, or updates an existing one by refreshing notes and uploading assets with `--clobber`.                                                                                                             |
| `npm-publish`      | Publishes the platform packages, then the `@mangostudio/cli` wrapper; already-published versions are skipped, transient failures are retried, and provenance falls back to a warning-only publish if npm rejects it.          |
| `homebrew`         | Renders `Formula/mangostudio.rb` from `SHA256SUMS` (`update-homebrew.ts`) and pushes it to `juliopolycarpo/homebrew-tap` (`push-dist-repo.ts`). No other job depends on it, so a tap failure never blocks npm or the Release. |
| `verify-release`   | Installs `@mangostudio/cli@<version>` from npm on Ubuntu, macOS, and Windows; downloads the matching release tarball, verifies `SHA256SUMS`, and runs `mangostudio --version`. Windows arm64 is published but not verified.   |
| `update-changelog` | Regenerates `CHANGELOG.md` and commits it back to `main`, retrying the push after `git pull --rebase origin main` if another commit lands first.                                                                              |

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
   `github-actions[bot]`, and pushes with up to three `git pull --rebase`
   retries. It only ever touches the mapped files, never other formulas.

The formula installs the flat archive (`mangostudio` + `public/` + `README.md`)
into `libexec` and symlinks the binary, because the binary resolves its
`public/` frontend sidecar beside its real (symlink-resolved) executable path.

`push-dist-repo.ts` is distribution-agnostic — a future Scoop bucket reuses it
with a different `--repo` and `--file` mapping:

```bash
bun ./scripts/release/push-dist-repo.ts \
  --repo juliopolycarpo/homebrew-tap \
  --token-env DIST_REPOS_TOKEN \
  --message "mangostudio 0.1.0" \
  --file tap/Formula/mangostudio.rb:Formula/mangostudio.rb
```

One-time setup (already done; documented for future projects):

1. Create the shared tap repo: `gh repo create juliopolycarpo/homebrew-tap --public`,
   seeded with a `README.md` and a `Formula/` directory.
2. Create a fine-grained PAT with **contents read/write on the tap repo** (extend
   it to the Scoop bucket when that lands) and save it as the **`DIST_REPOS_TOKEN`**
   repo secret.

## Prerequisites

- **`NPM_TOKEN`** repo secret with publish rights to the `@mangostudio` scope.
- **`DIST_REPOS_TOKEN`** repo secret: fine-grained PAT with contents read/write
  on `juliopolycarpo/homebrew-tap` (see [Homebrew tap](#homebrew-tap)).
- Permission for the release workflow to push `CHANGELOG.md` to `main`
  (`contents: write`); adjust if branch protection blocks the bot.

The npm publish job grants `id-token: write` so token-based publishes can include
npm provenance. npm trusted publishing (OIDC without `NPM_TOKEN`) is the future
upgrade path once the packages are configured on npmjs.com.

The first release (`v0.1.0`) is cut by pushing the tag after this work merges.
