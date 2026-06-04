# Architecture Overview

MangoStudio follows a modular DDD-inspired architecture across three workspaces. This document explains the design decisions, layer responsibilities, and data flow.

## Workspace Map

| Workspace       | Role                         | Stack                                                    |
| --------------- | ---------------------------- | -------------------------------------------------------- |
| `apps/api`      | Backend API server           | Elysia, Better Auth, Kysely + SQLite                     |
| `apps/frontend` | Browser SPA                  | React 19, Vite 8, TanStack Router/Query, Tailwind CSS v4 |
| `apps/shared`   | Framework-agnostic contracts | TypeScript types, TypeBox schemas, i18n dictionaries     |

## API Module Architecture

The API is organized into domain modules under `apps/api/src/modules/`. Each module follows a DDD-inspired structure:

```
modules/<domain>/
  application/     → Use-case services (orchestration logic)
  domain/          → Domain rules and entities (optional — omitted for simple modules)
  http/            → Elysia route definitions
  infrastructure/  → Repository/persistence implementations
```

### Layer Responsibilities

**`application/`** — Orchestration services that implement business use cases. They coordinate between repositories, services, and domain logic. Examples:

- `stream-text-turn.ts` — the main generation loop orchestrating providers, tools, and continuation.
- `create-chat.ts` — creates a new chat with ownership validation.
- `prompt-composer.ts` — assembles system prompts with rule composition.

**`domain/`** — Pure functions and types describing domain invariants. Present only when business rules need isolation from infrastructure. Examples:

- `chat-ownership.ts` — ownership assertion rules.
- `connector.ts` — connector entity validation.

**`http/`** — Elysia route plugins that handle HTTP concerns (request parsing, auth guards, response serialization). They delegate to application services.

**`infrastructure/`** — Kysely-based repository implementations that abstract SQL queries behind typed interfaces. One repository per aggregate root.

### Modules

| Module              | Layers  | Responsibilities                                                |
| ------------------- | ------- | --------------------------------------------------------------- |
| `chats`             | A/D/H/I | Chat CRUD, ownership, context compaction                        |
| `messages`          | A/D/H/I | Message persistence, gallery queries                            |
| `generation`        | A/D/H/I | Streaming text turns, image generation, model resolution        |
| `connectors`        | A/D/H/I | API key management, model enable/disable, secret persistence    |
| `app-settings`      | A/H/I   | Global user settings (theme, language, generation defaults)     |
| `provider-settings` | A/H/I   | Per-provider runtime configuration (caching, reasoning, tokens) |
| `tool-settings`     | A/H/I   | Per-tool enable/disable and parameter overrides                 |
| `prompt-rules`      | A/H     | System prompt composition, rule file resolution                 |
| `attachments`       | A/I     | File upload, validation, storage, provider delivery             |

A = Application, D = Domain, H = HTTP, I = Infrastructure

### When to Skip Layers

Simple modules skip layers that would add ceremony without value:

- **No `domain/`** — when business rules are self-evident (e.g., app-settings is a simple CRUD wrapper with normalization).
- **No `http/`** — when the module is purely infrastructural (e.g., `generated-images/` only has a repository).
- **No `application/`** — never; all modules have at least one service.

## Data Flow

### Typical API Request

```
Browser (Eden Treaty)
  │
  ▼
Elysia Route (http/)
  ├─ requireAuth middleware
  ├─ TypeBox body validation
  │
  ▼
Application Service (application/)
  ├─ Ownership check (domain/)
  ├─ Business logic
  ├─ Repository calls (infrastructure/)
  │
  ▼
Response (typed via shared contracts)
```

### Streaming Request (Chat)

```
Browser (fetch + ReadableStream)
  │
  ▼
respond-stream-routes.ts
  ├─ Pre-flight validation (ownership, content, model)
  │
  ▼
stream-text-turn.ts (orchestrator)
  ├─ Resolve model + provider
  ├─ Compose prompt rules
  ├─ Decide continuation strategy
  ├─ Call provider.generateAgentTurnStream()
  ├─ Execute tools (if model calls them)
  ├─ Enforce subagent delegation response contract (delegate_to_agent)
  ├─ Feed tool results back to provider
  └─ Persist turn → yield SSE events
```

### Subagent Delegation Enforcement

Subagent delegation is executed through the `delegate_to_agent` tool. The orchestrator enforces a response contract so the parent agent always receives a usable final result, even when a provider ends a subagent run after tool calls without emitting assistant text.

- **Response contract**: the delegation tool result must be a non-empty `SubagentRunResult` with a non-empty `summary`, `trace.lastMessage`, and at least one assistant message in `trace.messages`.
- **Tool-only runs**: if a subagent executes tools but produces no assistant text, the runtime synthesizes a summary (including the tool names executed) and emits a `subagent_text` event for UI consistency.
- **Main-agent verification**: the orchestrator validates that the delegation result satisfies the response contract; if it is missing or invalid, it retries up to 3 times with exponential backoff and stricter output requirements, then falls back to a standardized failure result.
- **Response persistence**: subagent text deltas and final results are stored in an in-memory cache keyed by tool call id so the orchestrator can recover a usable result if the final payload is missing or invalid.
- **Debug logging**: structured lifecycle logs are emitted with `[subagent]` and delegation enforcement logs with `[subagent-delegation]`, including call ids, tool counts, and summary lengths (without logging tool result contents).

## Cross-Cutting Concerns

### Auth

Better Auth handles sessions via cookie-based authentication. The `auth-middleware.ts` plugin decorates routes with `requireAuth`, which validates the session and injects the user context.

### Error Handling

- API errors use `ApiErrorResponse` from `@mangostudio/shared/contracts`: `{ error: string, code?: string, details?: Record<string, string> }`. The HTTP status is carried by the response, not the body.
- Streaming errors use `SSEErrorEvent` from `@mangostudio/shared/streaming`: `{ type: 'error', error, done: true }`.
- Domain errors extend `Error` with typed codes (e.g., `ChatNotFoundError`, `ToolParameterError`).
- The centralized `error-handler.ts` plugin maps thrown errors to HTTP responses.

### Rate Limiting

In-memory rate limiter (`rate-limit.ts`) that counts requests per (bucket, client IP). A `classify` function (`rate-limit-policy.ts`) sorts each request path into a named bucket — `health` and `auth` get their own, more generous buckets so they are never gated by the general API limit, while everything else shares the baseline `general` bucket. Limited requests return a `429` `ApiErrorResponse` (`code: RATE_LIMITED`) with a `Retry-After` header. Lazy cleanup of expired counters. Can be trusted-proxy-aware for deployment behind reverse proxies.

### Validation

- Request bodies validated via TypeBox schemas in shared contracts.
- Response shapes validated in integration tests via `Value.Check`.
- Attachment uploads validated for MIME type, magic bytes, size, and UTF-8 correctness.

## Provider Architecture

Providers implement the `AIProvider` interface. The provider registry maps provider types to implementations. Key abstraction layers:

```
stream-text-turn.ts (orchestrator)
  │
  ├─ resolve-model.ts → selects provider + model
  ├─ continuation-runtime.ts → decides strategy
  │
  ▼
Provider Implementation (e.g., gemini/interactions-stream.ts)
  ├─ generateAgentTurnStream() → yields AgentEvent[]
  ├─ continuation-envelope.ts → serializes cursor state
  │
  ▼
Provider Wire Format (Gemini / OpenAI / Anthropic / DeepSeek)
```

See [`continuation.md`](./continuation.md) for the full continuation architecture and [`../providers/development.md`](../providers/development.md) for the provider integration guide.

## Frontend Architecture

```
routes/                → TanStack Router file-based pages
  _authenticated/      → Auth-protected routes
    index.tsx           → Chat (default)
    gallery.tsx         → Image gallery
    settings.tsx        → Settings layout
    studio.tsx          → Image workspace

features/              → Domain feature modules
  chat/                → Chat UI, components, hooks, services
  gallery/             → Gallery page + queries
  generation/          → Text/image generation hooks + types
  settings/            → Settings sub-modules (app, connectors, providers, tools, prompts)
  sidebar/             → Sidebar + context ring

components/            → Shared UI components
  ui/                  → Design system primitives (Button, Input, Card, etc.)
  layout/              → Header, Layout, ModelSelector, ThinkingToggle
  MarkdownContent.tsx  → Markdown rendering with syntax highlighting
```

### Frontend Data Flow

```
TanStack Query (cache + invalidation)
  │
  ▼
Eden Treaty Client (typed API client)
  │
  ▼
Elysia API (server)
```

## Shared Package

The shared package is framework-agnostic and importable by both API and frontend:

```
shared/src/
  contracts/           → Barrel export of all contract types
  <module>/            → Per-module contracts + TypeBox schemas
  streaming/           → SSE event types + schemas
  types/               → Domain types (provider, agent-events, gallery)
  i18n/                → Portuguese/English dictionaries + type system
  test-utils/          → Shared mock factories
```

Cross-workspace imports use package names (`@mangostudio/shared`), never relative paths.

## Database

SQLite via Kysely with 18 migrations covering:

- Core tables: `chats`, `messages`, `generated_images`, `chat_attachments`
- Auth tables: Better Auth standard schema (5 tables)
- Settings tables: `user_app_settings`, `user_provider_settings`, `user_tool_settings`

Columns use `camelCase`, tables use `snake_case`. Kysely type aliases: `<Entity>Select`, `<Entity>Insert`, `<Entity>Update`.

## Standalone Build

`bun run build --binary` compiles the API into platform-specific binaries via `bun build --compile`. Frontend assets are embedded as sidecar files. Supports 8 platforms (linux/windows/darwin × x64/arm64 + glibc/musl). Database defaults to `~/.mango/database.sqlite`.
