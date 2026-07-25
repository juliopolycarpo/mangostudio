# Classification Labels

Every pull request must carry at least one `area:` or `type:` label, and every issue should
carry exactly one `type:` label plus a `status:` label. This page is the full taxonomy behind
those rules.

## What enforces what

`.github/labeler.yml` maps changed-file globs to labels, and the "Verify classification labels"
gate (`.github/workflows/labeler.yml`) fails a PR that ends up with no `area:` or `type:` label.
That gate is a required check on `main` — see [`ci.md`](./ci.md).

PR ownership is separate: the `auto-assign.yml` workflow assigns the author and requests reviews
from prior committers of the PR's changed files (base-branch history), so it needs no per-label
owner config.

For issues, `area:` labels are optional but encouraged when the affected area is clear — they
carry the same routing signal as on PRs. The `issue-triage.yml` workflow enforces the
`type:`/`status:` part: it adds `status: needs triage` on open when no `status:` label is
present, and applies `status: needs author` plus a one-time comment when an **open** issue has
zero or multiple `type:` labels. Closed issues are left alone so label cleanup does not re-nag.

## `area:` (where)

- `area: build` — `scripts/**`, `.mango/**`, `apps/api/src/lib/{config,runtime-paths}.ts`, `tsconfig*.json`, `turbo.jsonc`, `cliff.toml`, `Dockerfile*`, `.dockerignore`
- `area: cli` — `apps/api/src/cli/**`, `apps/api/src/index.ts`, `apps/api/src/server/**`, `apps/api/src/lib/{server-state,mango-paths}.ts`
- `area: tooling` — `biome.json`, `dprint.json`, `lefthook.yml`, `opencode.json`, `.editorconfig`, `.gitattributes`, `.gitmessage`, `.gitignore`, `.claude/**`, `.agents/skills/**`
- `area: db` — `apps/api/src/db/**`
- `area: docs` — `docs/**`, `*.md` under any app or package, `LICENSE`, `.github/**/*.md`, issue/PR templates
- `area: frontend` — `apps/frontend/**`
- `area: api` — `apps/api/**`
- `area: shared` — `apps/shared/**`
- `area: git` — `apps/api/src/modules/{git,github}/**`, `apps/frontend/src/features/workspace/**`, `apps/shared/src/{git,github}/**`
- `area: auth` — auth entry points + `apps/shared/src/auth/**` + `tests/browser-smoke/auth-flow.spec.ts`
- `area: chat` — `apps/api/src/modules/{chats,messages}/**`, `apps/frontend/src/features/chat/**`, `apps/shared/src/chat/**`
- `area: generation` — `apps/api/src/modules/generation/**`, `apps/frontend/src/features/generation/**`, `apps/frontend/src/services/generation-service.ts`, `apps/shared/src/generation/**`
- `area: gallery` — generated-image API + storage + frontend gallery
- `area: providers` — provider adapters, `apps/shared/src/catalog/**`, model catalog hook
- `area: connectors` — connector modules, secret store, `apps/shared/src/connectors/**`
- `area: settings` — app/provider/tool settings modules + frontend settings
- `area: tools` — tool registry, tool settings, `apps/shared/src/tool-settings/**`
- `area: skills` — `apps/api/src/modules/skills/**`, `apps/frontend/src/features/settings/skills/**`, `apps/shared/src/skills/**`
- `area: mcp` — `apps/api/src/services/mcp/**`, `apps/api/src/modules/mcp-servers/**`, `apps/frontend/src/features/settings/mcp/**`, `apps/shared/src/mcp/**`
- `area: i18n` — `apps/shared/src/i18n/**`
- `area: components` — `apps/frontend/src/components/**`

## `type:` (what)

- `type: ci` — `.github/{workflows,actions,labeler.yml,dependabot.yml}`
- `type: dependencies` — `package.json`, `bun.lock` (also auto-applied by Dependabot for both `bun` and `github-actions` ecosystems)
- `type: test` — `**/*.{test,spec}.{ts,tsx}`, `scripts/tests/**`, `tests/**`, `playwright.config.ts`
- `type: refactor` — manual, mirrors the `refactor` Conventional Commit type
- `type: perf` — manual, mirrors the `perf` Conventional Commit type
- `type: docs` — manual, mirrors the `docs` Conventional Commit type
- `type: security` — manual, security-sensitive changes
- `type: hardening` — manual, defensive work closing a class of bugs
- `type: chore` — manual, maintenance that fits no other type
- `type: bug`, `type: feature`, `type: migration`, `type: question` — manual / issue-template defaults

## `status:` (issues only)

Issues carry exactly one `status:` label. No glob applies these — `issue-triage.yml` seeds the
first one and maintainers move it by hand from there.

- `status: needs triage` — default on open (issue templates and the `issue-triage.yml` backstop)
- `status: needs author` — waiting on the reporter; also applied automatically when an open issue has zero or multiple `type:` labels
- `status: accepted` — triaged and agreed, not started
- `status: in progress` — actively being worked on
- `status: blocked` — accepted but waiting on something external

## Adding or moving a label

Keep new labels and glob moves in sync between `.github/labeler.yml`, `.github/dependabot.yml`,
and this page. `scripts/tests/labeler.unit.test.ts` asserts that the `area:`/`type:` label set
documented here matches the one defined in `.github/labeler.yml` (plus the manual-only labels
above), so a label added to one and not the other fails the test by name. The glob text on each
bullet and the `status:` list are **not** asserted — keep those accurate by hand.

## Related

- Required checks and aggregate gates: [`ci.md`](./ci.md)
- Contributor workflow: [`../guides/contributor-quickstart.md`](../guides/contributor-quickstart.md)
