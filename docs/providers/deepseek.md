# DeepSeek Provider

DeepSeek is modeled as a first-class provider (not just an OpenAI-compatible connector) to surface DeepSeek-specific capabilities: reasoning tokens, prefix caching, and turn-local continuation.

## Provider Type

- **Provider ID:** `deepseek`
- **Base URL:** `https://api.deepseek.com` (configurable)
- **SDK:** `@ai-sdk/deepseek` (Vercel AI SDK)
- **Wire format:** OpenAI Chat Completions API

## Continuation Strategy

DeepSeek uses **turn-local** continuation (no durable cursor):

1. **Every user turn starts fresh** — Full DB history replay on every request. No `previous_response_id` or `previous_interaction_id`.
2. **In-turn loop state** — `DeepSeekTurNLoopState` accumulates `loopMessages` during tool-call iterations.
3. **No cross-turn state** — `loopMessages` are filtered out by `decideTurnPersistence` and never stored in `chats.lastProviderState`.
4. **Stable prefix** — System prompt, tool definitions (deterministic sorted order), and persisted history maintain a stable request prefix across turns to maximize cache hits.

## Reasoning / Thinking

DeepSeek supports thinking modes via the `deepseek-reasoner` and `deepseek-v4-*` models.

### `reasoning_content` Lifecycle

1. **During streaming** — `reasoning_delta` events are yielded as the model thinks.
2. **In tool loops** — Accumulated `reasoning_content` MUST be included in the assistant loop message sent back to the provider on the next iteration. Omitting it causes HTTP 400 errors. The `message-mapper.ts` explicitly passes `reasoning_content` when building loop messages.
3. **After turn completion** — `reasoning_content` is stripped from the final message (when no pending tool calls remain). It is never persisted to `messages.content` or carried across user turns. This preserves prompt prefix stability for cache hits.

### Reasoning Effort Mapping

| Mango Value | DeepSeek API Value |
| ----------- | ------------------ |
| `low`       | `high`             |
| `medium`    | `high`             |
| `high`      | `high`             |
| `xhigh`     | `max`              |
| `max`       | `max`              |

DeepSeek's API supports only two effort levels. Low/medium/high are all mapped to `high`.

### System Prompt

When thinking is enabled, a language instruction is appended to the system prompt:

```
Write reasoning in the same language as the user message.
```

## Prompt Caching

DeepSeek supports automatic prompt caching. Cache behavior:

- **All models** report `promptCaching: true` in the catalog.
- Cache metrics (`promptCacheHitTokens`, `promptCacheMissTokens`) are captured from the `usage` object in the streaming response.
- Metrics are stored in provider state metadata for observability.
- **Stable prefix** strategy: system prompt + tool definitions (sorted) + persisted history maintain a consistent prefix to maximize cache hit rates.

## Tool Calling

Tool calling is supported on `deepseek-v4-flash` and `deepseek-v4-pro` models only.

- Tools are mapped to `ChatCompletionTool[]` format.
- Tool definitions include `tool_choice: 'auto'` when tools are provided.
- `reasoning_content` is preserved in tool loop messages (see above).

## Model Catalog

**Dynamic:** Fetched from DeepSeek's `/models` endpoint (5s timeout).

**Fallback** (when API is unreachable):

- `deepseek-v4-flash`
- `deepseek-v4-pro`
- `deepseek-chat` (legacy)
- `deepseek-reasoner` (legacy)

Models are filtered to exclude embeddings, TTS, and whisper models.

### Model Capabilities

| Model               | Tools | Reasoning | Prompt Caching |
| ------------------- | ----- | --------- | -------------- |
| `deepseek-v4-flash` | Yes   | Yes       | Yes            |
| `deepseek-v4-pro`   | Yes   | Yes       | Yes            |
| `deepseek-chat`     | No    | No        | Yes            |
| `deepseek-reasoner` | No    | Yes       | Yes            |

## Base URL Validation

Before any API call, the base URL is validated against private/loopback addresses (`validateBaseUrl`). This prevents SSRF attacks through user-configured base URLs.

## Comparison with OpenAI-compatible

| Aspect           | DeepSeek                  | OpenAI-compatible           |
| ---------------- | ------------------------- | --------------------------- |
| Provider type    | First-class `deepseek`    | Generic `openai-compatible` |
| Reasoning tokens | `reasoning_content` field | Depends on endpoint         |
| Prompt caching   | Native, metrics captured  | Depends on endpoint         |
| Continuation     | Turn-local                | Turn-local                  |
| Model catalog    | DeepSeek API              | Per-endpoint                |
| Tool support     | v4 models only            | Depends on endpoint         |
