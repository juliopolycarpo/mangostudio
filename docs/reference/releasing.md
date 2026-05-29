# Releasing

MangoStudio ships as standalone binaries (GitHub Releases) and as an npm CLI
(`@mangostudio/cli`). The changelog is generated from Conventional Commits with
[git-cliff](https://git-cliff.org); nothing here is hand-edited.

## Changelog

`bun run changelog` wraps git-cliff (config: `cliff.toml`):

| Command                                  | Effect                                                        |
| ---------------------------------------- | ------------------------------------------------------------- |
| `bun run changelog --init`               | Regenerate `CHANGELOG.md` from full history (baseline v0.1.0) |
| `bun run changelog --preview [--base r]` | Print this branch's entries (powers the PR preview bot)       |
| `bun run changelog --release <version>`  | Regenerate `CHANGELOG.md` including `<version>`               |

Every PR gets a sticky **Changelog Preview** comment
(`.github/workflows/changelog-preview.yml`) showing the entries it would add.

## Cutting a release

Releases are tag-driven. From an up-to-date `main`:

1. Bump the version in the root and workspace `package.json` files.
2. Tag and push:

   ```bash
   git tag -s v0.2.0 -m "v0.2.0"
   git push origin v0.2.0
   ```

`.github/workflows/release.yml` then runs four jobs:

| Job                | What it does                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `build`            | Cross-compiles every platform binary (`build.ts`) and assembles the npm distribution (`pack-npm.ts`); uploads archives + `dist-npm/`. |
| `github-release`   | Creates the GitHub Release with the binary archives and git-cliff notes.                                                              |
| `npm-publish`      | Publishes the platform packages, then the `@mangostudio/cli` wrapper.                                                                 |
| `update-changelog` | Regenerates `CHANGELOG.md` and commits it back to `main`.                                                                             |

`workflow_dispatch` accepts an explicit `version` input for a manual run.

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
