# Agent Playbooks

Open only the section that matches the current task. This file is intentionally more detailed than `AGENTS.md` and should be used on demand, not by default.

## Auth

Open these first:

- `apps/api/src/auth.ts`
- `apps/api/src/routes/auth.ts`
- `apps/api/src/plugins/auth-middleware.ts`
- `apps/frontend/src/lib/auth-client.ts`
- `apps/frontend/src/routes/login.tsx`
- `apps/frontend/src/routes/signup.tsx`
- `tests/browser-smoke/auth-flow.spec.ts`

## API Routes And Contracts

Open these first:

- `apps/api/src/app.ts`
- the target file under `apps/api/src/routes/`
- `apps/shared/src/contracts/index.ts`
- the matching frontend hook, service, or route
- the relevant API and frontend tests

## Chat, Streaming, And Generation

Open these first:

- `apps/api/src/routes/respond.ts`
- `apps/api/src/routes/respond-stream.ts`
- `apps/api/src/routes/chats.ts`
- `apps/api/src/routes/messages.ts`
- `apps/api/src/routes/upload.ts`
- `apps/api/src/services/chat-service.ts`
- `apps/api/src/services/message-service.ts`
- `apps/frontend/src/features/chat/ChatPage.tsx`
- `apps/frontend/src/hooks/use-text-chat.ts`
- `apps/frontend/src/hooks/use-image-generation.ts`
- `apps/frontend/src/services/generation-service.ts`
- `apps/shared/src/contracts/index.ts`

## Connectors, Providers, And Secret Storage

Open these first:

- `apps/api/src/routes/settings/connectors.ts`
- `apps/api/src/routes/settings/models.ts`
- `apps/api/src/routes/settings/gemini-aliases.ts`
- `apps/api/src/services/providers/`
- `apps/api/src/services/secret-store/`
- `apps/api/src/services/gemini/`
- `apps/api/src/lib/config.ts`
- `apps/frontend/src/components/settings/ConnectorsSettings.tsx`
- `apps/frontend/src/hooks/use-model-catalog.ts`

## Tool Calling And Agentic Flows

Open these first:

- `apps/api/src/services/tools/`
- `apps/api/src/routes/respond-stream.ts`
- `apps/shared/src/types/index.ts`
- `apps/frontend/src/hooks/use-text-chat.ts`

## Persistence And Database

Open these first:

- `apps/api/src/db/database.ts`
- `apps/api/src/db/types.ts`
- `apps/api/src/db/row-types.ts`
- `apps/api/src/db/serializers.ts`
- `apps/api/src/db/migrations/`
- the owning service or route

## Frontend UX, Routing, And State

Open these first:

- `apps/frontend/src/routes/`
- `apps/frontend/src/features/`
- `apps/frontend/src/components/`
- `apps/frontend/src/components/ui/`
- `apps/frontend/src/hooks/`
- `apps/frontend/src/services/`
- `apps/frontend/src/index.css`

## Shared Contracts, Types, And i18n

Open these first:

- `apps/shared/src/contracts/index.ts`
- `apps/shared/src/contracts/errors.ts`
- `apps/shared/src/types/index.ts`
- `apps/shared/src/i18n/pt-BR.ts`
- `apps/shared/src/i18n/en.ts`
- `apps/shared/src/i18n/types.ts`
- the affected API and frontend consumers

## Config, Runtime, And Standalone Build

Open these first:

- `apps/api/src/lib/config.ts`
- `apps/api/src/index.ts`
- `.mango/config.toml.example`
- `.mango/.env.example`
- `scripts/build.ts`
