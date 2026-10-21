/**
 * The hub's note on a `tool_loop_exhausted` event:
 * "Reached N iterations with M pending tool calls".
 */
const TOOL_LOOP_DETAIL = /^Reached (\d+) iterations? with \d+ pending tool calls?$/;

/**
 * How many rounds of tool calls a turn ran before the hub stopped it, read from
 * the event's `detail`, or `null` when the note is absent or in a shape this
 * build does not know.
 *
 * The event carries the numbers only inside that English sentence, so this is
 * the one place that reads it; the card then says the count in the reader's own
 * language rather than printing the hub's words.
 *
 * // Usage: toolLoopRounds('Reached 25 iterations with 3 pending tool calls') // 25
 */
export function toolLoopRounds(detail: string | undefined): number | null {
  const match = detail ? TOOL_LOOP_DETAIL.exec(detail.trim()) : null;
  return match ? Number(match[1]) : null;
}
