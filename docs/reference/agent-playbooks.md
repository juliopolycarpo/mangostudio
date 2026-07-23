# Agent Playbooks

Open only the section that matches the current task. This file is intentionally more detailed than `AGENTS.md` and should be used on demand, not by default.

This page is a navigation aid for contributors and coding agents. Start from the
closest entry point to the task, then fan out one layer at a time.

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
- the target file under `apps/api/src/modules/*/http/`
- `apps/shared/src/contracts/index.ts`
- the matching frontend hook, service, or route
- the relevant API and frontend tests

## Chat, Streaming, And Generation

First read `docs/architecture/continuation.md` and `docs/providers/development.md` for
context on the continuation architecture and provider integration patterns.

Open these first:

- `apps/api/src/modules/generation/http/respond-stream-routes.ts`
- `apps/api/src/modules/generation/application/stream-text-turn.ts`
- `apps/api/src/modules/generation/application/resolve-model.ts`
- `apps/api/src/modules/chats/` (ownership, chat repository)
- `apps/api/src/modules/messages/` (message repository, persistence)
- `apps/api/src/services/providers/core/continuation-envelope.ts`
- `apps/api/src/services/providers/core/continuation-runtime.ts`
- `apps/api/src/services/providers/core/context-policy.ts`
- `apps/api/src/services/providers/core/replay-builder.ts`
- `apps/api/src/services/providers/gemini/interactions-stream.ts`
- `apps/api/src/services/providers/openai/responses-stream.ts`
- `apps/api/src/services/providers/openai-compatible/chat-completions-stream.ts`
- `apps/api/src/services/providers/anthropic/stream.ts`
- `apps/api/src/services/providers/deepseek/agent-stream.ts`
- `apps/api/src/services/providers/deepseek/client.ts`
- `apps/api/src/services/providers/chatgpt/`
- `apps/api/src/modules/generation/http/respond-routes.ts` (non-streaming fallback)
- `apps/api/src/modules/chats/http/chat-routes.ts`
- `apps/api/src/modules/messages/http/message-routes.ts`
- `apps/shared/src/streaming/events.ts`
- `apps/shared/src/streaming/schemas.ts`
- `apps/frontend/src/features/chat/ChatPage.tsx`
- `apps/frontend/src/features/generation/hooks/use-text-generation.ts`
- `apps/frontend/src/features/chat/hooks/use-chat-stream.ts`
- `apps/frontend/src/services/generation-service.ts`
- `apps/shared/src/contracts/index.ts`

## Connectors, Providers, And Secret Storage

Open these first:

- `apps/api/src/modules/connectors/http/connectors-routes.ts`
- `apps/api/src/modules/connectors/http/chatgpt-oauth-routes.ts`
- `apps/api/src/modules/connectors/http/gemini-aliases-routes.ts`
- `apps/api/src/modules/connectors/application/`
- `apps/api/src/modules/connectors/infrastructure/chatgpt/`
- `apps/api/src/services/providers/`
- `apps/api/src/services/secret-store/`
- `apps/api/src/modules/provider-settings/http/provider-settings-routes.ts`
- `apps/api/src/lib/config.ts`
- `apps/frontend/src/features/settings/connectors/`
- `apps/frontend/src/features/settings/providers/`
- `apps/frontend/src/hooks/use-model-catalog.ts`

## Tool Calling And Agentic Flows

Open these first:

- `apps/api/src/services/tools/`
- `apps/api/src/services/tools/builtin/create-file.ts`
- `apps/api/src/services/tools/builtin/edit-file.ts`
- `apps/api/src/services/tools/builtin/replace-range.ts`
- `apps/api/src/services/tools/builtin/apply-patch.ts`
- `apps/api/src/services/tools/builtin/_v4a-patch.ts`
- `apps/api/src/services/tools/builtin/delete-file.ts`
- `apps/api/src/services/tools/builtin/move-file.ts`
- `apps/api/src/services/tools/builtin/generate-image.ts`
- `apps/api/src/services/tools/builtin/get-current-datetime.ts`
- `apps/api/src/services/tools/builtin/ask-user-question.ts` (interactive question cards)
- `apps/api/src/services/tools/builtin/todo.ts` (per-chat task list; prompt-injected via `apps/api/src/modules/todos/`)
- `apps/api/src/modules/todos/http/todo-routes.ts` (`GET /api/chats/:id/todos` current-state endpoint)
- `apps/shared/src/questions/` (question schemas + answer formatting)
- `apps/shared/src/todos/` (todo schemas, helpers, prompt-section renderer)
- `apps/frontend/src/features/chat/components/QuestionCard.tsx`
- `apps/frontend/src/features/chat/components/TodoListPart.tsx` (inline feed snapshot; shares `TodoItemRow.tsx`)
- `apps/frontend/src/features/chat/components/PinnedTodoPanel.tsx` (live panel above the input bar)
- `apps/frontend/src/features/chat/hooks/use-chat-todos.ts` (todo query + `todo_update` cache writer)
- `apps/api/src/modules/tool-settings/http/tool-settings-routes.ts`
- `apps/api/src/modules/generation/application/stream-text-turn.ts`
- `apps/api/src/services/providers/core/continuation-envelope.ts`
- `apps/api/src/services/providers/core/tool-mapper.ts`
- `apps/shared/src/types/index.ts`
- `apps/frontend/src/features/generation/hooks/use-text-generation.ts`
- `apps/frontend/src/features/settings/tools/`

Per-message **file checkpoints** cover the built-in filesystem mutation tools above, including the ones a subagent (`delegate_to_agent`) or the Cursor sidecar runs — those inherit the delegating turn's `assistantMessageId`, so their mutations join the same manifest. Revert is whole-turn (`POST /api/chats/:id/checkpoints/:messageId/revert`) and compares on-disk hashes before restoring. **Not checkpointed:** shell tools and MCP file writes — only explicit builtin mutators participate.

## Skills

Open these first:

- `apps/api/src/modules/skills/application/skill-discovery.ts` (source scan, precedence, memo)
- `apps/api/src/modules/skills/application/skill-content.ts` (body + sandboxed file reads)
- `apps/api/src/modules/skills/application/skills-prompt-section.ts` (`<available-skills>`)
- `apps/api/src/modules/skills/application/skill-settings-service.ts`
- `apps/api/src/modules/skills/http/skill-routes.ts`
- `apps/api/src/services/tools/builtin/skill.ts` (lazy-load tool)
- `apps/shared/src/skills/`
- `apps/frontend/src/features/settings/skills/`
- Reference: `docs/reference/skills.md`

## MCP Servers

Open these first:

- `apps/api/src/services/mcp/client-factory.ts` (SDK boundary, transports)
- `apps/api/src/services/mcp/connection-manager.ts` (per-user sessions, reconnect)
- `apps/api/src/services/mcp/tool-bridge.ts` (namespacing + per-turn resolution)
- `apps/api/src/services/mcp/tool-naming.ts`, `content-mapping.ts`, `header-secrets.ts`
- `apps/api/src/modules/mcp-servers/http/mcp-server-routes.ts`
- `apps/shared/src/mcp/`
- `apps/frontend/src/features/settings/mcp/`
- Reference: `docs/reference/mcp.md`

## Attachments

Open these first:

- `apps/api/src/modules/attachments/application/attachment-storage.ts`
- `apps/api/src/modules/attachments/application/attachment-validation.ts`
- `apps/api/src/modules/attachments/application/runtime-attachment-resolver.ts`
- `apps/api/src/modules/attachments/infrastructure/attachment-repository.ts`
- `apps/api/src/services/providers/core/attachment-content.ts`
- `apps/frontend/src/features/chat/components/MessageParts.tsx`

## Prompt Rules

Open these first:

- `apps/api/src/modules/prompt-rules/application/prompt-composer.ts`
- `apps/api/src/modules/prompt-rules/application/rule-file-resolver.ts`
- `apps/api/src/modules/prompt-rules/http/rule-file-routes.ts`
- `apps/frontend/src/features/settings/prompts/`

## Settings (App, Provider, Tool)

Open these first:

- `apps/api/src/modules/app-settings/http/app-settings-routes.ts`
- `apps/api/src/modules/app-settings/infrastructure/app-settings-repository.ts`
- `apps/api/src/modules/provider-settings/http/provider-settings-routes.ts`
- `apps/api/src/modules/tool-settings/http/tool-settings-routes.ts`
- `apps/api/src/services/tools/settings-policy.ts`
- `apps/frontend/src/features/settings/app/`
- `apps/frontend/src/features/settings/providers/`
- `apps/frontend/src/features/settings/tools/`

## Image Generation

Open these first:

- `apps/api/src/modules/generation/application/generate-image.ts`
- `apps/api/src/services/generated-images/generated-image-storage.ts`
- `apps/api/src/modules/generated-images/infrastructure/generated-image-repository.ts`
- `apps/api/src/services/providers/gemini/image-generation.ts`
- `apps/api/src/services/providers/openai/image-generation.ts`
- `apps/frontend/src/features/gallery/GalleryPage.tsx`
- `apps/frontend/src/features/generation/hooks/use-image-generation.ts`

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
- `apps/shared/src/errors/contracts.ts`
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
- `scripts/test-build.ts` (binary smoke)
