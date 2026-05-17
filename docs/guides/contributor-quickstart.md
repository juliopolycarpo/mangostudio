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
cp .mango/config.toml.example .mango/config.toml
cp .mango/.env.example .mango/.env
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

## 4. Common Commands

```bash
bun run check
bun run test
bun run build
```

Targeted lanes:

```bash
bun run test --unit
bun run test --integration
bun run test --e2e
```

## 5. Daily Workflow

1. Start from the nearest route, component, hook, service, or contract.
2. Trace one layer outward instead of reading the whole repo.
3. Keep changes scoped to one concern.
4. Run `bun run check` after each change set.
5. Before handoff or PR, run `bun run check && bun run test`.

## 6. Related Docs

- [`../../.github/CONTRIBUTING.md`](../../.github/CONTRIBUTING.md) for contribution policy and commit rules
- [`../reference/api.md`](../reference/api.md) for endpoint mapping
- [`../operations/deployment.md`](../operations/deployment.md) for standalone builds
