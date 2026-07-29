# Visão Geral Da Arquitetura

O MangoStudio segue uma arquitetura modular inspirada em DDD distribuída em três workspaces. Este documento explica as decisões de design, as responsabilidades de cada camada e o fluxo de dados.

## Mapa Dos Workspaces

| Workspace       | Papel                            | Stack                                                    |
| --------------- | -------------------------------- | -------------------------------------------------------- |
| `apps/api`      | Servidor de API backend          | Elysia, Better Auth, Kysely + SQLite                     |
| `apps/frontend` | SPA do navegador                 | React 19, Vite 8, TanStack Router/Query, Tailwind CSS v4 |
| `apps/shared`   | Contratos agnósticos a framework | Tipos TypeScript, schemas TypeBox, dicionários i18n      |

## Arquitetura Dos Módulos Da API

A API é organizada em módulos de domínio dentro de `apps/api/src/modules/`. Cada módulo segue uma estrutura inspirada em DDD:

```
modules/<domain>/
  application/     → Serviços de caso de uso (lógica de orquestração)
  domain/          → Regras e entidades de domínio (opcional, omitido em módulos simples)
  http/            → Definições de rotas Elysia
  infrastructure/  → Implementações de repositório/persistência
```

### Responsabilidades Das Camadas

**`application/`** — Serviços de orquestração que implementam casos de uso de negócio. Coordenam repositórios, serviços e lógica de domínio. Exemplos:

- `stream-text-turn.ts` — o loop principal de geração que orquestra provedores, tools e continuação.
- `create-chat.ts` — cria um novo chat com validação de ownership.
- `prompt-composer.ts` — monta prompts de sistema com composição de regras.

**`domain/`** — Funções puras e tipos que descrevem invariantes do domínio. Só existe quando as regras de negócio precisam de isolamento em relação à infraestrutura. Exemplos:

- `chat-ownership.ts` — regras de validação de ownership.
- `connector.ts` — validação da entidade connector.

**`http/`** — Plugins de rota Elysia que tratam preocupações HTTP, como parsing de request, guards de autenticação e serialização de resposta. Eles delegam para serviços de aplicação.

**`infrastructure/`** — Implementações de repositório com Kysely que abstraem queries SQL atrás de interfaces tipadas. Um repositório por aggregate root.

### Módulos

| Módulo              | Camadas | Responsabilidades                                                                  |
| ------------------- | ------- | ---------------------------------------------------------------------------------- |
| `chats`             | A/D/H/I | CRUD de chats, ownership, compactação de contexto                                  |
| `messages`          | A/D/H/I | Persistência de mensagens, consultas da galeria                                    |
| `generation`        | A/D/H/I | Streaming de turnos de texto, geração de imagem, resolução de modelo               |
| `connectors`        | A/D/H/I | Gerenciamento de chaves de API, enable/disable de modelos, persistência de secrets |
| `app-settings`      | A/H/I   | Configurações globais do usuário (tema, idioma, defaults de geração)               |
| `provider-settings` | A/H/I   | Configuração de runtime por provedor (cache, reasoning, tokens)                    |
| `tool-settings`     | A/H/I   | Enable/disable de tools e overrides de parâmetros                                  |
| `prompt-rules`      | A/H     | Composição de prompts de sistema e resolução de arquivos de regra                  |
| `attachments`       | A/I     | Upload de arquivos, validação, storage e entrega ao provedor                       |

A = Application, D = Domain, H = HTTP, I = Infrastructure

### Quando Pular Camadas

Módulos simples pulam camadas que só adicionariam cerimônia sem gerar valor:

- **Sem `domain/`** — quando as regras de negócio são autoevidentes (por exemplo, `app-settings` é um wrapper CRUD simples com normalização).
- **Sem `http/`** — quando o módulo é puramente infraestrutural (por exemplo, `generated-images/` só possui repositório).
- **Sem `application/`** — nunca; todos os módulos têm pelo menos um serviço.

## Fluxo De Dados

### Request Típico Da API

```
Browser (Eden Treaty)
  │
  ▼
Elysia Route (http/)
  ├─ middleware requireAuth
  ├─ validação do body com TypeBox
  │
  ▼
Application Service (application/)
  ├─ verificação de ownership (domain/)
  ├─ lógica de negócio
  ├─ chamadas a repositórios (infrastructure/)
  │
  ▼
Resposta (tipada via shared contracts)
```

### Request De Streaming (Chat)

```
Browser (fetch + ReadableStream)
  │
  ▼
respond-stream-routes.ts
  ├─ validação prévia (ownership, conteúdo, modelo)
  │
  ▼
stream-text-turn.ts (orquestrador)
  ├─ resolve modelo + provedor
  ├─ compõe prompt rules
  ├─ decide estratégia de continuação
  ├─ chama provider.generateAgentTurnStream()
  ├─ executa tools (se o modelo chamá-las)
  ├─ envia resultados das tools de volta ao provedor
  └─ persiste o turno → produz eventos SSE
```

## Preocupações Transversais

### Auth

O Better Auth gerencia sessões via autenticação baseada em cookies. O plugin
`auth-middleware.ts` decora rotas com `requireAuth`, que valida a sessão e injeta
o contexto do usuário. Automação externa usa chaves de API com escopo: o cliente
envia `x-api-key`, `apiKeyGuard` aplica o toggle por usuário e o escopo, e o
Better Auth resolve a chave no mesmo caminho de sessão para `requireAuth`
continuar igual. Veja [`reference/external-api.md`](./../reference/external-api.md).

### Tratamento De Erros

- Erros de API usam `ApiErrorResponse` de `@mangostudio/shared/contracts`: `{ error: string, code?: string, details?: Record<string, string> }`. O HTTP status é carregado pela resposta, não pelo body.
- Erros de streaming usam `SSEErrorEvent` de `@mangostudio/shared/streaming`: `{ type: 'error', error, done: true }`.
- Erros de domínio estendem `Error` com códigos tipados, como `ChatNotFoundError` e `ToolParameterError`.
- O plugin centralizado `error-handler.ts` mapeia exceções lançadas para respostas HTTP.

### Rate Limiting

Há um rate limiter em memória (`rate-limit.ts`) que conta requests por (bucket,
id do cliente). A função `classify` (`rate-limit-policy.ts`) classifica cada
request em um bucket — `health`, `auth`, `general` (sessão no navegador) e
`api-key` (requests com `x-api-key`) usam contadores independentes para
automação não afetar sessões no mesmo IP. O id do cliente é o IP em todos os
buckets hoje (ids por chave exigem o id verificado após `apiKeyGuard`; ver
issue #737). Requests bloqueados retornam `429` como `ApiErrorResponse`
(`code: RATE_LIMITED`) com header `Retry-After`. Os contadores expirados são
limpos sob demanda. Headers de proxy só afetam o id do cliente quando
`trustProxy` está habilitado explicitamente atrás de um proxy confiável.

### Validação

- Bodies de request são validados via schemas TypeBox nos contratos compartilhados.
- Shapes de resposta são validados em testes de integração com `Value.Check`.
- Uploads de attachment são validados por MIME type, magic bytes, tamanho e correção de UTF-8.

## Arquitetura De Provedores

Os provedores implementam a interface `AIProvider`. O provider registry mapeia tipos de provedor para implementações. Camadas principais de abstração:

```
stream-text-turn.ts (orquestrador)
  │
  ├─ resolve-model.ts → seleciona provedor + modelo
  ├─ continuation-runtime.ts → decide estratégia
  │
  ▼
Implementação do provedor (ex.: gemini/interactions-stream.ts)
  ├─ generateAgentTurnStream() → produz AgentEvent[]
  ├─ continuation-envelope.ts → serializa estado do cursor
  │
  ▼
Formato de wire do provedor (Gemini / OpenAI / Anthropic / DeepSeek)
```

Veja [`continuation.md`](./continuation.md) para a arquitetura completa de continuação e [`../providers/development.md`](../providers/development.md) para o guia de integração de provedores.

## Arquitetura Do Frontend

```
routes/                → páginas file-based do TanStack Router
  _authenticated/      → rotas protegidas por autenticação
    index.tsx           → Chat (padrão)
    gallery.tsx         → Galeria de imagens
    settings.tsx        → Layout de configurações
    studio.tsx          → Workspace de imagem

features/              → módulos de feature por domínio
  chat/                → UI, componentes, hooks e serviços de chat
  gallery/             → página da galeria + queries
  generation/          → hooks e tipos de geração de texto/imagem
  settings/            → submódulos de settings (app, connectors, providers, tools, prompts)
  sidebar/             → sidebar + context ring

components/            → componentes compartilhados de UI
  ui/                  → primitivas do design system (Button, Input, Card etc.)
  layout/              → Header, Layout, ModelSelector, ThinkingToggle
  MarkdownContent.tsx  → renderização de markdown com syntax highlighting
```

### Fluxo De Dados No Frontend

```
TanStack Query (cache + invalidação)
  │
  ▼
Eden Treaty Client (cliente de API tipado)
  │
  ▼
Elysia API (servidor)
```

## Pacote Shared

O pacote shared é agnóstico a framework e pode ser importado tanto pela API quanto pelo frontend:

```
shared/src/
  contracts/           → barrel export de todos os tipos de contrato
  <module>/            → contratos por módulo + schemas TypeBox
  streaming/           → tipos e schemas de eventos SSE
  types/               → tipos de domínio (provider, agent-events, gallery)
  i18n/                → dicionários em Português/Inglês + sistema de tipos
  test-utils/          → mock factories compartilhadas
```

Imports entre workspaces usam nomes de pacote (`@mangostudio/shared`), nunca caminhos relativos.

## Banco De Dados

SQLite via Kysely com 18 migrações cobrindo:

- Tabelas centrais: `chats`, `messages`, `generated_images`, `chat_attachments`
- Tabelas de auth: schema padrão do Better Auth (5 tabelas)
- Tabelas de settings: `user_app_settings`, `user_provider_settings`, `user_tool_settings`

Colunas usam `camelCase`; tabelas usam `snake_case`. Aliases tipados do Kysely seguem o padrão `<Entity>Select`, `<Entity>Insert`, `<Entity>Update`.

## Build Standalone

`bun run build --binary` compila a API em binários específicos por plataforma via `bun build --compile`. Os assets do frontend são embarcados no executável. Há suporte a 8 plataformas (linux/windows/darwin × x64/arm64 + glibc/musl). O banco de dados usa `~/.mango/database.sqlite` por padrão.
