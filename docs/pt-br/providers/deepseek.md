# Provedor DeepSeek

O DeepSeek é modelado como um provedor de primeira classe, e não apenas como um connector OpenAI-compatible, para expor capacidades específicas do DeepSeek, como tokens de reasoning, prefix caching e continuação local ao turno.

## Tipo De Provedor

- **Provider ID:** `deepseek`
- **Base URL:** `https://api.deepseek.com` (configurável)
- **SDK:** `@ai-sdk/deepseek` (Vercel AI SDK)
- **Formato wire:** API OpenAI Chat Completions

## Estratégia De Continuação

O DeepSeek usa continuação **turn-local**, sem cursor durável:

1. **Todo turno do usuário começa do zero** — Replay completo do histórico persistido em toda request. Não existe `previous_response_id` nem `previous_interaction_id`.
2. **Estado local ao turno** — `DeepSeekTurNLoopState` acumula `loopMessages` durante as iterações de tool call.
3. **Sem estado cross-turn** — `loopMessages` é filtrado por `decideTurnPersistence` e nunca é salvo em `chats.lastProviderState`.
4. **Prefixo estável** — Prompt de sistema, definições de tools em ordem determinística e histórico persistido mantêm um prefixo estável entre turnos para maximizar cache hits.

## Reasoning / Thinking

O DeepSeek suporta modos de thinking pelos modelos `deepseek-reasoner` e `deepseek-v4-*`.

### Ciclo de vida de `reasoning_content`

1. **Durante o streaming** — Eventos `reasoning_delta` são emitidos enquanto o modelo pensa.
2. **Nos loops de tools** — O `reasoning_content` acumulado **precisa** ser incluído na mensagem do assistente devolvida ao provedor na iteração seguinte. Omitir isso causa erros HTTP 400. `message-mapper.ts` passa esse campo explicitamente ao construir loop messages.
3. **Após a conclusão do turno** — `reasoning_content` é removido da mensagem final quando não há tool calls pendentes. Nunca é persistido em `messages.content` nem carregado entre turnos do usuário, preservando a estabilidade do prefixo para cache hits.

### Mapeamento De `ReasoningEffort`

| Valor Mango | Valor na API DeepSeek |
| ----------- | --------------------- |
| `low`       | `high`                |
| `medium`    | `high`                |
| `high`      | `high`                |
| `xhigh`     | `max`                 |
| `max`       | `max`                 |

A API do DeepSeek suporta apenas dois níveis de esforço. `low`, `medium` e `high` são todos mapeados para `high`.

### System Prompt

Quando thinking está habilitado, uma instrução de idioma é anexada ao prompt de sistema:

```
Write reasoning in the same language as the user message.
```

## Prompt Caching

O DeepSeek suporta prompt caching automático. Comportamento do cache:

- **Todos os modelos** reportam `promptCaching: true` no catálogo.
- Métricas de cache como `promptCacheHitTokens` e `promptCacheMissTokens` são capturadas do objeto `usage` na resposta de streaming.
- Essas métricas são armazenadas nos metadados do provider state para observabilidade.
- A estratégia de **prefixo estável** mantém prompt de sistema + definições de tools + histórico persistido consistentes entre turnos para maximizar cache hit rate.

## Tool Calling

Tool calling é suportado apenas nos modelos `deepseek-v4-flash` e `deepseek-v4-pro`.

- Tools são mapeadas para o formato `ChatCompletionTool[]`.
- Definições de tools incluem `tool_choice: 'auto'` quando tools estão disponíveis.
- `reasoning_content` é preservado nas mensagens do loop de tools.

## Catálogo De Modelos

**Dinâmico:** carregado do endpoint `/models` do DeepSeek com timeout de 5 segundos.

**Fallback** quando a API está indisponível:

- `deepseek-v4-flash`
- `deepseek-v4-pro`
- `deepseek-chat` (legado)
- `deepseek-reasoner` (legado)

Modelos são filtrados para excluir embeddings, TTS e whisper.

### Capacidades Dos Modelos

| Modelo              | Tools | Reasoning | Prompt caching |
| ------------------- | ----- | --------- | -------------- |
| `deepseek-v4-flash` | Sim   | Sim       | Sim            |
| `deepseek-v4-pro`   | Sim   | Sim       | Sim            |
| `deepseek-chat`     | Não   | Não       | Sim            |
| `deepseek-reasoner` | Não   | Sim       | Sim            |

## Validação Da Base URL

Antes de qualquer chamada à API, a base URL é validada contra endereços privados e loopback por `validateBaseUrl`. Isso evita ataques SSRF por meio de base URLs configuradas pelo usuário.

## Comparação Com OpenAI-compatible

| Aspecto             | DeepSeek                        | OpenAI-compatible            |
| ------------------- | ------------------------------- | ---------------------------- |
| Tipo de provedor    | `deepseek` de primeira classe   | `openai-compatible` genérico |
| Tokens de reasoning | campo `reasoning_content`       | depende do endpoint          |
| Prompt caching      | nativo, com métricas capturadas | depende do endpoint          |
| Continuação         | local ao turno                  | local ao turno               |
| Catálogo de modelos | API do DeepSeek                 | por endpoint                 |
| Suporte a tools     | apenas modelos v4               | depende do endpoint          |
