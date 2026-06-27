<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/b9f25ec1-2619-44a6-af6a-00e8f6fb2731" />
</div>

# MangoStudio

[![CI](https://github.com/juliopolycarpo/mangostudio/actions/workflows/ci.yml/badge.svg)](https://github.com/juliopolycarpo/mangostudio/actions/workflows/ci.yml)
[![Release](https://github.com/juliopolycarpo/mangostudio/actions/workflows/release.yml/badge.svg)](https://github.com/juliopolycarpo/mangostudio/actions/workflows/release.yml)

AI-powered image generation and chat studio supporting Gemini, OpenAI-compatible, and Anthropic models.

> 🇧🇷 [Leia em Português](docs/pt-br/README.md)

## Install

Run MangoStudio without cloning the repository. Every channel ships the same
prebuilt binary (plus its `public/` frontend sidecar) and verifies downloads
against `SHA256SUMS` where applicable.

| Channel                | Command                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| npm / bun              | `npm i -g mangostudio` / `bun add -g mangostudio`                                                                        |
| Homebrew (macOS/Linux) | `brew install juliopolycarpo/tap/mangostudio`                                                                            |
| Shell installer        | `curl -fsSL https://github.com/juliopolycarpo/mangostudio/releases/latest/download/install.sh \| bash`                   |
| Scoop (Windows)        | `scoop bucket add juliopolycarpo https://github.com/juliopolycarpo/scoop-bucket` then `scoop install mangostudio`        |
| Cargo                  | `cargo install mangostudio` (or `cargo binstall mangostudio`)                                                            |
| Docker                 | `docker run -p 3001:3001 -v mango-data:/data ghcr.io/juliopolycarpo/mangostudio`                                         |
| Manual                 | Download from [GitHub Releases](https://github.com/juliopolycarpo/mangostudio/releases/latest), verify with `SHA256SUMS` |

Quick start with the shell installer:

```bash
curl -fsSL https://github.com/juliopolycarpo/mangostudio/releases/latest/download/install.sh | bash
mangostudio serve # start on http://localhost:3001
```

On Windows, download and run `install.ps1` from the
[latest release](https://github.com/juliopolycarpo/mangostudio/releases/latest),
or use Scoop (see table above). The Cargo channel installs a
[small launcher](packages/cargo-shim/README.md) that downloads the same
checksum-verified archive on first run.

`mangostudio` is a single-binary CLI that manages one local server:

```bash
mangostudio serve [host|port|host:port] # foreground (default localhost:3001)
mangostudio serve lan:3001 -d           # background (logs to ~/.mango/logs/)
mangostudio status         # show the running instance
mangostudio stop           # graceful shutdown
mangostudio doctor         # environment diagnostics
```

Run `mangostudio` with no arguments for the full command list. See
[`docs/reference/cli.md`](docs/reference/cli.md) for details.

On first run, `mangostudio serve` can generate a strong `BETTER_AUTH_SECRET` and store it in `~/.mango/.env` or `~/.mango/config.toml`.
Set provider keys such as `GEMINI_API_KEY` when you are ready to use hosted models. Optional runtime settings include `API_HOST`, `API_PORT`, and `DATABASE_PATH`.
See [`mangostudio`](packages/cli/README.md) for the full environment.
For container deployment details, see [`docs/operations/deployment.md`](docs/operations/deployment.md#docker).

## Prerequisites

- [Bun](https://bun.sh/) (v1.3.14+)
- One or more API keys for supported providers (Gemini, OpenAI-compatible, Anthropic)

## Develop from source

1. Clone the repository:

   ```bash
   git clone <repo-url>
   cd mangostudio
   ```

2. Install dependencies:

   ```bash
   bun install
   ```

3. Start the development servers:

   ```bash
   bun run dev
   ```

   This starts:
   - **API** at `http://localhost:3001` (Elysia + Kysely/SQLite)
   - **Frontend** at `http://localhost:5173` (Vite + React)

## Connector Configuration (Secrets)

MangoStudio has a flexible multi-connector system for managing multiple API keys with different persistence levels.

### Supported Persistence Methods

1. **OS Secret Store** — Native secure storage via `Bun.secrets`. Recommended for maximum security.
2. **config.toml** — Stores keys in `~/.mango/config.toml`. Ideal for sharing keys across instances or CLI tools.
3. **.env file** — Adds variables to the `~/.mango/.env` file.

### How to Configure

Go to the **Settings** page in the MangoStudio interface to add and manage connectors.

For each connector, you can enable or disable specific models (e.g., Gemini 2.5 Flash, Gemini 2.0 Flash Image). MangoStudio automatically selects the correct connector based on the active model in the chat.

### Terminal Sync

You can manually add keys to `~/.mango/config.toml`:

```toml
[gemini_api_keys]
personal = "your-key-here"
work = "another-key-here"
```

MangoStudio will sync these keys automatically the next time the Settings page is loaded or a generation is requested.

## Project Structure

```
mangostudio/
├── .mango/            # Example configuration templates only
│   └── config.toml.example
├── apps/
│   ├── api/
│   │   └── src/
│   │       ├── lib/                # Config, runtime paths, SPA guard
│   │       ├── modules/            # Domain modules (DDD-inspired)
│   │       │   ├── chats/          # application/ domain/ http/ infrastructure/
│   │       │   ├── messages/       # application/ domain/ http/ infrastructure/
│   │       │   ├── generation/     # application/ domain/ http/ infrastructure/
│   │       │   ├── connectors/     # application/ domain/ http/ infrastructure/
│   │       │   ├── app-settings/   # application/ http/ infrastructure/
│   │       │   ├── provider-settings/  # application/ http/ infrastructure/
│   │       │   ├── tool-settings/  # application/ http/ infrastructure/
│   │       │   ├── prompt-rules/   # application/ http/
│   │       │   └── attachments/    # application/ infrastructure/
│   │       ├── plugins/            # Auth guard, rate limiting, error handler
│   │       ├── services/           # AI providers, tools, secrets, generated images
│   │       │   ├── providers/      # Multi-provider implementations + core infrastructure
│   │       │   ├── tools/          # Tool registry + built-in tools
│   │       │   └── generated-images/  # Generated image file storage
│   │       └── db/                 # Kysely + SQLite + migrations
│   ├── frontend/
│   │   └── src/
│   │       ├── components/
│   │       │   └── ui/             # Design system (Button, Input, Card, Spinner, Toast, Toggle)
│   │       ├── features/           # Feature modules (chat, gallery, generation, settings, sidebar)
│   │       ├── hooks/              # React hooks (use-i18n, use-app-state, use-model-catalog…)
│   │       └── routes/             # TanStack Router pages
│   └── shared/
│       └── src/
│           ├── contracts/          # Contract barrel export
│           ├── <module>/           # Per-module contracts + schemas (auth, chat, connectors…)
│           ├── streaming/          # SSE event types + schemas
│           ├── types/              # Domain types (provider, agent-events, gallery)
│           ├── i18n/               # pt-BR / en dictionaries + types
│           └── test-utils/         # Shared mock factories
├── docs/
│   ├── README.md                   # Docs hub and reading paths
│   ├── architecture/              # System design and cross-cutting runtime flows
│   ├── features/                  # Product-area implementation docs
│   ├── providers/                 # Provider guides and provider-specific notes
│   ├── reference/                 # API, testing, and feature maps
│   ├── guides/                    # Contributor task-oriented guides
│   ├── operations/                # Deployment and security
│   └── pt-br/                     # Curated Portuguese translations
├── package.json                    # Bun workspace root
└── tsconfig.json                   # Base TypeScript configuration
```

## Main Scripts

| Command                   | Description                                                    |
| ------------------------- | -------------------------------------------------------------- |
| `bun install`             | Install all workspace dependencies                             |
| `bun run dev`             | Start all dev servers concurrently                             |
| `bun run dev --api`       | Start only the API dev server                                  |
| `bun run build`           | Build the frontend for production                              |
| `bun run build --binary`  | Generate standalone binaries with embedded frontend            |
| `bun run check`           | Run Biome, dprint, madge, and typecheck                        |
| `bun run test`            | Run unit and integration lanes                                 |
| `bun run test --unit`     | Run unit suites only                                           |
| `bun run test:e2e:setup`  | Install Playwright Chromium for browser smoke tests            |
| `bun run test --e2e`      | Run the Playwright end-to-end suite (opt-in)                   |
| `bun run test --coverage` | Run coverage collection across applicable workspaces           |
| `bun run test:scripts`    | Run cross-cutting automation tests under `scripts/`            |
| `bun run fix`             | Apply Biome and dprint fixes                                   |
| `bun run verify`          | Full local CI gate: check, test --coverage, build --all        |
| `bun run clean`           | Remove dist, local test reports, coverage, and build artifacts |

## Development Tooling

| Tool           | Scope                                         | Primary Functionality                              |
| -------------- | --------------------------------------------- | -------------------------------------------------- |
| **Biome**      | JS, TS, JSX, TSX, JSON, JSONC, CSS, HTML      | Linter and formatter with unified rule sets        |
| **dprint**     | Markdown, MDX, TOML, YAML, Dockerfile         | Pluggable formatter with WASM-based plugins        |
| **lefthook**   | Git hooks (pre-commit)                        | Git hooks manager that runs checks on staged files |
| **madge**      | JS/TS dependency graphs                       | Circular dependency detection across workspaces    |
| **jscpd**      | All source files                              | Copy/paste detection for code duplication alerts   |
| **bun:test**   | Unit tests (api, shared, frontend pure logic) | Fast native test runner with LCOV coverage         |
| **Vitest**     | Frontend React and Vite-bound tests           | jsdom, Vite plugins, coverage, and watch mode      |
| **Playwright** | End-to-end browser smoke tests                | Chromium-based browser automation for auth flows   |

These binaries are installed as devDependencies and invoked through the root `bun run` scripts. No global installation is required.

## Local Validation

### Git Hooks

A [lefthook](https://github.com/evilmartians/lefthook) pre-commit hook is installed automatically via `bun install` (through the `prepare` script). It runs the following checks in parallel on every `git commit`:

| Hook                 | Trigger      | Files targeted              | Command                                                              |
| -------------------- | ------------ | --------------------------- | -------------------------------------------------------------------- |
| `biome`              | `pre-commit` | `*.{ts,tsx,js,jsx,json}`    | `bunx biome check --write {staged_files}`                            |
| `dprint`             | `pre-commit` | `*.{md,mdx,toml,yml,yaml}`  | `bunx dprint fmt {staged_files}`                                     |
| `dprint-dockerfile`  | `pre-commit` | `{Dockerfile,Dockerfile.*}` | `bunx dprint fmt {staged_files}`                                     |
| `typecheck-affected` | `pre-commit` | All staged files            | `bun run check --staged --skip-format` (skipped during merge/rebase) |

Files that pass formatting are re-staged automatically. All hooks must succeed for the commit to proceed.

### Manual Checks

- `bun run check` — full check (Biome, dprint, typecheck, circular deps).
- `bun run check --staged` — only the workspaces touched by staged files (used by the pre-commit hook).
- `bun run check --changed` — only the workspaces changed vs `origin/main`.
- `bun run fix --staged` — auto-fix only the affected workspaces.

## Architecture

| Layer        | Technologies                                                                 |
| ------------ | ---------------------------------------------------------------------------- |
| **Frontend** | React 19, Vite 8, Tailwind CSS v4, TanStack Router/Query                     |
| **API**      | Elysia, Better Auth, native rate limiting, DDD-inspired modular architecture |
| **Database** | SQLite via Kysely (type-safe query builder)                                  |
| **AI**       | Multi-provider (Gemini, OpenAI, Anthropic, DeepSeek, OpenAI-compatible)      |
| **Runtime**  | Bun — no Node.js dependency                                                  |
| **i18n**     | Pure TypeScript dictionary in `@mangostudio/shared/i18n`                     |

## Editor Setup

Claude Code hooks auto-prepend `node_modules/.bin` to PATH on session start and directory changes (`SessionStart` / `CwdChanged`). After every write or edit, a `PostToolUse` hook runs `auto-fix.mjs` to format the touched file.

### OpenCode

OpenCode reads formatter wiring from `opencode.json`.

| Formatter    | Command                       | Extensions                                                                                       |
| ------------ | ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `biome-fix`  | `biome check --write`         | `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts`, `.json`, `.jsonc`, `.css`, `.html` |
| `dprint-fmt` | `dprint fmt --allow-no-files` | `.md`, `.mdx`, `.toml`, `.yml`, `.yaml`                                                          |

Prettier is disabled.

## Code Quality

### Biome (Lint)

Configured in `biome.json` with `recommended` rules enabled and workspace-specific overrides.

**Global rules (all files):**

| Category    | Key rules                                           |
| ----------- | --------------------------------------------------- |
| Correctness | Recommended defaults                                |
| Performance | `noDelete` (warn)                                   |
| Style       | `noNestedTernary` (off), `useBlockStatements` (off) |
| Nursery     | `useAwaitThenable` (off), `useErrorCause` (off)     |

**TypeScript/TSX overrides (`**/*.{ts,tsx}`):**

| Category    | Enforced rules                                                                                                                                                                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Complexity  | `noArguments`, `noBannedTypes`, `noUselessThisAlias`, `noUselessTypeConstraint`, `useLiteralKeys`, `useOptionalChain` — all `error`                                                                                                                                                 |
| Correctness | `noUnusedVariables` (`error`)                                                                                                                                                                                                                                                       |
| Nursery     | `noBaseToString`, `noDuplicateEnumValues`, `noFloatingPromises`, `noForIn`, `noImpliedEval`, `noMisusedPromises`, `noUnsafePlusOperands` — all `error`                                                                                                                              |
| Style       | `noCommonJs`, `noInferrableTypes`, `noNamespace`, `noNonNullAssertion`, `noUselessElse`, `useArrayLiterals`, `useAsConstAssertion`, `useConst`, `useExponentiationOperator`, `useImportType`, `useNodejsImportProtocol`, `useTemplate`, `useThrowOnlyError` — all `error`           |
| Suspicious  | `noConsole` (warn, allows `warn`/`error`), `noEmptyBlockStatements`, `noExplicitAny`, `noExtraNonNullAssertion`, `noMisleadingInstantiator`, `noNonNullAssertedOptionalChain`, `noTsIgnore`, `noUnsafeDeclarationMerging`, `noVar`, `useAwait`, `useNamespaceKeyword` — all `error` |

**Frontend-specific overrides (`apps/frontend/**/*.{ts,tsx}`):**

| Category    | Enforced rules                                                                                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correctness | `noChildrenProp` (warn), `noNestedComponentDefinitions` (error), `noRenderReturnValue` (error), `noVoidElementsWithChildren` (error), `useExhaustiveDependencies` (error), `useHookAtTopLevel` (error), `useJsxKeyInIterable` (error) |
| Nursery     | `noComponentHookFactories` (error), `noJsxNamespace` (error), `noScriptUrl` (warn), `useReactAsyncServerFunction` (error)                                                                                                             |
| Security    | `noDangerouslySetInnerHtml` (warn), `noDangerouslySetInnerHtmlWithChildren` (error)                                                                                                                                                   |
| Suspicious  | `noArrayIndexKey` (warn), `noCommentText` (error), `noReactForwardRef` (warn), `noSuspiciousSemicolonInJsx` (error)                                                                                                                   |

**Per-workspace relaxations:**

| Workspace / path                                                         | Relaxed rule                            |
| ------------------------------------------------------------------------ | --------------------------------------- |
| `apps/api/src/**`                                                        | `nursery.noUnnecessaryConditions` (off) |
| `scripts/**`                                                             | `suspicious.noConsole` (off)            |
| `apps/api/src/services/`, `utils/`, `lib/`, `db/` and `apps/shared/src/` | `nursery.useExplicitType` (off)         |

**Additional formatting and assist settings:**

- Line width: 100, indent: 2 spaces, single quotes, semicolons, trailing commas (es5)
- CSS parser enables Tailwind directives
- HTML formatter self-closes void elements
- `assist.actions.source.organizeImports` is enabled

### dprint (Format)

Configured in `dprint.json` with the following scope and settings:

| Setting            | Value                                                                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Line width         | 100                                                                                                                                                                                          |
| Indent width       | 2                                                                                                                                                                                            |
| Line endings       | LF                                                                                                                                                                                           |
| Tabs               | false                                                                                                                                                                                        |
| Markdown text wrap | `maintain`                                                                                                                                                                                   |
| Includes           | `**/*.{md,mdx,toml,yml,yaml}`, `**/Dockerfile`, `**/Dockerfile.*`                                                                                                                            |
| Excludes           | `node_modules`, `dist`, `coverage`, `build`, `test-results`, `playwright-report`, `.jscpd-out`, `.qa-gate`, `.mango/artifacts`, `.mango/out`, `routeTree.gen.ts`, `CHANGELOG.md`, `bun.lock` |
| Plugins            | markdown (WASM), toml (WASM), dockerfile (WASM), pretty_yaml                                                                                                                                 |

### Circular Dependencies

Detected via `madge` as part of `bun run check`. The check fails if any circular import paths exist across the workspace packages.

### Copy/Paste Detection

Scanned via `jscpd` during CI (qa-gate). Configuration is defined inline in `scripts/qa-gate/collect.ts`.

## Design System

The frontend ships with a built-in design system under `apps/frontend/src/components/ui/`:

- **`Button`** — variants `primary`, `secondary`, `ghost`; `loading` prop
- **`Input`** — label, error message, spread of `InputHTMLAttributes`
- **`Card`** — variants `glass` (glassmorphism) and `solid`
- **`Spinner`** — loading indicator with sizes `sm`, `md`, `lg`
- **`Toast`** — non-blocking notifications via `useToast()` hook
- **`Toggle`** — accessibility-first toggle switch

## Internationalization (i18n)

UI strings are centralized in `@mangostudio/shared/i18n`. Supports pt-BR (default) and en, with automatic detection via `navigator.language`.

```tsx
import { useI18n } from '@/hooks/use-i18n';

function MyComponent() {
  const { t } = useI18n();
  return <h1>{t.auth.loginTitle}</h1>;
}
```

The `Messages` type is inferred directly from the `pt-BR.ts` dictionary (`as const`). Adding a key without translating it in `en.ts` is a compile-time error.

## Documentation

- [`docs/README.md`](docs/README.md) — docs hub, audiences, and reading order
- [`docs/guides/contributor-quickstart.md`](docs/guides/contributor-quickstart.md) — fastest contributor onboarding path
- [`docs/architecture/continuation.md`](docs/architecture/continuation.md) — continuation architecture deep-dive
- [`docs/providers/development.md`](docs/providers/development.md) — provider integration guide
- [`docs/reference/cli.md`](docs/reference/cli.md) — CLI commands and install channels
- [`docs/reference/releasing.md`](docs/reference/releasing.md) — release runbook and distribution channels
- [`docs/reference/testing.md`](docs/reference/testing.md) — testing strategy and harness rules
- [`docs/reference/agent-playbooks.md`](docs/reference/agent-playbooks.md) — feature-by-feature file maps
- [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md) — contribution guidelines

## Standalone Build Notes

The `bun run build --binary` command compiles the API into platform-specific binaries under `.mango/out/<platform>/`.

- The database is persisted at `~/.mango/database.sqlite` by default.
- Frontend assets are served from the `public/` directory next to the executable.

## License

This project is licensed under the [MIT License](LICENSE).
