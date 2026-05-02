# Continuation Architecture

## What Continuation Means

Continuation is the mechanism that lets a multi-turn conversation preserve
context across separate user interactions without resending the entire chat
history on every request.

Each time the user sends a message, MangoStudio must decide how to present
the conversation to the provider. The three strategies are:

| Strategy            | Provider examples                                   | Trade-off                                                                                   |
| ------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Durable cursor**  | OpenAI Responses, Gemini Interactions               | One wire ID per turn. Cheap but fragile — cursor goes stale if the provider invalidates it. |
| **Replay**          | OpenAI-compatible Chat Completions                  | Resend full history every turn. Robust but expensive at high token counts.                  |
| **Turn-local loop** | Anthropic Messages, openai-compatible within a turn | Accumulates in-memory within a single request. Never persisted across turns.                |

The decision is made once per turn, before the first provider call, and
cannot change mid-turn.

---

## Three State Concepts

The architecture separates state into three distinct concerns that must never
be mixed.

### 1. Durable cursor state (`chats.lastProviderState`)

Persisted on the `chats` table after each completed turn. Carries the
`ContinuationEnvelope` (a typed, versioned wrapper) from the provider that
executed the last successful turn.

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

Only **durable** envelopes (modes `responses` or `interactions`) with a
valid cursor are stored here. Stateless-loop (turn-local) envelopes are
filtered out by `decideTurnPersistence` — they never touch the database.

The `chats.lastProviderState` is the **exclusive** source of cross-turn
continuation. Message-level `providerState` is never read for continuation
(see below).

### 2. Turn-local loop state (`providerState` within a single request)

Providers that don't support durable cursors (Anthropic, openai-compatible)
accumulate accumulated messages in `providerState` during the tool-call loop.

This state is carried between iterations of the same agent turn but is
**never persisted** as `chats.lastProviderState`. The orchestrator in
`stream-text-turn.ts` sends the state back to the provider on each loop
iteration, and `decideTurnPersistence` discards it when saving.

```json
{
  "provider": "openai-compatible",
  "mode": "stateless-loop",
  "loopMessages": [
    /* … */
  ]
}
```

### 3. Message audit state (`messages.providerState`)

Each persisted message carries an optional `providerState` field that stores
the envelope at the time the message was created. This is **audit-only** and
**must never** be used for continuation.

Why:

- A message's `providerState` reflects the state at the time the turn ran,
  which may have been superseded by subsequent turns.
- Using stale cursors can resurrect provider-internal state that the provider
  has since invalidated, causing hard-to-diagnose 404s and data corruption.

The orchestrator reads exclusively from `chats.lastProviderState` (line
130-135 of `stream-text-turn.ts`).

---

## Provider Matrix

| Provider              | Durable cursor | Wire field                | Replay builder                           | Cross-turn state (`chats.lastProviderState`) | Turn-local state                |
| --------------------- | -------------- | ------------------------- | ---------------------------------------- | -------------------------------------------- | ------------------------------- |
| OpenAI (Responses)    | yes            | `previous_response_id`    | `buildOpenAIResponsesReplay`             | `ContinuationEnvelope` (mode `responses`)    | tool results in current request |
| Gemini (Interactions) | yes            | `previous_interaction_id` | `buildGeminiInteractionsReplay`          | `ContinuationEnvelope` (mode `interactions`) | tool results in current request |
| OpenAI-compatible     | no             | none                      | `buildChatCompletionsReplay`             | none (always starts fresh)                   | `loopMessages` only             |
| Anthropic             | no             | none                      | direct Messages replay (history-derived) | none (always starts fresh)                   | `loopMessages` only             |
| DeepSeek              | no             | none                      | `buildChatCompletionsReplay`             | none (always starts fresh)                   | `loopMessages` only             |

Source files:

- `continuation-envelope.ts` — envelope schema, parse, validate, serialize
- `continuation-runtime.ts` — decision logic, turn persistence filter
- `replay-builder.ts` — replay implementations for each provider

---

## Fallback Lifecycle

The fallback lifecycle has four phases.

1. **Validation** — `decideContinuation` checks the persisted envelope
   against the current turn context (provider, model, system prompt hash,
   toolset hash). If anything changed, the turn degrades.

2. **Degradation** — A `continuation_degraded` event is emitted with the
   reason code: `provider_changed`, `model_changed`, `system_prompt_changed`,
   `toolset_changed`, `cursor_expired`, `cursor_invalid`, or
   `envelope_malformed`. The orchestrator emits both `fallback_notice` (SSE)
   and `continuation_transition` (persisted in message parts).

3. **Replay** — The provider request sends the full DB history instead of a
   cursor. All providers implement this path via their replay builder.

4. **Recovery** — After a successful replay turn, the provider mints a new
   cursor (for stateful providers). Subsequent turns resume cursor-based
   continuation.

### Cursor-loss during active tool loop

When a cursor expires mid-turn (between tool iterations), the safety
constraint is:

- If the current iteration already has `toolResults` (in-flight tool
  results), the turn **aborts** with reason
  `tool_result_cursor_loss`. Replaying from history would silently drop
  unpersisted tool results, producing a wrong response.
- If the current iteration has no tool results, the provider retries with a
  full replay.

This logic lives in `responses-stream.ts` (lines 326-383) and
`interactions-stream.ts` (lines 200-260).

---

## Timeline Events and User Visibility

Continuation degradation events are surfaced through two channels:

| Channel                 | Type                      | Purpose                                 |
| ----------------------- | ------------------------- | --------------------------------------- |
| SSE (real-time)         | `fallback_notice`         | Frontend toast / status indicator       |
| Persisted message parts | `continuation_transition` | Chat history review shows what happened |
| Logs                    | `console.warn`            | Operator debugging                      |

The `continuation_transition` part carries `recovered: false` during the
turn and is flipped to `recovered: true` when the turn completes
successfully (`stream-text-turn.ts` lines 534-539).

---

## Context Snapshots and Compaction

After each turn completes, the orchestrator computes a `ContextSnapshot`
that describes the input token usage:

- `estimatedInputTokens` — local estimate (~4 chars/token) or
  provider-reported value
- `contextLimit` — model's maximum input context window
- `estimatedUsageRatio` — fraction of context consumed
- `severity` — `normal` / `info` / `warning` / `danger` / `critical`

Thresholds (from `context-policy.ts`):

- 0-69% normal
- 70-84% info
- 85-91% warning
- 92-96% danger
- 97%+ critical

The snapshot is persisted as `chats.lastContextState` and used by the
frontend to warn users before they exceed a model's context window.

### Provider-side compaction

Stateful providers (OpenAI, Gemini) support server-side compaction via:

- OpenAI: `context_management` param with `compact_threshold`
- Gemini: built-in interaction compaction

Compaction is enabled by default and can be disabled per-request via
`contextSettings.providerCompactionEnabled`.

### DeepSeek-specific continuation

DeepSeek uses `turn-local` continuation strategy. Key rules:

1. **No durable cursor** — DeepSeek has no server-side cursor. Every user turn
   starts fresh with full DB history replay.
2. **`reasoning_content` in tool loops** — When DeepSeek emits tool calls during
   a thinking-mode turn, the accumulated `reasoning_content` MUST be included
   in the assistant loop message sent back to the provider on the next
   iteration. Omitting it causes HTTP 400 errors.
3. **No cross-turn reasoning** — `reasoning_content` is stripped from the final
   message (no pending tool calls). It is never persisted across user turns,
   which also preserves prompt prefix stability for cache hits.
4. **Cache metrics** — `promptCacheHitTokens` and `promptCacheMissTokens` are
   captured from the DeepSeek API usage response and stored in provider state
   metadata for observability.
5. **Stable prefix** — System prompt, tool definitions (in deterministic sorted
   order), and persisted history maintain a stable request prefix across turns
   to maximise DeepSeek context cache hit rates.

---

## Common Failure Modes and Where to Debug

| Symptom                                     | Likely cause                                   | Where to look                                                             |
| ------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------- |
| Every turn starts with `degrade_to_replay`  | `chats.lastProviderState` is null or malformed | Check the chat row in DB; look for `[continuation][clear]` log lines      |
| `cursor_expired` mid-turn with tool results | Cursor went stale during tool execution        | `responses-stream.ts` or `interactions-stream.ts` cursor error handler    |
| Provider mismatch on every switch           | `lastProviderState` has stale provider         | Expected — first turn after switch always degrades                        |
| Wrong model called                          | `resolve-model.ts` selected different model    | Check `modelId` at top of `stream-text-turn.ts`                           |
| Replay sends wrong messages                 | `replay-builder.ts` misformatting              | Unit tests in `tests/unit/services/providers/replay-builder.test.ts`      |
| Stateless-loop leaks cross-turn             | `loopMessages` persisted as durable            | `decideTurnPersistence` filter — should return `null` for stateless modes |

---

## Key Design Decision: Chats vs Messages state

The system explicitly diverges from a naive approach where the most recent
message's `providerState` is used for continuation. This is intentional:

- `chats.lastProviderState` is **reactive** — it is updated atomically with
  the turn completion and never references a superseded cursor.
- `messages.providerState` is **immutable** — it records what the cursor
  looked like when the message was created, for debugging and audit trails.

Mixing them would create edge cases where a cursor from a deleted or
superceded message chain is resurrected, leading to provider errors.
