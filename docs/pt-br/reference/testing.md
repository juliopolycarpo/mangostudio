# Estratégia De Testes

Este monorepo usa uma arquitetura de testes orientada a workspaces em `apps/*/tests`. O código de produção permanece em `src/`, e os testes são agrupados por intenção como `unit` ou `integration`.

## Estrutura De Diretórios

```text
apps/
  api/
    tests/
      unit/
      integration/
      support/
        harness/   # create-api-test-app.ts
        mocks/     # colaboradores fake

  frontend/
    tests/
      unit/
      integration/
      support/
        setup/     # vitest.setup.ts
        harness/   # render.tsx
        mocks/     # create-fetch-scenario.ts (apenas hooks em jsdom)

  shared/
    tests/
      unit/
```

`support/` é reservado para helpers que removem duplicação real dentro de um workspace. Só crie subpastas que sejam usadas imediatamente.

## Taxonomia De Testes

- `unit`: isola um hook, componente, serviço, módulo de rota ou utilitário.
- `integration`: cobre um fluxo que atravessa fronteiras de módulos dentro do mesmo workspace.
- `browser-smoke`: suíte mínima em Playwright Chromium cobrindo o fluxo end-to-end de auth.

## Runners Por Workspace

| Workspace       | Runner     | Ambiente   |
| --------------- | ---------- | ---------- |
| `apps/api`      | `bun test` | Bun native |
| `apps/frontend` | `vitest`   | jsdom      |
| `apps/shared`   | `vitest`   | node       |

## Scripts Da Raiz

```bash
bun run check               # format + lint + typecheck em todos os workspaces
bun run test                # unit + integration (e2e é opt-in)
bun run test --unit         # suítes unit da API, shared e frontend
bun run test --integration  # suítes de integração da API e frontend
bun run test --e2e          # auth smoke suite em Playwright Chromium (opt-in)
bun run test --coverage     # coleta de cobertura nos workspaces aplicáveis
bun run test --all          # todas as lanes, incluindo e2e
```

## Browser Smoke

Suíte Playwright Chromium em `tests/browser-smoke/`. Cobre o fluxo completo de auth contra uma stack real rodando com API em `:3001` e frontend em `:5173`.

```bash
bun run test --e2e
```

`playwright.config.ts` na raiz do repositório inicia ambos os servidores via `webServer` antes de rodar os testes. Em CI, força `workers: 1` e faz upload de traces e screenshots em caso de falha.

Cenários em `tests/browser-smoke/auth-flow.spec.ts`:

1. A página `/login` renderiza
2. A página `/signup` renderiza
3. Signup com email aleatório único → entra na área autenticada
4. Logout → redireciona para login
5. Login novamente com as mesmas credenciais → retorna à área autenticada

| Lane            | Runner                  | Ambiente             |
| --------------- | ----------------------- | -------------------- |
| `browser-smoke` | `playwright` (Chromium) | browser real + stack |

## Scripts Por Workspace

### API

```bash
bun run --filter @mangostudio/api test:unit
bun run --filter @mangostudio/api test:integration
```

O suporte da API vive em `apps/api/tests/support/`:

- `harness/create-api-test-app.ts` — envolve plugins de rota em uma app Elysia mínima para testes via `app.handle()`
- `mocks/` — colaboradores fake, como secret stores

### Frontend

```bash
bun run --filter @mangostudio/frontend test:unit
bun run --filter @mangostudio/frontend test:integration
bun run --filter @mangostudio/frontend test:coverage
```

O suporte do frontend vive em `apps/frontend/tests/support/`:

- `setup/vitest.setup.ts` — bootstrap de runtime apenas
- `harness/render.tsx` — superfície mínima de render com providers
- `mocks/create-fetch-scenario.ts` — registry de fetch por método/path **apenas para testes de hooks React**

### Shared

```bash
bun run --filter @mangostudio/shared test:unit
```

`shared` mantém utilitários de teste de runtime em `src/test-utils/`, mas os testes do workspace vivem em `apps/shared/tests/unit/`.

## Escrevendo Testes

### Integração da API — com validação de schema Typebox

```typescript
import { describe, expect, it } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { Type } from '@sinclair/typebox';
import { settingsRoutes } from '../../../src/routes/settings';
import { createApiTestApp } from '../../support/harness/create-api-test-app';

// O plugin de rota usa .group('/settings', ...) — sem prefixo /api nos testes
const app = createApiTestApp(settingsRoutes);

const ResponseSchema = Type.Object({
  configured: Type.Boolean(),
  status: Type.Union([Type.Literal('idle'), Type.Literal('ready'), Type.Literal('error')]),
  allModels: Type.Array(Type.Any()),
});

describe('settingsRoutes', () => {
  it('validates response shape with Typebox', async () => {
    const response = await app.handle(new Request('http://localhost/settings/models/gemini'));
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(Value.Check(ResponseSchema, payload)).toBe(true);
  });
});
```

> **Importante**: plugins de rota usam `.group('/path', ...)` sem o prefixo `/api`. Esse prefixo é adicionado em `app.ts` por `new Elysia({ prefix: '/api' })`. URLs de teste devem usar apenas o group path do plugin.

### Exemplo Unitário Da API

```typescript
import { describe, expect, it } from 'bun:test';
import { createGeminiSecretService } from '../../../src/services/gemini-secret';
import { InMemorySecretStore } from '../../support/mocks/mock-secret-store';

describe('createGeminiSecretService', () => {
  it('returns environment fallback when no stored key exists', async () => {
    const service = createGeminiSecretService({
      secretStore: new InMemorySecretStore(),
      getEnvironmentKey: () => 'env-key-5678',
    });

    const status = await service.getGeminiSecretStatus();
    expect(status.source).toBe('environment');
  });
});
```

### Integração No Frontend — testes de hooks React com fetch mock

`create-fetch-scenario.ts` é limitado a **testes de hooks React** em jsdom. Não use isso para testes de contrato da API.

```tsx
import { render, screen } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

const fetchScenario = createFetchScenario();

fetchScenario.install().respondWithJson('GET', '/api/settings/secrets/gemini', {
  body: { configured: false, source: 'none' },
});

render(<SettingsPage {...props} />);
await screen.findByText('Not Configured');

fetchScenario.restore();
```

## Regras De Suporte

- Não adicione subpastas `support` vazias por simetria.
- Mantenha helpers locais ao arquivo de teste, a menos que removam duplicação real entre múltiplos arquivos.
- Prefira um harness explícito em vez de múltiplas camadas de abstração.
- Mantenha mocks focados em seams reais de request ou dependência.
- Para validação de contratos da API, use `Value.Check` com schema TypeBox inline.

## Testes De Módulo (API)

Módulos de domínio da API colocam testes no diretório de workspace `tests/`:

```
apps/api/tests/
  unit/modules/<module-name>/         # testes unitários para serviços de aplicação
  integration/modules/<module-name>/  # testes de integração usando createApiTestApp
```

Testes de integração de módulo usam `createApiTestApp` com o plugin HTTP do módulo. URLs de teste devem usar o group path do plugin, sem o prefixo `/api`.

## Matriz De Testes De Continuação / Provedores

Consulte `../architecture/continuation.md` e `../providers/development.md` para a arquitetura e o guia de desenvolvimento. A matriz cobre três camadas:

### Motor de decisão (`continuation.test.ts`)

Testes de função pura em `apps/api/tests/unit/services/providers/continuation.test.ts`:

| Teste                          | O que valida                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| Parse/serialização do envelope | Identidade de round-trip, null/undefined/inválido, versão do schema e requisitos de cursor |
| Validação do envelope          | Detecção de mismatch entre provedor, modelo, system prompt e toolset                       |
| `decideContinuation`           | Decisões `continue_with_cursor`, `degrade_to_replay` e `start_replay`                      |
| `decideTurnPersistence`        | Persistência de cursor durável e filtro de `stateless-loop`                                |
| Troca de provedor              | OpenAI→Gemini degrada no primeiro turno e usa cursor Gemini no segundo                     |

### Replay builders (`replay-builder.test.ts`)

Testes em `apps/api/tests/unit/services/providers/replay-builder.test.ts`:

- formato de replay de cada provedor
- conteúdo apenas de texto, apenas tool call ou misto
- histórico vazio e compatibilidade retroativa com texto simples

### Tratamento específico de perda de cursor

Cada teste de stream por provedor deve cobrir:

- primeiro turno sem cursor → replay completo
- continuação por cursor → input mínimo
- perda de cursor sem tool results → retry com replay
- perda de cursor com tool results → abort com `tool_result_cursor_loss`

---

## Cobertura

A cobertura do frontend é escrita em `apps/frontend/coverage/`:

```bash
bun run --filter @mangostudio/frontend test:coverage
```

## Checklist De Verificação

Antes de fazer merge, rode:

```bash
bun run check
bun run test
# ou use o atalho do gate completo de CI:
bun run verify
```
