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

| Workspace       | Runner                | Ambiente                                           |
| --------------- | --------------------- | -------------------------------------------------- |
| `apps/api`      | `bun test`            | Bun native                                         |
| `apps/frontend` | `bun:test` + `vitest` | Bun native para lógica pura, jsdom para React/Vite |
| `apps/shared`   | `bun:test`            | Bun native                                         |

## Scripts Da Raiz

```bash
bun run check               # format + lint + typecheck em todos os workspaces
bun run test                # unit + integration (e2e é opt-in)
bun run test --unit         # suítes unit da API, shared e frontend
bun run test --integration  # suítes de integração da API e frontend
bun run test:e2e:setup     # instala Playwright Chromium + dependências do SO
bun run test --e2e          # auth smoke suite em Playwright Chromium (opt-in)
bun run test --coverage     # coleta de cobertura nos workspaces aplicáveis
bun run test --all          # todas as lanes, incluindo e2e
bun run verify              # gate CI local completo: check → test --coverage → build --all
```

### Taxonomia de lanes

| Lane        | Nome da task       | Workspaces            | Runner              | Cache Turbo |
| ----------- | ------------------ | --------------------- | ------------------- | ----------- |
| unit        | `test:unit`        | api, frontend, shared | bun test / vitest   | sim         |
| integration | `test:integration` | api, frontend         | bun test / vitest   | não         |
| coverage    | `test:coverage`    | api, frontend, shared | bun test / vitest   | não         |
| e2e         | —                  | root (browser-smoke)  | Playwright Chromium | —           |
| scripts     | `//#test:scripts`  | root                  | bun test            | sim         |

## Browser Smoke

Suíte Playwright Chromium em `tests/browser-smoke/`. Cobre o fluxo completo de auth contra uma stack real rodando com API em `:3001` e frontend em `:5173`.

```bash
bun run test:e2e:setup
bun run test --e2e
```

Rode `bun run test:e2e:setup` uma vez em uma máquina nova ou quando o Playwright avisar que o binário do Chromium está ausente. O script encapsula `bunx playwright install --with-deps chromium`, então instala apenas o navegador usado por esta suíte e evita comandos `npx`.

O job de browser-smoke em CI roda em `ubuntu-24.04` porque o Playwright 1.60 ainda não consegue instalar dependências do Chromium no Ubuntu 26.04. Se você usa Ubuntu 26.04 localmente, rode a lane e2e em um container ou VM Ubuntu 24.04/22.04 até o suporte upstream chegar.

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

## Binary Smoke

`scripts/test-build.ts` compila o binário standalone para uma plataforma alvo, valida o
layout do pacote e sobe o binário em runners de CI compatíveis para exercitar rotas HTTP
centrais, a recusa da descontinuação do Cursor e a validação do conector ChatGPT.

```bash
PLATFORM=linux-x64 bun run scripts/test-build.ts
```

Em hosts Windows, use `PLATFORM=windows-x64`. O workflow de CI `Smoke — Binary` executa
esse script nas seis plataformas nativas.

A etapa de runtime cria um usuário descartável, envia um conector Cursor com chave fake e
garante que o binário o recusa com `410` — o Cursor é um provider descontinuado, e a recusa
precisa valer no executável distribuído, não apenas onde um seletor escondeu a opção. A
resposta e o stderr do servidor continuam sendo verificados contra falhas de resolução de
módulo como `Cannot find module` ou `./642.js`. Ele também conclui um login OAuth loopback
do ChatGPT contra o servidor fake de auth/backend e valida o conector e o catálogo de
modelos. O smoke permanece hermético ao apontar `MANGO_CHATGPT_AUTH_BASE_URL` /
`MANGO_CHATGPT_BASE_URL` para o servidor fake do ChatGPT. Os tokens fake do ChatGPT usam
`MANGO_SECRET_STORE_UNSAFE_FILE_FALLBACK_DIR` dentro do home temporário do smoke, então o
binário nunca grava esses tokens no OS secret store do usuário. Nenhuma chamada real é feita
às APIs do Cursor ou ChatGPT.

O smoke do ChatGPT precisa da porta de callback `1455`. Quando a porta já está ocupada, o
script imprime uma mensagem de skip para essa etapa e mantém o restante do smoke binário
ativo.

| Lane           | Runner          | Ambiente                            |
| -------------- | --------------- | ----------------------------------- |
| `smoke-binary` | `test-build.ts` | binário compilado no OS/arch nativo |

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
import Type from 'typebox';
import Value from 'typebox/value';
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

Os relatórios de cobertura são escritos em `.mango/artifacts/coverage/`. O Vitest do frontend
escreve o relatório React/Vite em `.mango/artifacts/coverage/frontend/vitest/`, e `bun:test`
escreve LCOV da lógica pura em `.mango/artifacts/coverage/frontend/bun/`:

```bash
bun run --filter @mangostudio/frontend test:coverage
```

## Retenção De Artefatos No CI

Os artefatos de CI se dividem em quatro classes de retenção; mantenha novos uploads alinhados a elas:

| Classe                    | Exemplos                                                        | Política                                                               |
| ------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Handoff entre jobs        | fragmento `qa-test-metrics` (test → qa-metrics)                 | 1 dia — consumido dentro do mesmo run                                  |
| Diagnóstico de falha      | saída bruta de cobertura, traces e relatório HTML do Playwright | 7–14 dias, enviados apenas com `if: failure()`                         |
| Assets de release         | binários e pacotes preparados no pipeline de release            | 30 dias                                                                |
| Baselines de push na main | envelopes `qa-metrics` de runs verdes de CI na `main`           | 90 dias — baselines por SHA exato para relatórios de QA de PRs futuros |

Runs verdes resumem seu resultado no step summary (`$GITHUB_STEP_SUMMARY`) em vez
de enviar artefatos que só existem em caso de sucesso. O workflow de browser-smoke
mantém um input de `workflow_dispatch` (`always_upload_report`) para enviar o
relatório HTML de um run verde quando necessário.

## Checklist De Verificação

Antes de fazer merge, rode:

```bash
bun run check
bun run test
# ou use o atalho do gate completo de CI:
bun run verify
```

`bun run verify` corresponde ao pipeline de CI menos os jobs de smoke (browser e
binary), que exigem runners de plataforma nem sempre disponíveis localmente.
Rode-os separadamente com `bun run test --e2e` e `bun scripts/test-build.ts`.
