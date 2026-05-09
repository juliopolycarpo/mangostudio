# Context Compaction

When a conversation approaches the model's context window limit, MangoStudio warns the user and offers compaction options. This document explains the snapshot system, severity thresholds, and compaction flows.

## Context Snapshot

After each turn, the orchestrator computes a `ContextSnapshot`:

```typescript
interface ContextSnapshot {
  estimatedInputTokens: number;
  contextLimit: number; // Model's max input tokens
  estimatedUsageRatio: number; // 0–1 fraction of context consumed
  providerReportedTokens?: number;
  severity: ContextSeverity;
}
```

### Estimation

- Characters are converted to tokens using a ~4 chars/token estimate.
- When the provider reports actual input token usage, that value takes priority over the estimate.
- The snapshot includes: system prompt length + history text + tool definitions + turn-local character count.

### Persistence

The snapshot is serialized to `chats.lastContextState` as a JSON blob after each turn. The frontend reads it to display the context ring and warnings.

## Severity Thresholds

| Ratio  | Severity   | Action                                  |
| ------ | ---------- | --------------------------------------- |
| 0–69%  | `normal`   | No warning                              |
| 70–84% | `info`     | Subtle indicator                        |
| 85–91% | `warning`  | Yellow ring + optional callout          |
| 92–96% | `danger`   | Orange ring + compaction callout        |
| 97%+   | `critical` | Red ring + immediate compaction callout |

Thresholds are defined in `context-policy.ts`.

## Context Ring

The sidebar `ContextRing` component displays a circular SVG progress indicator:

- **Size:** 20×20px
- **Colors:** Green (normal) → Yellow (warning) → Orange (danger) → Red (critical)
- **Arc:** Shows the usage ratio as a partially filled ring.
- **Number:** Percentage displayed in the center at 7px font size.

## Compaction Callout

When severity reaches `warning` or above, the `ContextWarningCallout` appears in the chat feed above the input bar with three actions:

1. **Compact and continue** — Summarizes the current chat's history, clears provider state, and continues in the same chat.
2. **Start summarized chat** — Creates a new chat with a summary of the current conversation as context.
3. **Continue anyway** — Dismisses the warning and proceeds without compaction.

### `compactChatUseCase`

1. Loads full message history.
2. Formats as `User: ... / Assistant: ...` pairs.
3. Calls a dedicated summarization model with a fixed system prompt.
4. Persists the summary as a `system_event` + `text` message pair.
5. Clears `chats.lastProviderState` (forces replay on next turn).
6. Updates `chats.lastContextState` with mode `compacted`.

### `summarizeToNewChatUseCase`

1. Creates a new chat with the same title and model config.
2. Summarizes the source chat's history.
3. Persists the summary as a `summary_handoff` event in the new chat.
4. The new chat starts with a clean context window.

## Provider-Side Compaction

Stateful providers (OpenAI, Gemini) support server-side compaction:

- **OpenAI** — `context_management` parameter with `compact_threshold`. Automatically compacts the conversation server-side when the threshold is reached.
- **Gemini** — Built-in interaction compaction handled transparently by the API.

Provider-side compaction is enabled by default and can be disabled per-request via `contextSettings.providerCompactionEnabled`.

## Context Policy Functions

`context-policy.ts` provides:

| Function                              | Purpose                                                             |
| ------------------------------------- | ------------------------------------------------------------------- |
| `getModelContextLimit(modelName)`     | Returns the model's max input tokens (curated table of 120+ models) |
| `computeContextSnapshot(...)`         | Estimates token usage and severity                                  |
| `getContextSeverity(ratio)`           | Maps ratio to severity band                                         |
| `recommendContextAction(ratio, mode)` | Suggests compaction action                                          |
| `estimateTokenCount(text)`            | Rough char-to-token conversion                                      |

### Model Context Limits

A curated table covers 120+ model variants. Lookup priority:

1. Exact model name match.
2. Longest prefix match.
3. Legacy heuristic (e.g., `gpt-4` → 128k, `gemini-1.5` → 1M).
4. Fallback: 128,000 tokens.

## Context Settings (User-Configurable)

Users can configure compaction behavior in Settings → Context:

| Setting                     | Default            | Purpose                                     |
| --------------------------- | ------------------ | ------------------------------------------- |
| `compactionEnabled`         | `true`             | Enable/disable the compaction callout       |
| `compactionThreshold`       | 85                 | Severity ratio at which the callout appears |
| `compactionSummaryModelId`  | (provider default) | Model used for summarization                |
| `providerCompactionEnabled` | `true`             | Enable server-side compaction               |
