# Sistema De Tools

O MangoStudio suporta tool calling agnóstico a provedor durante turnos de chat. Modelos podem chamar tools, o sistema as executa e os resultados são devolvidos ao modelo em loop.

## Arquitetura

```
Camada HTTP (tool-settings-routes.ts)
    │
Camada de aplicação (tool-settings-service.ts)
    │── usa ──→ Registry (registry.ts)
    │── usa ──→ Settings Policy (settings-policy.ts)
    │── usa ──→ Repository (tool-settings-repository.ts)
                    │
                DB: user_tool_settings
                    │
Camada de tools (types.ts + registry.ts)
    │── registra ──→ Built-ins (generate-image.ts, get-current-datetime.ts)
    │
Camada do provedor (tool-mapper.ts) ──→ formatos wire específicos
```

## Ciclo De Vida Das Tools

1. **Registro** — Tools se auto-registram em tempo de import via `registerTool()`. Tools built-in fazem isso no load do módulo.
2. **Resolução de settings** — No momento do chat, `getEnabledToolRuntime()` carrega tool settings do usuário no DB, faz merge com defaults e produz `ToolDefinition[]` habilitadas.
3. **Mapeamento do formato wire** — `tool-mapper.ts` converte `ToolDefinition[]` para o formato específico do provedor, como function tools da OpenAI ou function declarations do Gemini.
4. **Modelo chama a tool** — O provedor faz streaming de eventos `tool_call_started`, `tool_call_arguments_delta` e `tool_call_completed`.
5. **Execução** — `executeTool()` faz lookup da tool, verifica se ela está habilitada para o usuário, aplica merge de settings e executa o executor.
6. **Devolução do resultado** — Tool results são serializados e enviados ao modelo na próxima iteração do loop.
7. **Nova iteração** — Os passos 4–6 se repetem até que o modelo produza uma resposta em texto ou o limite máximo de iterações seja atingido.

## Tipos Centrais

### ToolDefinition

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema; // JSON Schema dos argumentos da tool
}
```

### RegisteredTool

```typescript
interface RegisteredTool {
  definition: ToolDefinition;
  buildDefinition?: (settings: EffectiveToolSettings) => ToolDefinition;
  settings: ToolSettingsMetadata;
  execute: (args: unknown, context: ToolContext) => Promise<unknown>;
}
```

### ToolSettingsMetadata

```typescript
interface ToolSettingsMetadata {
  title: string;
  description: string;
  category: 'system' | 'image' | 'interaction';
  enabledByDefault: boolean;
  canDisable: boolean;
  defaultParameters: Record<string, unknown>;
  parameterDescriptors: ToolParameterDescriptor[];
}
```

## Tools Built-in

### `generate_image`

Cria uma ou mais imagens via modelos de geração de imagem durante um turno de chat de texto.

- **Nome da tool:** `generate_image`
- **Categoria:** `image`
- **Parâmetros:** `prompt` (obrigatório), `count` (1–4), `quality`, `model`
- **Schema dependente de settings:** `maxImagesPerCall` é limitado dinamicamente com base nas configurações do usuário.
- **Execução:** Planeja imagens com `createGenerateImageToolPlan()`, produz resultados por imagem via streaming e resume tudo em um único resultado.

### `get_current_datetime`

Retorna a data e hora atuais em um fuso horário e locale solicitados.

- **Nome da tool:** `get_current_datetime`
- **Categoria:** `system`
- **Parâmetros:** `timezone` (IANA, ex. `America/Sao_Paulo`), `locale` (BCP 47, ex. `pt-BR`)
- **Execução:** Valida o timezone, formata via `Intl.DateTimeFormat` e retorna UTC ISO + datetime localizado + offset.

## Settings Policy

A settings policy em `settings-policy.ts` oferece funções puras para:

| Função                                         | Finalidade                                             |
| ---------------------------------------------- | ------------------------------------------------------ |
| `getDefaultToolSettings(tool)`                 | Retorna defaults a partir dos metadados da tool        |
| `mergeToolSettings(tool, saved?, updates?)`    | Faz merge em três etapas: defaults < saved < overrides |
| `normalizeToolParameters(tool, params)`        | Valida nomes, tipos, min/max e valores permitidos      |
| `getToolDefinitionsForTools(tools, settings?)` | Filtra tools habilitadas e produz definitions          |

A normalização de parâmetros lança `ToolParameterError` com mensagem descritiva quando valores são inválidos. `executeTool()` captura isso via `getSafeEffectiveToolSettings()` e cai para defaults para evitar que settings corrompidos quebrem a execução da tool.

## API De Tool Settings

### `GET /api/settings/tools`

Retorna todas as tools registradas com seus settings efetivos para o usuário atual.

Resposta: `ToolSettingsListResponse`

```typescript
{
  tools: ToolSettingsDescriptor[];
}
```

### `PUT /api/settings/tools/:toolName`

Atualiza os settings de uma tool, incluindo estado `enabled` e parâmetros.

Request: `UpdateToolSettingsBody`

```typescript
{
  enabled?: boolean;
  parameters?: Record<string, unknown>;
}
```

Retorna 422 com `ToolSettingsError` se os parâmetros forem inválidos ou se a tool não puder ser desabilitada.

## Tool Mapper

`tool-mapper.ts` converte `ToolDefinition` internas para formatos wire específicos:

| Provedor            | Mapper                           | Formato                                                       |
| ------------------- | -------------------------------- | ------------------------------------------------------------- |
| OpenAI Responses    | `toolDefsToResponsesAPI()`       | `{ type: 'function', name, description, parameters, strict }` |
| Gemini Interactions | `toolDefsToGeminiInteractions()` | `{ name, description, parameters }`                           |
| OpenAI-compatible   | `toolDefsToChatCompletions()`    | `ChatCompletionTool[]`                                        |

A API OpenAI Responses aplica `strict: true` quando o schema satisfaz os requisitos do strict mode, como `type: object`, `additionalProperties: false`, todas as propriedades obrigatórias e ausência de `oneOf`, `anyOf`, `allOf`, `not` e `$ref`.

## Adicionando Uma Nova Tool

1. Crie o arquivo da tool em `apps/api/src/services/tools/builtin/`.
2. Defina `ToolDefinition`, `ToolSettingsMetadata` e a função `execute`.
3. Chame `registerTool()` para auto-registro em tempo de import.
4. Importe a tool em `apps/api/src/services/tools/index.ts` para disparar o registro.
5. Se a tool precisar de comportamento dependente de settings, forneça um callback `buildDefinition`.
6. Adicione schemas TypeBox de request/response nos contratos compartilhados se a tool tiver sua própria superfície de API.
7. Escreva testes unitários para o executor da tool e para o merge de settings.

### Exemplo Mínimo

```typescript
import { registerTool } from '../registry';
import type { RegisteredTool, ToolContext } from '../types';

const MY_TOOL: RegisteredTool = {
  definition: {
    name: 'my_tool',
    description: 'Does something useful.',
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Input value' },
      },
      required: ['input'],
    },
  },
  settings: {
    title: 'My Tool',
    description: 'A custom tool for specific tasks.',
    category: 'interaction',
    enabledByDefault: true,
    canDisable: true,
    defaultParameters: {},
    parameterDescriptors: [],
  },
  execute: async (args, context) => {
    const { input } = args as { input: string };
    return { result: `Processed: ${input}` };
  },
};

registerTool(MY_TOOL);
```
