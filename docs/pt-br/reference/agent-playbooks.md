# Playbooks De Agentes

Abra apenas a seção que corresponda à tarefa atual. Este arquivo é intencionalmente mais detalhado que `AGENTS.md` e deve ser usado sob demanda, não por padrão.

Esta página é um auxílio de navegação para contribuidores e agentes de código. Comece pelo ponto de entrada mais próximo da tarefa e expanda uma camada por vez.

## Auth

Abra estes arquivos primeiro:

- `apps/api/src/auth.ts`
- `apps/api/src/routes/auth.ts`
- `apps/api/src/plugins/auth-middleware.ts`
- `apps/frontend/src/lib/auth-client.ts`
- `apps/frontend/src/routes/login.tsx`
- `apps/frontend/src/routes/signup.tsx`
- `tests/browser-smoke/auth-flow.spec.ts`

## Rotas De API E Contratos

Abra estes arquivos primeiro:

- `apps/api/src/app.ts`
- o arquivo-alvo em `apps/api/src/modules/*/http/`
- `apps/shared/src/contracts/index.ts`
- o hook, serviço ou rota correspondente no frontend
- os testes relevantes da API e do frontend

## Chat, Streaming E Geração

Leia primeiro `../architecture/continuation.md` e `../providers/development.md` para contexto sobre a arquitetura de continuação e os padrões de integração de provedores.

Abra estes arquivos primeiro:

- `apps/api/src/modules/generation/http/respond-stream-routes.ts`
- `apps/api/src/modules/generation/application/stream-text-turn.ts`
- `apps/api/src/modules/generation/application/resolve-model.ts`
- `apps/api/src/modules/chats/`
- `apps/api/src/modules/messages/`
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
- `apps/api/src/modules/generation/http/respond-routes.ts`
- `apps/api/src/modules/chats/http/chat-routes.ts`
- `apps/api/src/modules/messages/http/message-routes.ts`
- `apps/shared/src/streaming/events.ts`
- `apps/shared/src/streaming/schemas.ts`
- `apps/frontend/src/features/chat/ChatPage.tsx`
- `apps/frontend/src/features/generation/hooks/use-text-generation.ts`
- `apps/frontend/src/features/chat/hooks/use-chat-stream.ts`
- `apps/frontend/src/services/generation-service.ts`
- `apps/shared/src/contracts/index.ts`

## Connectors, Provedores E Secret Storage

Abra estes arquivos primeiro:

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

## Tool Calling E Fluxos Agentic

Abra estes arquivos primeiro:

- `apps/api/src/services/tools/registry.ts` (registro + lookup)
- `apps/api/src/services/tools/`
- `apps/api/src/services/tools/builtin/generate-image.ts`
- `apps/api/src/services/tools/builtin/get-current-datetime.ts`
- `apps/api/src/modules/tool-settings/http/tool-settings-routes.ts`
- `apps/api/src/modules/generation/application/stream-text-turn.ts`
- `apps/api/src/services/providers/core/continuation-envelope.ts`
- `apps/api/src/services/providers/core/tool-mapper.ts`
- `apps/shared/src/types/index.ts`
- `apps/frontend/src/features/generation/hooks/use-text-generation.ts`
- `apps/frontend/src/features/chat/components/ToolCallVisuals.tsx` (renderização por tool call)
- `apps/frontend/src/features/settings/tools/`

## Attachments

Abra estes arquivos primeiro:

- `apps/api/src/modules/attachments/application/attachment-storage.ts`
- `apps/api/src/modules/attachments/application/attachment-validation.ts`
- `apps/api/src/modules/attachments/application/runtime-attachment-resolver.ts`
- `apps/api/src/modules/attachments/infrastructure/attachment-repository.ts`
- `apps/api/src/services/providers/core/attachment-content.ts`
- `apps/frontend/src/features/chat/components/MessageParts.tsx`

## Workdir, Git E Contexto Do GitHub

Abra estes arquivos primeiro:

- `apps/api/src/modules/workspaces/`
- `apps/api/src/modules/git/`
- `apps/api/src/modules/github/`
- `apps/shared/src/workspaces/`
- `apps/shared/src/git/`
- `apps/shared/src/github/`
- `apps/frontend/src/features/workspace/`

## Prompt Rules

Abra estes arquivos primeiro:

- `apps/api/src/modules/prompt-rules/application/prompt-composer.ts`
- `apps/api/src/modules/prompt-rules/application/rule-file-resolver.ts`
- `apps/api/src/modules/prompt-rules/http/rule-file-routes.ts`
- `apps/frontend/src/features/settings/prompts/`

## Settings (App, Provider, Tool)

Abra estes arquivos primeiro:

- `apps/api/src/modules/app-settings/http/app-settings-routes.ts`
- `apps/api/src/modules/app-settings/infrastructure/app-settings-repository.ts`
- `apps/api/src/modules/provider-settings/http/provider-settings-routes.ts`
- `apps/api/src/modules/tool-settings/http/tool-settings-routes.ts`
- `apps/api/src/services/tools/settings-policy.ts`
- `apps/frontend/src/features/settings/app/`
- `apps/frontend/src/features/settings/providers/`
- `apps/frontend/src/features/settings/tools/`

## Geração De Imagem

Abra estes arquivos primeiro:

- `apps/api/src/modules/generation/application/generate-image.ts`
- `apps/api/src/services/generated-images/generated-image-storage.ts`
- `apps/api/src/modules/generated-images/infrastructure/generated-image-repository.ts`
- `apps/api/src/services/providers/gemini/image-generation.ts`
- `apps/api/src/services/providers/openai/image-generation.ts`
- `apps/frontend/src/features/gallery/GalleryPage.tsx`
- `apps/frontend/src/features/generation/hooks/use-image-generation.ts`

## Persistência E Banco De Dados

Abra estes arquivos primeiro:

- `apps/api/src/db/database.ts`
- `apps/api/src/db/types.ts`
- `apps/api/src/db/row-types.ts`
- `apps/api/src/db/serializers.ts`
- `apps/api/src/db/migrations/`
- o serviço ou rota dono da funcionalidade

## UX, Roteamento E Estado No Frontend

Abra estes arquivos primeiro:

- `apps/frontend/src/routes/`
- `apps/frontend/src/features/`
- `apps/frontend/src/components/`
- `apps/frontend/src/components/ui/`
- `apps/frontend/src/hooks/`
- `apps/frontend/src/services/`
- `apps/frontend/src/index.css`

## Contratos Compartilhados, Tipos E i18n

Abra estes arquivos primeiro:

- `apps/shared/src/contracts/index.ts`
- `apps/shared/src/errors/contracts.ts`
- `apps/shared/src/types/index.ts`
- `apps/shared/src/i18n/pt-BR.ts`
- `apps/shared/src/i18n/en.ts`
- `apps/shared/src/i18n/types.ts`
- os consumidores afetados na API e no frontend

## Configuração, Runtime E Build Standalone

Abra estes arquivos primeiro:

- `apps/api/src/lib/config.ts`
- `apps/api/src/lib/runtime-paths.ts`
- `apps/api/src/index.ts`
- `.mango/config.toml.example`
- `.mango/.env.example`
- `scripts/build.ts`
- `scripts/test-build.ts` (binary smoke)

## CLI E Ciclo De Vida Do Servidor

Cobre `serve`, `status`, `stop`, `killserver` e `doctor`.

Abra estes arquivos primeiro:

- `apps/api/src/index.ts` (entrada da CLI)
- `apps/api/src/cli/` (parsing de argumentos, dispatch, comandos, checagens do doctor)
- `apps/api/src/server/start-server.ts`
- `apps/api/src/lib/server-state.ts` (estado de PID e porta)
- `apps/api/src/lib/mango-paths.ts`
- Referência: `cli.md`

## Changelog E Release

Abra estes arquivos primeiro:

- `cliff.toml` (configuração do git-cliff; `CHANGELOG.md` é gerado, nunca editado à mão)
- `scripts/changelog.ts`
- `scripts/lib/changelog.ts`
- `scripts/lib/release-version.ts`
- `scripts/lib/prepare-release.ts`
- `scripts/release/prepare-release.ts`
- `scripts/release/pack-npm.ts`
- `scripts/check-versions.ts`
- `packages/cli/`
- `packages/cargo-shim/`
- `.github/workflows/pr-qa-report.yml`, `.github/workflows/release.yml`, `.github/workflows/cargo-shim.yml`
- Referência: `releasing.md`
