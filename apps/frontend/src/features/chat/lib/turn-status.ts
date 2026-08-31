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

/**
 * Whether the turn has stopped on something only the user can answer.
 *
 * Both kinds carry the answer on the part itself, so this is decidable from the
 * transcript alone. A `question` part deliberately does not qualify: it has no
 * answered field, and whether it can still be answered is decided by whether
 * the feed threaded `onQuestionSubmit` in — which is not knowable from here.
 *
 * A vendor approval is read off the trailing part, because the vendor drives
 * one turn at a time and the approval is the last thing it wrote. An
 * elicitation is read off the whole transcript instead: parallel tool calls
 * mean the call that came back *after* the form was raised appends its
 * `tool_result` behind it, and the form is still blocking either way. An
 * answered approval falls through rather than returning, so the two rules
 * cannot mask one another.
 */
function awaitsUserDecision(parts: readonly MessagePart[]): boolean {
  const trailingPart = parts.at(-1);
  if (trailingPart?.type === 'external_approval' && trailingPart.decisionSource === undefined) {
    return true;
  }
  // The internal turn's counterpart. An elicitation blocks the tool call that
  // raised it, so the turn keeps `isGenerating` while waiting on a form nobody
  // has filled in yet — and a "Working…" row under that form would claim the
  // opposite of what is true.
  return parts.some((part) => part.type === 'mcp_elicitation' && part.status === 'pending');
}

interface PhaseInputs {
  readonly running: boolean;
  readonly awaitsDecision: boolean;
  readonly streamedInto: LiveTextKind | null;
}

/** First match wins: a settled turn is never anything else, and so on down. */
function derivePhase({ running, awaitsDecision, streamedInto }: PhaseInputs): TurnPhase {
  if (!running) return 'settled';
  if (awaitsDecision) return 'awaiting-user';
  if (streamedInto === 'thinking') return 'thinking';
  if (streamedInto === 'text') return 'responding';
  return 'working';
}

/**
 * Derives one turn's status from the parts being rendered, for every provider.
 *
 * The working row is suppressed under three shapes that already say enough on
 * their own and must not get a second, redundant (or outright wrong) cue
 * stacked on top: trailing `text`/`thinking` mid-stream already shows its own
 * caret or pulse; a trailing activity still running already renders as running,
 * and a row under it would read as a *second* thing happening; and a decision
 * nobody has answered yet is waiting on the *user*, not on the agent —
 * "Working..." under one would claim the opposite of what is true.
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
  const awaitsDecision = awaitsUserDecision(parts);
  const phase = derivePhase({ running, awaitsDecision, streamedInto });
  return {
    phase,
    livePartIndex: streamedInto === null ? null : parts.length - 1,
    // `phase === 'working'` is exactly `running && !awaitsDecision &&
    // streamedInto === null` — the only remaining exclusion is the running
    // activity, which `derivePhase` does not know about.
    showWorkingRow: phase === 'working' && !trailingIsRunningActivity,
  };
}
