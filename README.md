<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/b9f25ec1-2619-44a6-af6a-00e8f6fb2731" />
</div>

# MangoStudio

AI-powered image generation and chat studio supporting Gemini, OpenAI-compatible, and Anthropic models.

> 🇧🇷 [Leia em Português](docs/pt-br/README.md)

## Prerequisites

- [Bun](https://bun.sh/) (v1.3.14+)
- One or more API keys for supported providers (Gemini, OpenAI-compatible, Anthropic)

## Installation

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
3. **.env file** — Adds variables to the `.mango/.env` file.

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
├── .mango/            # Example configuration
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

| Command                   | Description                                          |
| ------------------------- | ---------------------------------------------------- |
| `bun install`             | Install all workspace dependencies                   |
| `bun run dev`             | Start all dev servers concurrently                   |
| `bun run dev --api`       | Start only the API dev server                        |
| `bun run build`           | Build the frontend for production                    |
| `bun run build --binary`  | Generate standalone binaries with embedded frontend  |
| `bun run check`           | Run Biome, dprint, madge, and typecheck              |
| `bun run test`            | Run unit and integration lanes                       |
| `bun run test --unit`     | Run unit suites only                                 |
| `bun run test --e2e`      | Run the Playwright end-to-end suite (opt-in)         |
| `bun run test --coverage` | Run coverage collection across applicable workspaces |
| `bun run fix`             | Apply Biome and dprint fixes                         |
| `bun run verify`          | Full CI gate: check, test, build (stops on failure)  |
| `bun run clean`           | Remove dist, coverage, and build artifacts           |

## Local Validation

A [lefthook](https://github.com/evilmartians/lefthook) pre-commit hook runs Biome on staged files automatically and typechecks only the affected workspaces.

- `bun run check` — full check (Biome, dprint, typecheck, circular deps).
- `bun run check --staged` — only the workspaces touched by staged files (used by the pre-commit hook).
- `bun run check --changed` — only the workspaces changed vs `origin/main`.
- `bun run check --quick` — Biome + dprint + circular deps, skip typecheck.
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
- [`docs/reference/testing.md`](docs/reference/testing.md) — testing strategy and harness rules
- [`docs/reference/agent-playbooks.md`](docs/reference/agent-playbooks.md) — feature-by-feature file maps
- [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md) — contribution guidelines

## Standalone Build Notes

The `bun run build --binary` command compiles the API into platform-specific binaries under `.mango/out/<platform>/`.

- The database is persisted at `~/.mangostudio/database.sqlite` by default.
- Frontend assets are served from the `public/` directory next to the executable.

## License

This project is licensed under the [MIT License](LICENSE).
