# Guia De Desenvolvimento De Provedores

## Checklist Para Adicionar Um Provedor

1. Registre o tipo de provedor em `apps/shared/src/types/provider.ts`
2. Adicione a classe do provedor implementando `AIProvider` em `apps/api/src/services/providers/`
3. Registre o provedor em `apps/api/src/services/providers/core/provider-registry.ts`
4. Implemente `generateAgentTurnStream` para fluxos agentic com tool calling
5. Adicione capability flags em `ModelInfo`, especialmente `statefulContinuation`
6. Adicione a estratégia de continuação em `CONTINUATION_STRATEGIES` dentro de `continuation-runtime.ts`
7. Escreva o replay builder em `replay-builder.ts`
8. Adicione limites de contexto do modelo em `context-policy.ts`
9. Escreva testes, conforme a seção "Testes Obrigatórios"

---

## Métodos Obrigatórios Do Provedor E Capability Flags

Todo provedor precisa implementar a interface `AIProvider` em `apps/api/src/services/providers/types.ts`:

| Método                    | Obrigatório | Finalidade                                  |
| ------------------------- | ----------- | ------------------------------------------- |
| `generateText`            | sim         | Geração de texto em turno único             |
| `generateTextStream`      | não         | Streaming simples de texto, sem tool loop   |
| `generateImage`           | não         | Geração de imagem                           |
| `generateAgentTurnStream` | não         | **Turno agentic completo** com tool calling |
| `listModels`              | sim         | Catálogo de modelos                         |
| `validateApiKey`          | sim         | Validação da chave                          |
| `resolveApiKey`           | sim         | Resolução da chave                          |

As capability flags em `ModelInfo.capabilities` determinam como o orquestrador escolhe o caminho do provedor em `stream-text-turn.ts`:

```typescript
capabilities: {
  text: true,             // suporta geração de texto
  streaming: true,        // suporta streaming
  tools: true,            // suporta tool calling
  statefulContinuation: true, // possui cursor durável
  structuredOutput: true, // suporta restrição por JSON Schema
}
```

O DeepSeek é modelado como provedor de primeira classe, em vez de mero connector OpenAI-compatible. Ele ainda usa a superfície de runtime do AI SDK, mas o tipo separado permite ao catálogo expor capacidades específicas de reasoning, tool, cache e continuação sem alterar o comportamento genérico OpenAI-compatible.

---

## Como Decidir O Modo De Continuação

Adicione uma entrada em `CONTINUATION_STRATEGIES` dentro de `continuation-runtime.ts`:

```typescript
'your-provider': {
  provider: 'your-provider',
  strategy: 'durable-cursor' | 'replay' | 'turn-local',
  supportsDurableCursor: true | false,
  durableMode: 'responses' | 'interactions' | null,
},
```

- **durable-cursor**: o provedor tem cursor server-side, como `previous_response_id`. Defina `durableMode` com o nome do modo wire.
- **replay**: o provedor é stateless entre turnos. Não há durable mode. Exemplo: OpenAI-compatible Chat Completions.
- **turn-local**: o provedor acumula estado dentro de um único loop de tool, mas não tem cursor cross-turn. Exemplo: Anthropic Messages.

---

## Como Construir Replay Com Segurança

Replay é o caminho de fallback usado quando não há cursor durável disponível. Cada formato por provedor fica em `replay-builder.ts`.

### Regras

1. **Excluir parts de thinking/erro** — O modelo não precisa dos próprios tokens de reasoning anteriores no replay. Error parts são artefatos de UI.
2. **Turnos do usuário emitem texto simples** — Mensagens do usuário não têm parts estruturados; sempre convertem para `{ role: 'user', content: text }`.
3. **Turnos da IA são reconstruídos a partir de parts** — Itere por `turn.parts` e filtre por `text`, `tool_call` e `tool_result`.
4. **Tool results vêm logo após a tool call que os gerou** — A ordem é texto do assistente → tool call → tool result. É isso que os provedores esperam em conversas multi-turno com tools.
5. **Fallback para texto simples** — Se `turn.parts` estiver vazio ou ausente, emita `{ role: assistant|user, content: turn.text }`. Isso preserva compatibilidade retroativa com mensagens persistidas antes do sistema de parts.

### Formato de replay por provedor

| Provedor            | Função de replay                | Formato de saída                                                             |
| ------------------- | ------------------------------- | ---------------------------------------------------------------------------- |
| OpenAI Responses    | `buildOpenAIResponsesReplay`    | Array de `ResponseInputItem` com roles e function calls                      |
| Gemini Interactions | `buildGeminiInteractionsReplay` | Array de objetos de turno com role, content, function_call e function_result |
| OpenAI-compatible   | `buildChatCompletionsReplay`    | `ChatCompletionMessageParam[]` com array `tool_calls`                        |
| DeepSeek            | `buildChatCompletionsReplay`    | `ChatCompletionMessageParam[]` com `reasoning_content` nos loops de tools    |
| Anthropic           | direto em `stream.ts`           | `MessageParam[]` derivado do histórico, sem replay builder                   |

---

## Como Emitir Itens `AgentEvent`

O método `generateAgentTurnStream` produz itens `AgentEvent` de `apps/shared/src/types/agent-events.ts`.

### Sequência obrigatória

```
for each turn iteration:
  reasoning_delta*           // tokens de thinking/reasoning (opcional)
  tool_call_started          // para cada tool call do modelo
  tool_call_arguments_delta* // streaming dos argumentos da tool
  tool_call_completed        // quando os argumentos foram recebidos por completo
  assistant_text_delta*      // streaming do conteúdo textual
  continuation_degraded?     // apenas em perda de cursor no meio do turno
  turn_completed             // DEVE ser o último evento em sucesso
  turn_error                 // DEVE ser o último evento em falha
```

### Estado em `turn_completed`

Serializa um `ContinuationEnvelope` em `providerState`:

```typescript
yield {
  type: 'turn_completed',
  providerState: serializeContinuationEnvelope({
    schemaVersion: 1,
    provider: 'openai',
    mode: 'responses',
    modelName: req.modelName,
    systemPromptHash: computeSystemPromptHash(req.systemPrompt),
    toolsetHash: computeToolsetHash(req.toolDefinitions ?? []),
    cursor: newResponseId,      // apenas em modos duráveis
    context: {
      providerReportedInputTokens: usageInputTokens,
      contextLimit: getModelContextLimit(req.modelName),
      lastUpdatedAt: Date.now(),
    },
  }),
};
```

Para provedores turn-local, inclua `loopMessages` no envelope em vez de `cursor`:

```typescript
yield {
  type: 'turn_completed',
  providerState: JSON.stringify({
    schemaVersion: 1,
    provider: 'openai-compatible',
    mode: 'stateless-loop',
    modelName: req.modelName,
    systemPromptHash: computeSystemPromptHash(req.systemPrompt),
    toolsetHash: computeToolsetHash(req.toolDefinitions ?? []),
    loopMessages: newLoopMessages,
  }),
};
```

---

## Como Tratar Tool Calls

O loop de tools é orquestrado por `stream-text-turn.ts`, não por provedores individuais. Provedores precisam apenas:

1. **Declarar tools** — mapear `ToolDefinition[]` para o formato wire do provedor em `core/tool-mapper.ts`.
2. **Fazer streaming dos deltas de tool call** — emitir `tool_call_started`, `tool_call_arguments_delta` e `tool_call_completed`.
3. **Receber tool results na iteração seguinte** — quando o orquestrador vê `turn_completed` com tool calls pendentes, ele executa as tools e chama `generateAgentTurnStream` de novo com os resultados em `req.toolResults`.

### Padrão de devolução dos tool results

```typescript
// Primeira iteração: o modelo chama tools
// O orquestrador executa tools e monta toolResults
// Segunda iteração: o provedor recebe toolResults no request
if (req.toolResults && req.toolResults.length > 0) {
  // Envia tool results no formato específico do provedor
}
```

---

## Como Reportar Uso E Contexto

Após cada turno, o envelope carrega métricas de contexto:

```typescript
context: {
  providerReportedInputTokens: number | undefined,
  contextLimit: number,
  lastUpdatedAt: number,
}
```

O orquestrador em `stream-text-turn.ts` usa esses valores para:

- computar `estimatedUsageRatio`, exibido no widget de contexto do frontend
- disparar avisos de compactação quando o limite se aproxima
- persistir `chats.lastContextState` para exibição entre sessões

---

## Testes Obrigatórios

### Testes unitários de continuação (`continuation.test.ts`)

Teste o mecanismo de decisão para:

- parse do envelope, incluindo casos válidos, inválidos, nulos e versões erradas de schema
- validação do envelope contra mismatch de provedor, modelo, prompt e toolset
- `decideContinuation` retornando `continue_with_cursor` para envelopes duráveis válidos
- `decideContinuation` retornando `degrade_to_replay` em caso de mismatch
- `decideContinuation` retornando `start_replay` quando não existe estado
- `decideContinuation` retornando `start_replay` para envelopes `stateless-loop`
- `decideTurnPersistence` filtrando envelopes `stateless-loop`
- `decideTurnPersistence` persistindo envelopes de cursor durável
- troca de provedor, como OpenAI→Gemini degradando no primeiro turno e usando cursor Gemini no segundo

### Testes do replay builder (`replay-builder.test.ts`)

Teste a construção do replay para cada provedor:

- histórico completo com texto e tool call parts
- histórico vazio
- turno somente com texto
- compatibilidade retroativa com texto simples sem parts
- tool results posicionados após suas tool calls correspondentes

### Testes específicos do provedor

Para cada `generateAgentTurnStream`:

- primeiro turno sem cursor → replay completo
- continuação por cursor → input mínimo
- devolução de tool result → formato wire correto
- perda de cursor sem tool results → retry com replay
- perda de cursor com tool results → abort com `tool_result_cursor_loss`
- `turn_error` em falha da API

### Padrão de teste para perda de cursor

Teste os cenários seguro e inseguro:

```typescript
// Seguro: perda de cursor sem tool results pendentes
// Esperado: emite continuation_degraded → replay com histórico completo

// Inseguro: perda de cursor com tool results pendentes
// Esperado: emite continuation_degraded → emit turn_error → NÃO faz retry
```
