/**
 * The recorded Cursor ACP transcript, loaded once.
 *
 * Real frames, not remembered ones. `text-and-command-turn.json` was captured
 * from `cursor-agent acp` on `2026.08.04-aaa8809` driving a turn that ran a
 * shell command, answered its permission request and ended `end_turn` — which
 * is the whole lifecycle this adapter has to normalize. Tests replay it rather
 * than hand-building payloads, so a shape the author misremembered cannot pass.
 */

import transcript from '../fixtures/cursor/text-and-command-turn.json' with { type: 'json' };

export const CURSOR_TRANSCRIPT = transcript as {
  readonly initialize: Record<string, unknown>;
  readonly sessionId: string;
  readonly updates: readonly Record<string, unknown>[];
  readonly requestPermission: {
    readonly sessionId: string;
    readonly toolCall: Record<string, unknown>;
    readonly options: ReadonlyArray<{ optionId: string; name: string; kind: string }>;
  };
  readonly promptResult: { readonly stopReason: string };
  readonly sessionList: { readonly sessions: ReadonlyArray<Record<string, unknown>> };
  readonly status: Record<string, unknown>;
};

/** The three ACP session modes the live build offers. */
export const CURSOR_MODES = {
  currentModeId: 'agent',
  availableModes: [
    { id: 'agent', name: 'Agent', description: 'Full agent capabilities with tool access' },
    { id: 'plan', name: 'Plan', description: 'Read-only mode for planning and designing' },
    { id: 'ask', name: 'Ask', description: 'Q&A mode - no edits or command execution' },
  ],
} as const;

/**
 * A model list in the vendor's own spelling.
 *
 * `modelId` carries its parameterization, which is why nothing constructs one.
 * The count here is two and means nothing: three Cursor surfaces have reported
 * three different totals, so no test asserts one.
 */
export const CURSOR_MODELS = {
  currentModelId: 'default[]',
  availableModels: [
    { modelId: 'default[]', name: 'Auto' },
    {
      modelId: 'claude-opus-5[thinking=true,context=300k,effort=high,fast=false]',
      name: 'claude-opus-5',
    },
  ],
} as const;
