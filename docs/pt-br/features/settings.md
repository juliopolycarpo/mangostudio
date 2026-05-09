# Arquitetura De Settings

O MangoStudio tem três camadas independentes de settings, cada uma com sua própria persistência, API e módulo no frontend.

## Taxonomia De Settings

| Camada                | O que controla                                                      | Tabela de persistência   | Escopo                       |
| --------------------- | ------------------------------------------------------------------- | ------------------------ | ---------------------------- |
| **App Settings**      | Tema, idioma, defaults de geração, configuração de prompt, contexto | `user_app_settings`      | Um blob por usuário          |
| **Provider Settings** | Configuração de runtime por provedor                                | `user_provider_settings` | Um blob por usuário+provedor |
| **Tool Settings**     | Enable/disable de tools e overrides de parâmetros                   | `user_tool_settings`     | Uma linha por usuário+tool   |

## App Settings

Controlam preferências globais que valem para todos os provedores e tools.

**Campos armazenados:**

| Campo                | Tipo                              | Padrão                    |
| -------------------- | --------------------------------- | ------------------------- |
| `promptSettings`     | `PromptSettings`                  | Prompts padrão do sistema |
| `globalImageQuality` | `'512px' \| '1K' \| '2K' \| '4K'` | `'1K'`                    |
| `thinkingEnabled`    | `boolean`                         | `true`                    |
| `reasoningEffort`    | `ReasoningEffort`                 | `'medium'`                |
| `maxToolIterations`  | `number` (1–25)                   | `10`                      |
| `contextSettings`    | `ContextSettings`                 | Defaults de compactação   |

**API:**

```
GET  /api/settings/app    → Retorna AppSettings
PUT  /api/settings/app    → Atualiza e retorna AppSettings normalizado
```

As settings ficam em um único blob JSON na coluna `settingsJson`. Na leitura, `normalizeAppSettings()` trata dados parciais ou inválidos, caindo para defaults em qualquer campo ausente ou incorreto.

### Prompt Settings (subobjeto)

Controlam prompts de sistema e configuração de arquivos de regra:

- `textSystemPrompt` — prompt de sistema para geração de texto
- `imageSystemPrompt` — prompt de sistema para geração de imagem
- `agentsMd` — conteúdo de `AGENTS.md` usado como injeção no prompt
- `claudeMd` — conteúdo de `CLAUDE.md` usado como injeção no prompt
- `customRules` — arquivos de regra definidos pelo usuário com path, estado habilitado, papel de injeção e frequência de envio

### Context Settings (subobjeto)

Controlam o comportamento da janela de contexto:

- `compactionEnabled` / `summarizationEnabled` — habilitam ou desabilitam recursos de compactação
- `compactionThreshold` — percentual a partir do qual a compactação é oferecida; o padrão é 85
- `compactionSummaryModelId` — modelo usado para sumarização

## Provider Settings

Controlam o comportamento de runtime por provedor. Cada provedor possui uma policy que define quais settings se aplicam.

**API:**

```
GET  /api/settings/providers              → Lista todos os descritores de provedor
GET  /api/settings/providers/:provider    → Um descritor específico
PUT  /api/settings/providers/:provider    → Atualiza provider settings
```

### Policy De Provider Settings

Cada tipo de provedor tem uma policy hardcoded em `provider-settings-policy.ts`:

| Provedor          | Thinking | Prompt caching | Tools           | Structured output |
| ----------------- | -------- | -------------- | --------------- | ----------------- |
| Gemini            | Sim      | Não            | Sim             | Limitado          |
| OpenAI            | Sim      | Não            | Sim             | Sim               |
| OpenAI-compatible | Depende  | Depende        | Sim             | Depende           |
| Anthropic         | Sim      | Sim            | Sim             | Não               |
| DeepSeek          | Sim      | Sim            | Sim (apenas v4) | Não               |

Os settings são normalizados contra a policy do provedor em toda leitura e escrita. Por exemplo, Anthropic sempre retorna `structuredOutputSupported: false` independentemente do dado salvo.

### Shape Das Runtime Settings

```typescript
interface ProviderRuntimeSettings {
  thinkingEnabled?: boolean;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxOutputTokens?: number;
  maxToolIterations?: number;
  promptCachePreference?: 'auto' | 'enabled' | 'disabled';
}
```

## Tool Settings

Controlam quais tools ficam habilitadas e quais valores de parâmetro cada usuário usa.

**API:**

```
GET  /api/settings/tools              → Lista todos os descritores de tool com settings
PUT  /api/settings/tools/:toolName    → Atualiza os settings de uma tool
```

Cada linha de tool tem uma coluna dedicada `enabled` como inteiro 0/1 e um blob `parametersJson`. Os settings são validados contra `parameterDescriptors` da tool no momento da escrita; valores inválidos retornam HTTP 422.

### Parameter Descriptors

Cada tool declara seus parâmetros configuráveis:

```typescript
interface ToolParameterDescriptor {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  label: string;
  description: string;
  required: boolean;
  defaultValue: unknown;
  options?: Array<{ label: string; value: unknown }>;
  min?: number;
  max?: number;
  modelType?: 'image'; // para seletores de modelo alimentados por catálogo
}
```

## Fluxo De Settings

```
Componente do frontend
    │
    ▼
Hook (TanStack Query: useQuery / useMutation)
    │
    ▼
Eden Treaty Client (chamadas de API tipadas)
    │
    ▼
Rota Elysia (auth + validação TypeBox)
    │
    ▼
Application Service
    ├─ validação (ownership, restrições da policy)
    ├─ normalização (merge com defaults, clamp de valores)
    ├─ repository (upsert com Kysely)
    │
    ▼
Resposta (tipada via shared contracts)
```

Todas as queries de settings usam `staleTime` de 30 segundos no TanStack Query. Mutations invalidam automaticamente suas listas correspondentes em caso de sucesso.

## Migração: `localStorage` → Banco De Dados

Originalmente, app settings eram persistidos em `localStorage` do browser via `useGlobalSettings()`. O PR #210 migrou isso para uma API com persistência em banco:

1. **Contratos compartilhados** — novo módulo `app-settings` com schemas TypeBox e defaults.
2. **Módulo da API** — rotas HTTP de `app-settings` + application service + repository + migração 018.
3. **Migração do frontend** — `useGlobalSettings()` foi refatorado de leitura/escrita em `localStorage` para TanStack Query usando a API.

Provider settings e tool settings sempre foram persistidos em banco desde sua introdução.

## Adicionando Um Novo Setting

1. Defina o tipo e o schema em `apps/shared/src/<module>/`.
2. Adicione o campo ao contrato compartilhado e aos defaults.
3. Atualize o repository da API para ler/escrever o novo campo.
4. Atualize a normalização do application service para tratar dados parciais.
5. Adicione a rota da API, se necessário.
6. Adicione o hook do frontend e o componente de UI.
7. Se o setting afetar comportamento no momento da geração, conecte-o ao serviço apropriado, como `stream-text-turn.ts` lendo `getAppSettings()` ou `getEnabledToolRuntime()`.
