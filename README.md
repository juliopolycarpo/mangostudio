<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# MangoStudio

AI-powered image generation and chat studio supporting Gemini, OpenAI-compatible, and Anthropic models.

> 🇧🇷 [Leia em Português](docs/pt-br/README.md)

## Prerequisites

- [Bun](https://bun.sh/) (v1.3.11+)
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
│   │       ├── routes/        # Elysia endpoints (chats, messages, settings, auth…)
│   │       ├── services/      # Business logic (gemini, secret-store)
│   │       ├── plugins/       # Reusable middlewares (auth, rate-limit)
│   │       └── db/            # Kysely + SQLite + migrations
│   ├── frontend/
│   │   └── src/
│   │       ├── components/
│   │       │   └── ui/        # Design system (Button, Input, Card, Spinner, Toast)
│   │       ├── features/      # Feature modules (chat, gallery…)
│   │       ├── hooks/         # React hooks (use-i18n, use-app-state…)
│   │       └── routes/        # TanStack Router pages
│   └── shared/
│       └── src/
│           ├── contracts/     # Request/response DTOs
│           ├── types/         # Domain types
│           ├── i18n/          # pt-BR / en dictionaries + useI18n hook
│           └── test-utils/    # Shared mock factories
├── docs/
│   ├── pt-br/
│   │   └── README.md          # Portuguese documentation
│   └── TESTING.md             # Testing strategy and guide
├── package.json               # Bun workspace root
└── tsconfig.json              # Base TypeScript configuration
```

## Main Scripts

| Command                  | Description                                         |
|--------------------------|-----------------------------------------------------|
| `bun install`            | Install all workspace dependencies                  |
| `bun run dev`            | Start all dev servers concurrently                  |
| `bun run build`          | Build the frontend for production                   |
| `bun run build:binary`   | Generate standalone binaries with embedded frontend |
| `bun run lint`           | TypeScript type-check + ESLint                      |
| `bun run test`           | Run all unit and integration tests                  |
| `bun run test:coverage`  | Frontend coverage via Vitest/v8                     |
| `bun run migrate`        | Run SQLite database migrations                      |

## Architecture

| Layer        | Technologies                                                   |
|--------------|----------------------------------------------------------------|
| **Frontend** | React 19, Vite 8, Tailwind CSS v4, TanStack Router/Query       |
| **API**      | Elysia, Better Auth, native rate limiting                      |
| **Database** | SQLite via Kysely (type-safe query builder)                    |
| **AI**       | Multi-provider (Gemini, OpenAI-compatible, Anthropic)          |
| **Runtime**  | Bun — no Node.js dependency                                    |
| **i18n**     | Pure TypeScript dictionary in `@mangostudio/shared/i18n`       |

## Design System

The frontend ships with a built-in design system under `apps/frontend/src/components/ui/`:

- **`Button`** — variants `primary`, `secondary`, `ghost`; `loading` prop
- **`Input`** — label, error message, spread of `InputHTMLAttributes`
- **`Card`** — variants `glass` (glassmorphism) and `solid`
- **`Spinner`** — loading indicator with sizes `sm`, `md`, `lg`
- **`Toast`** — non-blocking notifications via `useToast()` hook

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

## Standalone Build Notes

The `bun run build:binary` command compiles the API into platform-specific binaries under `out/<platform>/`.
- The database is persisted at `~/.mangostudio/database.sqlite` by default.
- Frontend assets are served from the `public/` directory next to the executable.

## License

This project is licensed under the [MIT License](LICENSE).
