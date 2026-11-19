/**
 * How often a streaming turn persists its transcript. Kept apart from
 * `turn-checkpoint.ts` so the external-agent transcript writer can share the
 * cadence without importing the checkpoint writer's tool-policy dependencies:
 * an external turn must not reach the tool registry.
 */

/** Text that must accumulate before a checkpoint is written. */
export const CHECKPOINT_TEXT_INTERVAL_CHARS = 512;

/** The longest a changed transcript waits before a checkpoint is written. */
export const CHECKPOINT_MAX_INTERVAL_MS = 1_000;
