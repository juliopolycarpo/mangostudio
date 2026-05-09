# Arquitetura De Continuação

## O Que Significa Continuação

Continuação é o mecanismo que permite a uma conversa multi-turno preservar contexto entre interações separadas do usuário sem reenviar todo o histórico do chat a cada request.

Cada vez que o usuário envia uma mensagem, o MangoStudio precisa decidir como apresentar a conversa ao provedor. As três estratégias são:

| Estratégia         | Exemplos de provedor                           | Trade-off                                                                                      |
| ------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Cursor durável** | OpenAI Responses, Gemini Interactions          | Um ID de wire por turno. Barato, mas frágil: o cursor fica obsoleto se o provedor o invalidar. |
| **Replay**         | OpenAI-compatible Chat Completions             | Reenvia o histórico completo em todo turno. Robusto, mas caro com alto volume de tokens.       |
| **Loop local**     | Anthropic Messages, openai-compatible no turno | Acumula estado em memória dentro de um único request. Nunca persiste entre turnos.             |

A decisão é tomada uma vez por turno, antes da primeira chamada ao provedor, e não pode mudar no meio do turno.

---

## Três Conceitos De Estado

A arquitetura separa o estado em três preocupações distintas que nunca devem ser misturadas.

### 1. Estado de cursor durável (`chats.lastProviderState`)

Persistido na tabela `chats` após cada turno concluído. Carrega o `ContinuationEnvelope`, um wrapper tipado e versionado, do provedor que executou o último turno com sucesso.

```json
{
  "schemaVersion": 1,
  "provider": "openai",
  "mode": "responses",
  "modelName": "gpt-4o",
  "systemPromptHash": "abc123",
  "toolsetHash": "def456",
  "cursor": "resp_abc123"
}
```

Somente envelopes **duráveis** com modos `responses` ou `interactions` e cursor válido são armazenados aqui. Envelopes `stateless-loop` são filtrados por `decideTurnPersistence` e nunca tocam o banco.

`chats.lastProviderState` é a fonte **exclusiva** de continuação cross-turn. `providerState` no nível da mensagem nunca é lido para continuação.

### 2. Estado do loop local (`providerState` dentro de um único request)

Provedores que não suportam cursores duráveis, como Anthropic e openai-compatible, acumulam mensagens em `providerState` durante o loop de tool calls.

Esse estado é carregado entre iterações do mesmo turno agentic, mas **nunca persiste** como `chats.lastProviderState`. O orquestrador em `stream-text-turn.ts` devolve esse estado ao provedor em cada iteração, e `decideTurnPersistence` o descarta no momento de salvar.

```json
{
  "provider": "openai-compatible",
  "mode": "stateless-loop",
  "loopMessages": [
    /* … */
  ]
}
```

### 3. Estado de auditoria da mensagem (`messages.providerState`)

Cada mensagem persistida carrega um campo opcional `providerState` que armazena o envelope no momento em que a mensagem foi criada. Isso serve **apenas para auditoria** e **nunca** deve ser usado para continuação.

Por quê:

- `providerState` de uma mensagem reflete o estado no instante em que o turno rodou, e esse estado pode ter sido substituído por turnos posteriores.
- Usar cursores obsoletos pode ressuscitar estado interno do provedor que já foi invalidado, gerando erros 404 difíceis de diagnosticar e até corrupção lógica.

O orquestrador lê exclusivamente `chats.lastProviderState`.

---

## Matriz De Provedores

| Provedor              | Cursor durável | Campo wire                | Replay builder                  | Estado cross-turn (`chats.lastProviderState`) | Estado local                         |
| --------------------- | -------------- | ------------------------- | ------------------------------- | --------------------------------------------- | ------------------------------------ |
| OpenAI (Responses)    | sim            | `previous_response_id`    | `buildOpenAIResponsesReplay`    | `ContinuationEnvelope` (modo `responses`)     | resultados de tools no request atual |
| Gemini (Interactions) | sim            | `previous_interaction_id` | `buildGeminiInteractionsReplay` | `ContinuationEnvelope` (modo `interactions`)  | resultados de tools no request atual |
| OpenAI-compatible     | não            | nenhum                    | `buildChatCompletionsReplay`    | nenhum (sempre começa do zero)                | apenas `loopMessages`                |
| Anthropic             | não            | nenhum                    | replay direto de Messages       | nenhum (sempre começa do zero)                | apenas `loopMessages`                |
| DeepSeek              | não            | nenhum                    | `buildChatCompletionsReplay`    | nenhum (sempre começa do zero)                | apenas `loopMessages`                |

Arquivos principais:

- `continuation-envelope.ts` — schema, parse, validação e serialização do envelope
- `continuation-runtime.ts` — lógica de decisão e filtro de persistência do turno
- `replay-builder.ts` — implementações de replay por provedor

---

## Ciclo De Vida Do Fallback

O ciclo de fallback tem quatro fases.

1. **Validação** — `decideContinuation` verifica o envelope persistido em relação ao contexto atual do turno: provedor, modelo, hash do prompt de sistema e hash do toolset. Se algo mudou, o turno degrada.

2. **Degradação** — Um evento `continuation_degraded` é emitido com o código de motivo: `provider_changed`, `model_changed`, `system_prompt_changed`, `toolset_changed`, `cursor_expired`, `cursor_invalid` ou `envelope_malformed`. O orquestrador também emite `fallback_notice` no SSE e `continuation_transition` persistido em message parts.

3. **Replay** — O request ao provedor envia o histórico completo do banco em vez de um cursor. Todos os provedores implementam esse caminho via replay builder.

4. **Recuperação** — Após um turno de replay bem-sucedido, provedores stateful geram um novo cursor. Os turnos seguintes retomam a continuação baseada em cursor.

### Perda de cursor durante loop de tools ativo

Quando um cursor expira no meio do turno, entre iterações do loop de tools, a restrição de segurança é:

- Se a iteração atual já possui `toolResults` em voo, o turno **aborta** com motivo `tool_result_cursor_loss`. Fazer replay a partir do histórico descartaria silenciosamente resultados de tools ainda não persistidos, produzindo resposta incorreta.
- Se a iteração atual não possui resultados de tools, o provedor tenta novamente usando replay completo.

Essa lógica fica em `responses-stream.ts` e `interactions-stream.ts`.

---

## Eventos De Timeline E Visibilidade Para O Usuário

Eventos de degradação de continuação são expostos por dois canais:

| Canal                     | Tipo                      | Finalidade                                  |
| ------------------------- | ------------------------- | ------------------------------------------- |
| SSE em tempo real         | `fallback_notice`         | Toast/status indicator no frontend          |
| Message parts persistidos | `continuation_transition` | Revisão do histórico mostra o que aconteceu |
| Logs                      | `console.warn`            | Debug operacional                           |

O part `continuation_transition` carrega `recovered: false` durante o turno e é alterado para `recovered: true` quando o turno termina com sucesso.

---

## Snapshots De Contexto E Compactação

Depois que cada turno termina, o orquestrador calcula um `ContextSnapshot` que descreve o uso de tokens de entrada:

- `estimatedInputTokens` — estimativa local, em torno de 4 chars/token, ou valor reportado pelo provedor
- `contextLimit` — janela máxima de contexto de entrada do modelo
- `estimatedUsageRatio` — fração do contexto já consumida
- `severity` — `normal`, `info`, `warning`, `danger` ou `critical`

Limiares definidos em `context-policy.ts`:

- 0-69% normal
- 70-84% info
- 85-91% warning
- 92-96% danger
- 97%+ critical

O snapshot é persistido como `chats.lastContextState` e usado pelo frontend para alertar usuários antes que excedam a janela de contexto do modelo.

### Compactação no lado do provedor

Provedores stateful como OpenAI e Gemini suportam compactação no servidor por meio de:

- OpenAI: parâmetro `context_management` com `compact_threshold`
- Gemini: compactação de interações embutida

A compactação fica habilitada por padrão e pode ser desativada por request via `contextSettings.providerCompactionEnabled`.

### Continuação específica do DeepSeek

O DeepSeek usa estratégia de continuação `turn-local`. Regras principais:

1. **Sem cursor durável** — O DeepSeek não tem cursor server-side. Todo turno do usuário começa do zero com replay completo do histórico persistido.
2. **`reasoning_content` em loops de tools** — Quando o DeepSeek emite tool calls durante um turno com thinking habilitado, o `reasoning_content` acumulado **precisa** ser incluído na mensagem do assistente enviada de volta ao provedor na iteração seguinte. Omissão causa erros HTTP 400.
3. **Sem reasoning cross-turn** — `reasoning_content` é removido da mensagem final quando não há tool calls pendentes. Nunca persiste entre turnos do usuário, o que também preserva a estabilidade do prefixo para cache hits.
4. **Métricas de cache** — `promptCacheHitTokens` e `promptCacheMissTokens` são extraídos da resposta de uso da API DeepSeek e armazenados nos metadados do provider state para observabilidade.
5. **Prefixo estável** — Prompt de sistema, definições de tools em ordem determinística e histórico persistido mantêm um prefixo estável entre turnos para maximizar cache hits de contexto no DeepSeek.

---

## Modos Comuns De Falha E Onde Depurar

| Sintoma                                     | Causa provável                               | Onde olhar                                                                     |
| ------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------ |
| Todo turno começa com `degrade_to_replay`   | `chats.lastProviderState` é nulo ou inválido | Verifique a linha do chat no DB e logs `[continuation][clear]`                 |
| `cursor_expired` no meio do turno com tools | Cursor expirou durante execução de tools     | Handler de erro de cursor em `responses-stream.ts` ou `interactions-stream.ts` |
| Mismatch de provedor em toda troca          | `lastProviderState` guarda provedor antigo   | Esperado: o primeiro turno após trocar sempre degrada                          |
| Modelo errado foi chamado                   | `resolve-model.ts` escolheu outro modelo     | Verifique `modelId` no topo de `stream-text-turn.ts`                           |
| Replay envia mensagens erradas              | `replay-builder.ts` formatou incorretamente  | Testes unitários em `tests/unit/services/providers/replay-builder.test.ts`     |
| `stateless-loop` vazando entre turnos       | `loopMessages` persistido como durável       | Filtro `decideTurnPersistence`; deve retornar `null` para modos stateless      |

---

## Decisão Central De Design: Estado Em Chats Vs Mensagens

O sistema diverge explicitamente de uma abordagem ingênua onde o `providerState` da mensagem mais recente é usado para continuação. Isso é intencional:

- `chats.lastProviderState` é **reativo** — é atualizado atomicamente com a conclusão do turno e nunca referencia um cursor substituído.
- `messages.providerState` é **imutável** — registra como o cursor estava quando a mensagem foi criada, para depuração e trilha de auditoria.

Misturar os dois criaria edge cases em que um cursor de uma cadeia de mensagens deletada ou substituída seria ressuscitado, levando a erros do provedor.
