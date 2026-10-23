# Streaming Architecture

Chat responses are delivered via Server-Sent Events (SSE) over a single HTTP connection. The frontend consumes the stream using the Fetch API's `ReadableStream` and maps events to UI updates.

## SSE Event Catalog

`StreamChunk` is the public discriminated union in [`streaming/schemas.ts`](../../apps/shared/src/streaming/schemas.ts). The table covers internal chat turns; external-agent events are listed below:

| Event                                               | Direction       | Purpose                                      |
| --------------------------------------------------- | --------------- | -------------------------------------------- |
| `user_message_id`                                   | Server → Client | Persisted user message ID for the turn       |
| `assistant_message_id`                              | Server → Client | Persisted assistant message ID               |
| `thinking_start`                                    | Server → Client | Model begins reasoning/thinking              |
| `thinking`                                          | Server → Client | Reasoning token deltas                       |
| `text`                                              | Server → Client | Text deltas from the model                   |
| `tool_call_started`                                 | Server → Client | Model begins a tool call                     |
| `tool_call_completed`                               | Server → Client | Tool call arguments fully received           |
| `tool_result`                                       | Server → Client | Tool execution result                        |
| `tool_execution`                                    | Server → Client | Full execution lifecycle snapshot            |
| `subagent_started`                                  | Server → Client | Subagent delegation began                    |
| `subagent_text`                                     | Server → Client | Subagent text deltas                         |
| `subagent_tool_call_started`                        | Server → Client | Subagent began a nested tool call            |
| `subagent_completed`                                | Server → Client | Subagent finished successfully               |
| `subagent_failed`                                   | Server → Client | Subagent failed                              |
| `image_generation_started`                          | Server → Client | Image generation began (via tool)            |
| `image_generation_completed`                        | Server → Client | Image generated successfully                 |
| `image_generation_failed`                           | Server → Client | Image generation failed                      |
| `mcp_media`                                         | Server → Client | MCP tool produced persisted rich media       |
| `question`                                          | Server → Client | Structured questions for the user            |
| `mcp_elicitation_request`, `mcp_elicitation_status` | Server → Client | MCP user-input request and resolution        |
| `todo_update`                                       | Server → Client | Chat todo list replaced                      |
| `context_info`                                      | Server → Client | Token usage and context window status        |
| `fallback_notice`                                   | Server → Client | Continuation degradation notification        |
| `continuation_transition`                           | Server → Client | Continuation mode transition                 |
| `system_event`                                      | Server → Client | Timeline markers (e.g., tool loop exhausted) |
| `done`                                              | Server → Client | Turn completed                               |
| `error`                                             | Server → Client | Fatal error                                  |

External turns use `external_session_started`, `external_text`,
`external_reasoning_started`, `external_reasoning`, `external_reasoning_ended`,
`external_activity_started`, `external_activity_updated`, `external_activity_completed`,
`external_approval_request`, `external_approval_status`, `external_usage`,
`external_thread_usage`, `external_commands`, `external_account_limits`, `external_steer`,
`external_error`, `external_notice` and `external_turn_completed`. Their payloads and bounds live in the same schema. `external_turn_completed` and `external_error` have `done: false`; the enclosing stream still ends with `done` or terminal `error`.

## Event Lifecycle

A typical turn with tool calling:

```
user_message_id
assistant_message_id
thinking_start
thinking (deltas...)
tool_call_started
tool_call_completed
tool_result (one per tool call)
text (deltas...)
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

data: {"type":"done","done":true}
```

- Each event is framed as `data: <JSON>\n\n`.
- A keepalive comment (`: keepalive\n\n`) is sent every 5 seconds on `/api/respond/stream` (internal and external turns), using `generation/application/sse-keepalive.ts`. The general `lib/sse-stream.ts` helper used by other SSE routes uses 15 seconds to prevent proxy timeouts.
- Every event carries a `done` field; the final event has `done: true`.
- Events are terminated by a double newline.

## Server-Side Implementation

### Route (`respond-stream-routes.ts`)

`POST /api/respond/stream` with body validated by `RespondStreamBodySchema`:

```typescript
import type { RespondStreamBody } from '@mangostudio/shared/generation';

const request: RespondStreamBody = {
  chatId: 'chat-id',
  prompt: 'Hello',
  // model: '<configured model ID>',
  // toolIntent: 'image_generation_requested',
};
```

Required fields are `chatId` and `prompt`. Optional fields are `attachmentIds`, `model`, `systemPrompt`, `promptSettings`, `thinkingEnabled`, `reasoningEffort`, `thinkingVisibility`, `maxToolIterations`, `contextSettings`, `toolIntent`, `agentId`, `externalTurn` and `recovery`. Use [`RespondStreamBodySchema`](../../apps/shared/src/generation/schemas.ts) for nested shapes and bounds. `toolIntent`, when present, is the literal `image_generation_requested`.

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
   - Maps provider events to public wire events in `stream-text-turn-stages.ts`; internal `tool_call_arguments_delta` and `assistant_text_delta` are not public wire types.
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
  body: JSON.stringify(request), // RespondStreamBody
  credentials: 'include',
  signal,
});
if (!response.ok) throw new Error(`HTTP ${response.status}`);
if (!response.body) throw new Error('Missing response body');

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let terminal = false;

try {
  while (true) {
    const { done, value } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

    // Keep partial frames (including split data prefixes/JSON) for the next read.
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(buffer)) !== null) {
      const frame = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const data = frame.split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data) continue; // Ignore comment-only keepalive frames.
      const chunk = JSON.parse(data); // StreamChunk; validate untrusted peers.
      onChunk(chunk);
      terminal ||= chunk.done === true; // Both done and error can terminate a turn.
    }

    if (done) break;
  }
  // An incomplete frame at EOF is never dispatched.
  if (!terminal) throw new Error('Stream ended before a terminal event');
} finally {
  reader.releaseLock();
}
```

This teaching example consumes complete SSE frames and reports missing terminal events at EOF. It is tested directly from both guides with whole frames, split prefixes, split JSON/UTF-8 and CRLF. The production parser in `generation-service.ts` already keeps a persistent line buffer; this sample correction does not diagnose production disconnects.

### Hook (`use-chat-stream.ts`)

React hook managing stream lifecycle:

- `isGenerating` / `setIsGenerating` — Loading state toggle.
- `handleStop()` — Aborts the stream via `AbortController`.
- `contextInfo` / `fallbackNotice` — Tracked state for context/degradation notifications.
- `contextCache` — Cross-chat context info cache.

## Error Handling

- **Pre-flight errors** — Return standard HTTP error responses (JSON) with typed error codes.
- **Stream errors** — `SSEErrorEvent` with `done: true`: `{ type: 'error', error: string, done: true }`. An external agent that could not start may add `unavailableReason`, `remedy` and, for an outdated agent, `requiredVersion`, and `code` for a failed open, which is the runtime's `external_agent_*` kind (the session cap has its own copy on the client; the others show the kind as plain text beside the sentence) (see "A send refused while the session opens" in `docs/architecture/external-agents.md`); `error` stays the English fallback.
- **Connection loss** — The frontend detects `reader.read()` returning `done: true` without a prior `done` event and surfaces a fallback error.
- **Abort** — User-triggered stop sends `AbortSignal`, server cleans up via the `AbortController` passed to the generator.

## Continuation Events

See [`continuation.md`](./continuation.md) for the full continuation architecture. Key streaming events:

- **`fallback_notice`** — Emitted when continuation degrades (provider/model/prompt changed, cursor expired). The frontend shows a toast notification.
- **`continuation_transition`** — Persisted in message parts. Carries `recovered: false` during the turn and is flipped to `recovered: true` on success.
- **`context_info`** — Token usage ratio and severity. The frontend updates the context ring and potentially shows the compaction callout.
