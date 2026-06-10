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

`.github/workflows/release.yml` then runs four jobs:

| Job                | What it does                                                                                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build`            | Verifies versions are in lockstep with the tag, cross-compiles every platform binary (`build.ts`), and assembles the npm distribution (`pack-npm.ts`); uploads archives + `dist-npm/`. |
| `github-release`   | Creates the GitHub Release with the binary archives and git-cliff notes.                                                                                                               |
| `npm-publish`      | Publishes the platform packages, then the `@mangostudio/cli` wrapper.                                                                                                                  |
| `update-changelog` | Regenerates `CHANGELOG.md` and commits it back to `main`.                                                                                                                              |

`workflow_dispatch` accepts an explicit `version` input for a manual run; it is
validated against the committed version the same way.

## npm distribution

`@mangostudio/cli` is a thin wrapper: its `bin/mangostudio.js` shim resolves the
`@mangostudio/cli-<os>-<cpu>` optional dependency npm installed for the host and
execs the prebuilt binary (esbuild-style). Each platform package carries the
binary plus its `public/` frontend sidecar. Builders live in
`scripts/lib/npm-pack.ts`; staging in `scripts/release/pack-npm.ts`.

## Prerequisites

- **`NPM_TOKEN`** repo secret with publish rights to the `@mangostudio` scope.
- Permission for the release workflow to push `CHANGELOG.md` to `main`
  (`contents: write`); adjust if branch protection blocks the bot.

The first release (`v0.1.0`) is cut by pushing the tag after this work merges.
