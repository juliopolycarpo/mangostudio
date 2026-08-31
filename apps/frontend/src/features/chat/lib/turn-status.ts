import type { MessagePart } from '@mangostudio/shared';

/**
 * What one turn is doing, at the altitude a renderer cares about.
 *
 * `working` is the honest answer for every gap no event describes: waiting on
 * the API before the first token, or the pause between one tool call ending and
 * the next starting. `awaiting-user` is its opposite — the turn is stopped on a
 * decision only the user can make, and nothing happens until they make it.
 */
export type TurnPhase = 'settled' | 'working' | 'thinking' | 'responding' | 'awaiting-user';

export interface TurnStatus {
  readonly phase: TurnPhase;
  /** Index into the SAME normalized array being rendered, or null. */
  readonly livePartIndex: number | null;
  /** The step-level filler row, with its three exclusions intact. */
  readonly showWorkingRow: boolean;
}

/** The two part kinds a turn streams tokens into, one character at a time. */
type LiveTextKind = 'text' | 'thinking';

/**
 * Whether the turn is still open.
 *
 * Two independent pieces of evidence, because neither covers the other. A
 * MangoStudio turn is open while this session receives tokens, and carries no
 * turn record to consult. A vendor turn keeps its record across a reload, so a
 * transcript reopened mid-turn still knows it is unfinished even though this
 * session is streaming nothing.
 */
function isRunning(parts: readonly MessagePart[], isStreaming: boolean): boolean {
  if (isStreaming) return true;
  // The turn record is written first so nothing is ever a bare text blob with
  // no record of who produced it — it is never the trailing part.
  const externalTurn = parts.find((part) => part.type === 'external_turn');
  return externalTurn?.status === 'active';
}

/**
 * The kind of part receiving tokens right now, or null.
 *
 * Gated on `isStreaming` rather than on the turn being open: a reloaded turn
 * ends on text that stopped growing long ago. This is also exactly what a caret
 * claims — *this session is receiving tokens* — which is why `livePartIndex`
 * asks this question and not whether the turn is running.
 */
function streamedIntoKind(
  parts: readonly MessagePart[],
  isStreaming: boolean
): LiveTextKind | null {
  if (!isStreaming) return null;
  const trailingPart = parts.at(-1);
  if (trailingPart?.type === 'text' || trailingPart?.type === 'thinking') return trailingPart.type;
  return null;
}

interface PhaseInputs {
  readonly running: boolean;
  readonly trailingAwaitsDecision: boolean;
  readonly streamedInto: LiveTextKind | null;
}

/** First match wins: a settled turn is never anything else, and so on down. */
function derivePhase({ running, trailingAwaitsDecision, streamedInto }: PhaseInputs): TurnPhase {
  if (!running) return 'settled';
  if (trailingAwaitsDecision) return 'awaiting-user';
  if (streamedInto === 'thinking') return 'thinking';
  if (streamedInto === 'text') return 'responding';
  return 'working';
}

/**
 * Derives one turn's status from the parts being rendered, for every provider.
 *
 * The working row is suppressed under three trailing shapes that already say
 * enough on their own and must not get a second, redundant (or outright wrong)
 * cue stacked on top: `text`/`thinking` mid-stream already shows its own caret
 * or pulse; an activity still running already renders as running, and a row
 * under it would read as a *second* thing happening; and an approval nobody has
 * answered yet is waiting on the *user*, not on the agent — "Working..." under
 * an unresolved decision would claim the opposite of what is true.
 *
 * @example
 * deriveTurnStatus(parts, msg.isGenerating ?? false).phase // => 'working'
 */
export function deriveTurnStatus(parts: readonly MessagePart[], isStreaming: boolean): TurnStatus {
  const running = isRunning(parts, isStreaming);
  const streamedInto = streamedIntoKind(parts, isStreaming);
  const trailingPart = parts.at(-1);
  const trailingIsRunningActivity =
    trailingPart?.type === 'external_activity' && trailingPart.status === 'running';
  const trailingAwaitsDecision =
    trailingPart?.type === 'external_approval' && trailingPart.decisionSource === undefined;
  return {
    phase: derivePhase({ running, trailingAwaitsDecision, streamedInto }),
    livePartIndex: streamedInto === null ? null : parts.length - 1,
    showWorkingRow:
      running && streamedInto === null && !trailingIsRunningActivity && !trailingAwaitsDecision,
  };
}
