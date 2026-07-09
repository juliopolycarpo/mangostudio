# Streaming Architecture

Chat responses are delivered via Server-Sent Events (SSE) over a single HTTP connection. The frontend consumes the stream using the Fetch API's `ReadableStream` and maps events to UI updates.

## SSE Event Catalog

All events extend `StreamChunk`, a discriminated union on `type`:

| Event                        | Direction       | Purpose                                      |
| ---------------------------- | --------------- | -------------------------------------------- |
| `user_message_id`            | Server → Client | Persisted user message ID for the turn       |
| `thinking_start`             | Server → Client | Model begins reasoning/thinking              |
| `thinking`                   | Server → Client | Reasoning token deltas                       |
| `text`                       | Server → Client | Text deltas from the model                   |
| `tool_call_started`          | Server → Client | Model begins a tool call                     |
| `tool_call_completed`        | Server → Client | Tool call arguments fully received           |
| `tool_result`                | Server → Client | Tool execution result                        |
| `subagent_started`           | Server → Client | Subagent delegation began                    |
| `subagent_text`              | Server → Client | Subagent text deltas                         |
| `subagent_tool_call_started` | Server → Client | Subagent began a nested tool call            |
| `subagent_completed`         | Server → Client | Subagent finished successfully               |
| `subagent_failed`            | Server → Client | Subagent failed                              |
| `image_generation_started`   | Server → Client | Image generation began (via tool)            |
| `image_generation_completed` | Server → Client | Image generated successfully                 |
| `image_generation_failed`    | Server → Client | Image generation failed                      |
| `mcp_media`                  | Server → Client | MCP tool produced persisted rich media       |
| `question`                   | Server → Client | Structured questions for the user            |
| `todo_update`                | Server → Client | Chat todo list replaced                      |
| `context_info`               | Server → Client | Token usage and context window status        |
| `fallback_notice`            | Server → Client | Continuation degradation notification        |
| `continuation_transition`    | Server → Client | Continuation mode transition                 |
| `system_event`               | Server → Client | Timeline markers (e.g., tool loop exhausted) |
| `done`                       | Server → Client | Turn completed                               |
| `error`                      | Server → Client | Fatal error                                  |

## Event Lifecycle

A typical turn with tool calling:

```
user_message_id
thinking_start
thinking (deltas...)
tool_call_started
  tool_call_arguments_delta (deltas...)
tool_call_completed
tool_result (one per tool call)
  assistant_text_delta (deltas...)
context_info
done
```

If continuation degrades (e.g., provider or model changed):

```
fallback_notice
continuation_transition (recovered: false)
  ... normal events ...
continuation_transition (recovered: true)
done
```

## SSE Wire Format

```
: keepalive

data: {"type":"user_message_id","messageId":"msg_abc123","done":false}

data: {"type":"text","text":"Hello","done":false}

data: {"type":"done","messageId":"msg_def456","done":true}
```

- Each event is framed as `data: <JSON>\n\n`.
- A keepalive comment (`: keepalive\n\n`) is sent every 15 seconds to prevent proxy timeouts.
- Every event carries a `done` field; the final event has `done: true`.
- Events are terminated by a double newline.

## Server-Side Implementation

### Route (`respond-stream-routes.ts`)

`POST /api/respond/stream` with body validated by `RespondStreamBodySchema`:

```typescript
{
  chatId: string;
  prompt: string;
  thinkingEnabled?: boolean;
  reasoningEffort?: string;
  toolIntent?: boolean;
  modelId?: string;
  attachmentIds?: string[];
}
```

**Pre-flight checks** (return HTTP errors before SSE headers):

1. Chat ownership verification → 404.
2. Content validity (non-empty prompt, available attachments) → 400.
3. Model resolution (provider exists, model available) → 503/400.

**SSE response** sets headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`.

### Orchestrator (`stream-text-turn.ts`)

The main async generator that drives the turn:

1. **Setup** — Persists user message, resolves model/provider, composes prompt rules.
2. **Continuation decision** — Checks `chats.lastProviderState` to decide cursor-based vs replay continuation.
3. **Agent loop** — Calls `provider.generateAgentTurnStream()` in iterations:
   - Forwards all provider events as SSE events.
   - On tool calls: executes tools, feeds results back.
   - On `turn_completed`: computes context snapshot, persists state, yields `done`.
4. **Fallback** — If the provider does not support agentic streaming, falls back to `generateTextStream()` or `generateText()`.

## Frontend Consumption

### Service Layer (`generation-service.ts`)

Raw `fetch`-based streaming using `ReadableStream`:

```typescript
const response = await fetch('/api/respond/stream', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(request),
  credentials: 'include',
  signal, // AbortSignal for cancellation
});

const reader = response.body!.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  const text = decoder.decode(value, { stream: true });
  // Split on \n, parse lines starting with "data: "
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      const chunk = JSON.parse(line.slice(6));
      onChunk(chunk); // StreamChunk
    }
  }
}
```

### Hook (`use-chat-stream.ts`)

React hook managing stream lifecycle:

- `isGenerating` / `setIsGenerating` — Loading state toggle.
- `handleStop()` — Aborts the stream via `AbortController`.
- `contextInfo` / `fallbackNotice` — Tracked state for context/degradation notifications.
- `contextCache` — Cross-chat context info cache.

## Error Handling

- **Pre-flight errors** — Return standard HTTP error responses (JSON) with typed error codes.
- **Stream errors** — `SSEErrorEvent` with `done: true`: `{ type: 'error', error: string, done: true }`.
- **Connection loss** — The frontend detects `reader.read()` returning `done: true` without a prior `done` event and surfaces a fallback error.
- **Abort** — User-triggered stop sends `AbortSignal`, server cleans up via the `AbortController` passed to the generator.

## Continuation Events

See [`continuation.md`](./continuation.md) for the full continuation architecture. Key streaming events:

- **`fallback_notice`** — Emitted when continuation degrades (provider/model/prompt changed, cursor expired). The frontend shows a toast notification.
- **`continuation_transition`** — Persisted in message parts. Carries `recovered: false` during the turn and is flipped to `recovered: true` on success.
- **`context_info`** — Token usage ratio and severity. The frontend updates the context ring and potentially shows the compaction callout.
