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
- **Settings:** `timeoutSeconds` (5s–600s, padrão 30s), `maxImagesPerCall`, `defaultQuality`, `defaultModel`, `letAiDecideQuality`
- **Execução:** Planeja imagens com `createGenerateImageToolPlan()`, produz resultados por imagem via streaming e resume tudo em um único resultado. Respeita o orçamento `timeoutSeconds` configurado.

### `get_current_datetime`

Retorna a data e hora atuais em um fuso horário e locale solicitados.

- **Nome da tool:** `get_current_datetime`
- **Categoria:** `system`
- **Parâmetros:** `timezone` (IANA, ex. `America/Sao_Paulo`), `locale` (BCP 47, ex. `pt-BR`)
- **Execução:** Valida o timezone, formata via `Intl.DateTimeFormat` e retorna UTC ISO + datetime localizado + offset.

### `read_file`

Lê o conteúdo de um arquivo de texto do disco.

- **Nome da tool:** `read_file`
- **Categoria:** `system`
- **Parâmetros:** `path` (obrigatório, absoluto ou começando com `~`)
- **Settings:** `allowedPaths`, `deniedPaths` (listas de caminhos; aplicadas por `resolveAndValidatePath`)
- **Execução:** Lê o arquivo com `Bun.file().text()` e retorna `{ content, path, size }`.

### `list_directory`

Lista arquivos e diretórios em um caminho.

- **Nome da tool:** `list_directory`
- **Categoria:** `system`
- **Parâmetros:** `path` (obrigatório, absoluto ou começando com `~`)
- **Settings:** `allowedPaths`, `deniedPaths`
- **Execução:** Chama `readdir(path, { withFileTypes: true })` e retorna `{ path, entries: { name, type }[] }`.

### `glob`

Encontra caminhos do filesystem que correspondem a um padrão glob, avaliados por `Bun.Glob`.

- **Nome da tool:** `glob`
- **Categoria:** `system`
- **Parâmetros:** `pattern` (obrigatório, suporta `*`, `**`, `?`, `[]`, `{a,b}`, `!`), `cwd` (diretório base opcional; padrão `process.cwd()`)
- **Settings:** `allowedPaths`, `deniedPaths`, `maxResults` (1–5.000; padrão 200), `includeDotfiles` (padrão `false`), `absolute` (padrão `false`)
- **Execução:** Itera os matches com `new Bun.Glob(pattern).scan({ cwd, dot, absolute, onlyFiles: false })`, para ao atingir o limite e sinaliza `truncated`.

### `grep`

Pesquisa nos arquivos por linhas que correspondam a uma expressão regular.

- **Nome da tool:** `grep`
- **Categoria:** `system`
- **Parâmetros:** `pattern` (regex obrigatória), `path` (arquivo ou diretório obrigatório), `glob` (filtro opcional para buscas em diretório), `caseInsensitive`
- **Settings:** `allowedPaths`, `deniedPaths`, `maxResults` (1–5.000; padrão 100), `maxMatchesPerFile` (padrão 20), `maxFileSizeBytes` (padrão 1 MB), `includeDotfiles`
- **Segurança:** Arquivos com byte nulo nos primeiros 1 KB são tratados como binários e ignorados; arquivos acima de `maxFileSizeBytes` também são pulados. A regex é compilada com `new RegExp` e rejeitada via `GrepPatternError` quando inválida.
- **Execução:** Quando `path` é um diretório, percorre-o com `Bun.Glob` (filtrado pelo `glob` opcional); para cada candidato lê com `Bun.file().text()`, divide por linha e registra matches `{ file, line, text }`.

### `bash` / `zsh` / `powershell`

Executam um comando de shell e retornam `stdout`, `stderr`, código de saída e tempo capturados. As três tools compartilham uma única implementação (`buildShellTool`) e diferem apenas pelo interpretador.

- **Nomes das tools:** `bash`, `zsh`, `powershell`
- **Categoria:** `system`
- **Parâmetros:** `command` (obrigatório), `cwd` (diretório de trabalho opcional; `~` é expandido)
- **Settings:** `timeoutSeconds` (5s–600s, padrão 30s), `maxOutputBytes` (1KB–1MB por stream, padrão 100KB)
- **Disponibilidade:** Registradas no import apenas quando o interpretador existe — `bash`/`zsh` via `Bun.which`, `powershell` somente no Windows (`pwsh` e depois `powershell`). Shells indisponíveis nunca são oferecidos aos modelos.
- **Segurança:** Desabilitadas por padrão (`enabledByDefault: false`); exigem ativação explícita. O processo é encerrado com `SIGKILL` após o tempo configurado, e a saída por stream é limitada a `maxOutputBytes` (sinalizado por `truncated`). Abort do pai (cancelamento do usuário ou encerramento do stream) é rastreado separadamente do timeout e não aparece como erro de timeout.
- **Execução:** `runShellCommand()` inicia o interpretador com `Bun.spawn` (`bash -c` / `zsh -c` / `powershell -NoProfile -NonInteractive -Command`), aplica o timeout com um timer próprio (não o timeout do spawn do Bun), lê ambos os streams dentro do limite de bytes e retorna um `ShellCommandResult` estruturado com o campo `termination` (`exited`, `timed_out`, `aborted` ou `signalled`).

## Settings Policy

A settings policy em `settings-policy.ts` oferece funções puras para:

| Função                                         | Finalidade                                             |
| ---------------------------------------------- | ------------------------------------------------------ |
| `getDefaultToolSettings(tool)`                 | Retorna defaults a partir dos metadados da tool        |
| `mergeToolSettings(tool, saved?, updates?)`    | Faz merge em três etapas: defaults < saved < overrides |
| `normalizeToolParameters(tool, params)`        | Valida nomes, tipos, min/max e valores permitidos      |
| `getToolDefinitionsForTools(tools, settings?)` | Filtra tools habilitadas e produz definitions          |

A normalização de parâmetros lança `ToolParameterError` com mensagem descritiva quando valores são inválidos. `executeTool()` captura isso via `getSafeEffectiveToolSettings()` e cai para defaults para evitar que settings corrompidos quebrem a execução da tool.

Builtins de execução longa (`bash`, `zsh`, `powershell`, `generate_image`) expõem `timeoutSeconds` (5–600, padrão 30). A camada de execução do chat lê esse valor e cancela a chamada quando o orçamento estoura; tools de shell também repassam o sinal de abort para encerrar processos filhos em timeout ou cancelamento em vez de deixá-los órfãos. Tools de shell distinguem timeout de abort do pai em `ShellCommandResult.termination`, de modo que apenas timeouts genuínos exibem a mensagem de timeout. Tools sem `timeoutSeconds` mantêm o padrão de 30 segundos.

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
