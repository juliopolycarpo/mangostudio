# Provider Development Guide

## Checklist for Adding a Provider

1. Register the provider type in `apps/shared/src/types/provider.ts`
2. Add the provider class implementing `AIProvider` in
   `apps/api/src/services/providers/`
3. Register the provider in `apps/api/src/services/providers/core/provider-registry.ts`
4. Implement `generateAgentTurnStream` for agentic (tool-calling) flows
5. Add capability flags to `ModelInfo` (especially `statefulContinuation`)
6. Add continuation strategy to `CONTINUATION_STRATEGIES` in
   `continuation-runtime.ts`
7. Write the replay builder in `replay-builder.ts`
8. Add model context limits in `context-policy.ts`
9. Write tests (see "Required Tests" below)

---

## Required Provider Methods and Capability Flags

Every provider must implement the `AIProvider` interface
(`apps/api/src/services/providers/types.ts`):

| Method                    | Required | Purpose                                 |
| ------------------------- | -------- | --------------------------------------- |
| `generateText`            | yes      | Single-turn text generation             |
| `generateTextStream`      | no       | Simple text streaming (no tool loop)    |
| `generateImage`           | no       | Image generation                        |
| `generateAgentTurnStream` | no       | **Full agentic turn** with tool calling |
| `listModels`              | yes      | Model catalog                           |
| `validateApiKey`          | yes      | Key validation                          |
| `resolveApiKey`           | yes      | Key resolution                          |

The capability flags in `ModelInfo.capabilities` determine how the
orchestrator selects the provider path in `stream-text-turn.ts`:

```typescript
capabilities: {
  text: true,             // supports text generation
  streaming: true,        // supports streaming
  tools: true,            // supports tool calling
  statefulContinuation: true, // has durable cursor
  structuredOutput: true, // supports JSON Schema constraint
}
```

DeepSeek is modeled as a first-class provider rather than an
OpenAI-compatible connector. It still uses the AI SDK runtime surface, but the
separate provider type lets the catalog report DeepSeek-specific reasoning,
tool, caching, and continuation capabilities without changing generic
OpenAI-compatible behavior.

Cursor is also a first-class provider, but it is an **adapter** over the local
`@cursor/sdk` agent runtime rather than a chat-completions wrapper. It implements
`generateAgentTurnStream` via a Node.js sidecar (the Bun API never imports the
SDK). See [docs/providers/cursor.md](cursor.md) for sidecar RPC, workspace
configuration, and packaging.

---

## How to Decide Continuation Mode

Add an entry to `CONTINUATION_STRATEGIES` in
`continuation-runtime.ts`:

```typescript
'your-provider': {
  provider: 'your-provider',
  strategy: 'durable-cursor' | 'replay' | 'turn-local',
  supportsDurableCursor: true | false,
  durableMode: 'responses' | 'interactions' | null,
},
```

- **durable-cursor**: Provider has a server-side cursor (like
  `previous_response_id`). Set `durableMode` to the wire mode name.
- **replay**: Provider is stateless between turns. No durable mode.
  Example: OpenAI-compatible Chat Completions.
- **turn-local**: Provider accumulates state within a single tool loop
  but has no cross-turn cursor. Example: Anthropic Messages.

---

## How to Build Replay Safely

Replay is the fallback path used when no durable cursor is available. Each
provider format lives in `replay-builder.ts`.

### Rules

1. **Exclude thinking/error parts** — Models don't need their own prior
   reasoning tokens in replay input. Error parts are UI artifacts.

2. **User turns emit plain text** — User messages don't have structured
   parts; they always fold to `{ role: 'user', content: text }`.

3. **AI turns reconstruct from parts** — Iterate `turn.parts` and filter
   by type: `text`, `tool_call`, `tool_result`.

4. **Tool results go after the call that triggered them** — The order is:
   assistant text → tool call → tool result. This matches what providers
   expect in a multi-turn tool-calling conversation.

5. **Fall back to plain text** — If `turn.parts` is empty or absent, emit
   `{ role: assistant|user, content: turn.text }`. This maintains
   backward compatibility with messages persisted before the parts system.

### Provider-specific replay format

| Provider            | Replay function                 | Output shape                                                                     |
| ------------------- | ------------------------------- | -------------------------------------------------------------------------------- |
| OpenAI Responses    | `buildOpenAIResponsesReplay`    | Array of `ResponseInputItem` (role-based + function_call / function_call_output) |
| ChatGPT             | `buildOpenAIResponsesReplay`    | Responses input plus turn-local reasoning/function-call loop items               |
| Gemini Interactions | `buildGeminiInteractionsReplay` | Array of turn objects (role + content, function_call, function_result)           |
| OpenAI-compatible   | `buildChatCompletionsReplay`    | `ChatCompletionMessageParam[]` (with `tool_calls` array)                         |
| DeepSeek            | `buildChatCompletionsReplay`    | `ChatCompletionMessageParam[]` (with `reasoning_content` in tool loop messages)  |
| Anthropic           | direct in `stream.ts`           | `MessageParam[]` (history-derived, no replay builder)                            |

---

## How to Emit `AgentEvent` Items

The `generateAgentTurnStream` method yields `AgentEvent` items
(`apps/shared/src/types/agent-events.ts`).

### Required sequence

```
for each turn iteration:
  reasoning_delta*          // thinking/reasoning tokens (optional)
  tool_call_started         // for each tool call the model makes
  tool_call_arguments_delta* // streaming tool arguments
  tool_call_completed       // when a tool call is fully received
  assistant_text_delta*     // text content streaming
  continuation_degraded?    // only on cursor loss mid-turn
  turn_completed            // MUST be the last event on success
  turn_error                // MUST be the last event on failure (instead of turn_completed)
```

### State on `turn_completed`

Serialise a `ContinuationEnvelope` into `providerState`:

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
    cursor: newResponseId,      // only for durable modes
    context: {
      providerReportedInputTokens: usageInputTokens,
      contextLimit: getModelContextLimit(req.modelName),
      lastUpdatedAt: Date.now(),
    },
  }),
};
```

For turn-local providers (stateless-loop), include `loopMessages` in the
envelope instead of a `cursor`:

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
    loopMessages: newLoopMessages,  // accumulated in-memory messages
  }),
};
```

---

## How to Handle Tool Calls

The tool loop is orchestrated by `stream-text-turn.ts`, not by individual
providers. Providers only need to:

1. **Declare tools** — Map `ToolDefinition[]` to provider wire format in
   `core/tool-mapper.ts`.

2. **Stream tool call deltas** — Emit `tool_call_started` when a tool call
   begins, `tool_call_arguments_delta` while arguments arrive, and
   `tool_call_completed` when arguments are fully received.

3. **Return tool results on the next iteration** — When the orchestrator
   sees `turn_completed` with pending tool calls, it executes the tools and
   calls `generateAgentTurnStream` again with the results in
   `req.toolResults`.

### Tool result feed pattern

```typescript
// First iteration: model calls tools
// Orchestrator executes tools, builds toolResults
// Second iteration: provider receives toolResults in request
if (req.toolResults && req.toolResults.length > 0) {
  // Feed tool results to the provider-specific format
}
```

---

## How to Report Usage and Context

After each turn, the envelope carries context metrics:

```typescript
context: {
  // Provider-reported input tokens (preferred over local estimate)
  providerReportedInputTokens: number | undefined,
  // Model's maximum input context window
  contextLimit: number,
  // Timestamp when this envelope was created
  lastUpdatedAt: number,
}
```

The orchestrator in `stream-text-turn.ts` uses these values to:

- Compute `estimatedUsageRatio` — shown in the frontend context widget
- Trigger compaction warnings when approaching the context limit
- Persist `chats.lastContextState` for cross-session display

---

## Required Tests

### Continuation unit tests (`continuation.test.ts`)

Test the decision engine for:

- Envelope parsing (valid, malformed, null, wrong schema version)
- Envelope validation (provider, model, system prompt, toolset mismatches)
- `decideContinuation` returns `continue_with_cursor` for valid durable
  envelopes
- `decideContinuation` returns `degrade_to_replay` on provider/model/prompt/
  toolset mismatch
- `decideContinuation` returns `start_replay` when no state exists
- `decideContinuation` returns `start_replay` for stateless-loop envelopes
- `decideTurnPersistence` filters out stateless-loop envelopes
- `decideTurnPersistence` persists durable cursor envelopes
- Provider switch: OpenAI→Gemini degrades on first turn, Gemini cursor
  used on second

### Replay builder tests (`replay-builder.test.ts`)

Test replay construction for each provider:

- Full history with text and tool call parts
- Empty history (no messages)
- Turn with text only (no tool calls)
- Backward compatibility: plain text without parts
- Tool results placed after their corresponding tool calls

### Provider-specific tests

For each provider's `generateAgentTurnStream`:

- First turn with no cursor → full replay
- Cursor-based continuation → minimal input
- Tool result feed → correct wire format
- Cursor loss with no tool results → retry with replay
- Cursor loss with tool results → abort with `tool_result_cursor_loss`
- `turn_error` on API failure

### Cursor-loss handler test pattern

Test both safe and unsafe cursor-loss scenarios:

```typescript
// Safe: cursor loss with no pending tool results
// Expected: emit continuation_degraded → replay with full history

// Unsafe: cursor loss with pending tool results
// Expected: emit continuation_degraded → emit turn_error → do NOT retry
```
