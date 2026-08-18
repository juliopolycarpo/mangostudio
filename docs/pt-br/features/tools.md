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

### Inspeção De Capacidades E Conexões MCP Lazy

Servidores MCP habilitados também são conectados de forma lazy quando o inspetor de capacidades
do chat é aberto. O inspetor executa a mesma listagem de tools em cache usada no início de um
turno, garantindo que a projeção corresponda exatamente ao que o chat, o modelo e o agente
selecionados enviariam ao provedor. A conexão é compartilhada com o pipeline do turno, portanto a
inspeção também aquece o próximo turno.

Isso significa que abrir o inspetor pode iniciar um servidor stdio habilitado ou abrir uma sessão
MCP remota habilitada, embora a projeção seja lida por um endpoint `GET`. Desabilite o servidor em
**Settings → MCP** quando ele não deve ser iniciado nem acessado. Essa escolha entre paridade e
efeito colateral é intencional; consulte
[#540](https://github.com/juliopolycarpo/mangostudio/issues/540).

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

Chats podem vincular um diretório de trabalho no servidor para turnos em **modo
agente**. Nesse modo, ferramentas de filesystem usam o diretório vinculado
quando `path` / `cwd` são omitidos, resolvem argumentos relativos a partir dele,
e o system prompt do agente anuncia esse caminho. O **modo chat** não injeta o diretório vinculado: `bash`, `glob` e
shells relacionados voltam ao diretório de trabalho do processo da API quando
`cwd` é omitido, e ferramentas como `list_directory` e `grep` ainda exigem um
`path` explícito. Com restrição habilitada no modo agente, a política de
contenção de caminhos se aplica às tools roteadas.

**A convenção de caminhos vale nos dois sentidos: um caminho que uma tool
reporta pode ser passado para outra tool e chegar no mesmo arquivo.** Todo
caminho em uma lista de resultados — `grep.matches[].file`, `glob.matches[]` — é
relativo ao diretório de trabalho do chat, e não à raiz da busca que a chamada
nomeou. Dois casos reportam caminho absoluto, porque um relativo seria pior que
verboso: um chat sem diretório de trabalho vinculado, e um match que cai fora do
diretório de trabalho. A setting `absolute` do `glob` continua sendo o opt-out
explícito e mantém o significado de "me dê caminhos absolutos". Ecos de entrada
(`grep.path`, `glob.cwd`) não são resultados e voltam como recebidos ou como
resolvidos.

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

Lê o conteúdo de um arquivo do disco, como texto numerado por linha ou como bytes brutos.

- **Nome da tool:** `read_file`
- **Categoria:** `system`
- **Parâmetros:**
  - `path` (obrigatório, absoluto, começando com `~`, ou relativo ao diretório de trabalho do chat)
  - `startLine` (opcional, base 1; padrão `1`; apenas para `view: 'text'`)
  - `maxLines` (opcional; padrão `2000`, máximo `5000`; apenas para `view: 'text'`)
  - `view` (opcional, `text` | `hex` | `base64`; padrão `text`)
- **Settings:** `allowedPaths`, `deniedPaths` (listas de caminhos; aplicadas por `resolveAndValidatePath`)
- **Execução:** Lê por um único descritor de arquivo, e o teto de tamanho limita os bytes que o
  descritor entrega, não o tamanho que o `stat` declara — um arquivo que subdeclara o próprio
  tamanho ou que cresce durante a leitura é recusado no teto, não lido além dele. O `sha256` do
  arquivo inteiro sempre é registrado no ledger de freshness, mesmo em leitura parcial. Formato
  do resultado: `{ content, path, size, sha256, totalLines, startLine, endLine, truncated }`, mais
  `view` quando ele não é `text`.
- **`view: 'text'`** (teto de 10 MiB): devolve conteúdo numerado (estilo `cat -n`) da janela pedida
  e rejeita qualquer arquivo com byte NUL nos primeiros 8 KiB, nomeando as views de bytes na
  recusa. Limites por linha e por bytes da janela podem marcar `truncated` e acrescentar um aviso
  para usar `startLine`/`maxLines`.
- **`view: 'hex'` / `view: 'base64'`** (teto de 256 KiB): devolve os bytes do arquivo transcodificados,
  para qualquer arquivo, sem estrutura de linhas (`totalLines: 0`) e sem janela — o resultado
  inteiro chega ao modelo, e é por isso que o teto é muito menor. Um arquivo acima dele é recusado
  em vez de truncado. `startLine`/`maxLines` são rejeitados junto de uma view de bytes em vez de
  descartados. Uma view de bytes registra freshness exatamente como uma leitura de texto, e é isso
  que torna satisfazível a guarda de leitura-antes-de-sobrescrever do `write_file` para um arquivo
  binário — nenhum argumento de bypass existe no `write_file`.

### `list_directory`

Lista arquivos e diretórios em um caminho.

- **Nome da tool:** `list_directory`
- **Categoria:** `system`
- **Parâmetros:** `path` (obrigatório, absoluto, começando com `~`, ou relativo ao diretório de trabalho do chat)
- **Settings:** `allowedPaths`, `deniedPaths`
- **Execução:** Chama `readdir(path, { withFileTypes: true })` e retorna `{ path, entries: { name, type }[] }`.

### `glob`

Encontra caminhos do filesystem que correspondem a um padrão glob, avaliados por `Bun.Glob`.

- **Nome da tool:** `glob`
- **Categoria:** `system`
- **Parâmetros:** `pattern` (obrigatório, suporta `*`, `**`, `?`, `[]`, `{a,b}`, `!`), `cwd` (diretório base opcional; absoluto, começando com `~`, ou relativo ao diretório de trabalho do chat; padrão é o diretório de trabalho do chat, senão `process.cwd()`)
- **Settings:** `allowedPaths`, `deniedPaths`, `maxResults` (1–5.000; padrão 200), `includeDotfiles` (padrão `false`), `absolute` (padrão `false`)
- **Execução:** Itera os matches com `new Bun.Glob(pattern).scan({ cwd, dot, absolute, onlyFiles: false })`, para ao atingir o limite e sinaliza `truncated`.
- **Caminhos do resultado:** reancorados do `cwd` para o diretório de trabalho do chat, para que um
  match possa ser passado direto para o `read_file`. `absolute: true` faz opt-out e devolve caminhos
  absolutos.

### `grep`

Pesquisa nos arquivos por linhas que correspondam a uma expressão regular.

- **Nome da tool:** `grep`
- **Categoria:** `system`
- **Parâmetros:** `pattern` (regex obrigatória), `path` (arquivo ou diretório obrigatório; absoluto, começando com `~`, ou relativo ao diretório de trabalho do chat), `glob` (filtro opcional para buscas em diretório), `caseInsensitive`
- **Settings:** `allowedPaths`, `deniedPaths`, `maxResults` (1–5.000; padrão 100), `maxMatchesPerFile` (padrão 20), `maxFileSizeBytes` (padrão 1 MB), `includeDotfiles`
- **Segurança:** Arquivos com byte nulo nos primeiros 8 KiB são tratados como binários e ignorados; arquivos acima de `maxFileSizeBytes` também são pulados. A janela de detecção é compartilhada com o `read_file`, então um arquivo que o grep pesquisa é um arquivo que o `read_file` abre. A regex é compilada com `new RegExp` e rejeitada via `GrepPatternError` quando inválida.
- **Execução:** Quando `path` é um diretório, percorre-o com `Bun.Glob` (filtrado pelo `glob` opcional); para cada candidato lê com `Bun.file().text()`, divide por linha e registra matches `{ file, line, text }`.
- **Caminhos do resultado:** `matches[].file` é reancorado da raiz da busca para o diretório de
  trabalho do chat, tanto em buscas por diretório quanto por arquivo único, para que um match possa
  ser passado direto para o `read_file`.

### `bash` / `zsh` / `powershell`

Executam um comando de shell e retornam `stdout`, `stderr`, código de saída e tempo capturados. As três tools compartilham uma única implementação (`buildShellTool`) e diferem apenas pelo interpretador.

- **Nomes das tools:** `bash`, `zsh`, `powershell`
- **Categoria:** `system`
- **Parâmetros:** `command` (obrigatório), `cwd` (diretório de trabalho opcional; absoluto, começando com `~`, ou relativo ao diretório de trabalho do chat)
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

A API OpenAI Responses aplica `strict: true` quando o schema *derivado* satisfaz os requisitos
do strict mode (`type: object`, `additionalProperties: false`, todas as propriedades
obrigatórias **em qualquer nível de aninhamento**, sem `oneOf`/`anyOf`/`allOf`/`not`/`$ref`/`minLength`/`maxLength`).
`toStrictSchema` produz esse dialeto no limite do Responses; os schemas de origem permanecem
JSON Schema comum.

Espera-se que toda ferramenta embutida passe depois da transformação. Uma ferramenta que
falhe em `isStrictCompatible` no schema derivado deve ser corrigida, e não isentada —
`tests/unit/services/providers/tool-mapper-strict.test.ts` verifica `strict: true` por id de
ferramenta.

### Argumentos opcionais são opcionais

Escreva JSON Schema comum: um argumento opcional usa um único `type` e fica de fora de
`required`, e `minLength`/`maxLength` permanecem na origem para o Anthropic e o Gemini
anunciarem o limite. O OpenAI Responses não tem chave opcional, então `toStrictSchema`
deriva esse dialeto no limite: toda propriedade entra em `required`, as chaves que eram
opcionais viram uma união anulável (`type: ['string', 'null']`), e os limites de
comprimento são descartados. O executor continua a aplicá-los.

```jsonc
// origem (JSON Schema comum)                 // fio do Responses (derivado)
{ "properties": { "startLine": {              { "properties": { "startLine": {
    "type": "integer", "minimum": 1 } },          "type": ["integer", "null"], "minimum": 1 } },
  "required": ["path"] }                        "required": ["path", "startLine"] }
```

Os helpers de parsing em `services/tools/arg-parsing.ts` leem `null` como "ausente", de modo
que um modelo que envia null (Responses strict) e um que omite a chave seguem o mesmo
caminho. `minimum`/`maximum` numéricos, `enum`, `pattern` e `minItems`/`maxItems` sobrevivem
nos dois dialetos.

### Argumentos malformados são rejeitados, não substituídos

Um argumento presente com o tipo errado gera `ToolArgumentError` (classificado como
`validation_failed`) em vez de recorrer a um padrão. Substituir um valor transforma um engano
corrigível em uma resposta errada plausível: o `grep` descartando uma flag
`caseInsensitive: "true"` devolve um conjunto vazio que o modelo lê como "o símbolo não
existe", e `list_directory({"path": 42})` devolvendo o diretório de trabalho é lido como uma
listagem bem-sucedida do diretório que o modelo nomeou.

A regra vale apenas para saída do modelo. **Configurações** armazenadas continuam sendo
coagidas aos seus padrões — `clampIntegerSetting` e `getStringSetting` — porque não há um
turno do modelo a quem entregar um erro corrigível.

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
