# Contributor Quickstart

Use this guide when you want the shortest path from clone to a validated change.

## 1. Set Up

```bash
git clone <repo-url>
cd mangostudio
bun install
```

Optional local config:

```bash
mkdir -p ~/.mango
cp .mango/config.toml.example ~/.mango/config.toml
cp .mango/.env.example ~/.mango/.env
```

## 2. Run The App

```bash
bun run dev
```

Default local URLs:

- Frontend: `http://localhost:5173`
- API: `http://localhost:3001`

## 3. Know Where To Start

- Read [`../../AGENTS.md`](../../AGENTS.md) for repository rules and routing.
- Use [`../reference/agent-playbooks.md`](../reference/agent-playbooks.md) when you need a feature-by-feature file map.
- Use [`../reference/testing.md`](../reference/testing.md) before adding or changing behavior.
- Use [`../architecture/overview.md`](../architecture/overview.md) for the workspace and module layout.

## 4. Git Hooks

A [lefthook](https://github.com/evilmartians/lefthook) pre-commit hook is installed automatically during `bun install`. It runs these checks on every commit:

| Check              | Trigger      | Files targeted              | Fails commit on                    |
| ------------------ | ------------ | --------------------------- | ---------------------------------- |
| Biome format/lint  | `pre-commit` | `*.{ts,tsx,js,jsx,json}`    | Format or lint errors              |
| dprint format      | `pre-commit` | `*.{md,mdx,toml,yml,yaml}`  | Format errors                      |
| dprint Dockerfile  | `pre-commit` | `{Dockerfile,Dockerfile.*}` | Format errors                      |
| Typecheck affected | `pre-commit` | All staged files            | Type errors in affected workspaces |

Formatted files are re-staged automatically. The typecheck step is skipped during merge or rebase.

## 5. Common Commands

```bash
bun run check
bun run test
bun run verify   # full local CI gate: check → test --coverage → build --all
bun run build
```

Targeted lanes:

```bash
bun run test --unit
bun run test --integration
bun run test:e2e:setup  # install Chromium before the first e2e run
bun run test --e2e
bun run check --staged    # only workspaces touched by staged files
bun run fix --staged      # auto-fix only affected workspaces
```

## 6. Daily Workflow

1. Start from the nearest route, component, hook, service, or contract.
2. Trace one layer outward instead of reading the whole repo.
3. Keep changes scoped to one concern.
4. Run `bun run check` after each change set.
5. Before handoff or PR, run `bun run verify` (or `bun run check && bun run test` for a lighter pass).

## 7. Related Docs

- [`../../.github/CONTRIBUTING.md`](../../.github/CONTRIBUTING.md) for contribution policy and commit rules
- [`../reference/api.md`](../reference/api.md) for endpoint mapping
- [`../operations/deployment.md`](../operations/deployment.md) for standalone builds
