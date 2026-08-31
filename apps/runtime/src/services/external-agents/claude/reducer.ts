/**
 * One `claude --print --output-format stream-json` run, reduced to neutral events.
 *
 * Three properties this module exists to hold.
 *
 * **Text is delivered once.** With `--include-partial-messages` the stream
 * carries the same assistant output twice: as `stream_event` deltas while it is
 * being produced, and again as a whole `assistant` message when the block
 * closes. Emitting both would double every reply. So token-level text and
 * thinking come from `stream_event` only, and `assistant` records are read for
 * the things deltas cannot express — the completed `tool_use` block, whose
 * streaming form is partial JSON, and subagent output.
 *
 * **Claude's subagents stay Claude's.** The `Task` tool spawns them, and
 * `--forward-subagent-text` emits their messages with `parent_tool_use_id` set.
 * Those are nested under the parent activity as detail. They are deliberately
 * *not* routed into MangoStudio's `subagent_*` streaming events or
 * `SubagentTracePart`: that machinery describes MangoStudio's own delegation,
 * and reusing it would tell the user MangoStudio owns a hand-off it did not
 * make.
 *
 * **Unknown records are ignored, not fatal.** The record vocabulary is wider
 * than anything a plan enumerated — `system/status`, `system/thinking_tokens`,
 * `system/api_retry`, `rate_limit_event` all appeared on one live run — and it
 * will keep growing. A type this reducer has never seen is dropped silently;
 * only a `result` ends the turn.
 */

import type {
  ExternalActivityKind,
  ExternalAgentError,
  ExternalAgentEvent,
  ExternalUsage,
} from '@mangostudio/shared/external-agents';
import {
  type ClaudeContentBlock,
  type ClaudeInitRecord,
  type ClaudeMessageRecord,
  type ClaudePermissionDeniedRecord,
  type ClaudeResultRecord,
  type ClaudeStreamEventRecord,
  type ClaudeStreamRecord,
  contentBlocks,
  initCapabilities,
  initSlashCommands,
  parentToolUseId,
  recordSubtype,
  recordType,
} from './protocol';

/** How much of a subagent's forwarded text one activity update carries. */
const NESTED_TEXT_MAX_CHARS = 2_000;

/** What one record produced, plus whether the run is over. */
export interface ClaudeReduction {
  readonly events: readonly ExternalAgentEvent[];
  /** True once a `result` record has been seen. */
  readonly finished: boolean;
}

const NOTHING: ClaudeReduction = { events: [], finished: false };

/**
 * Claude's tool names mapped onto the neutral icon buckets.
 *
 * Icon selection only. The pill label is the vendor's own tool name, verbatim
 * and untranslated — `Read` renders as `Read` — because renaming another
 * company's tools in MangoStudio's interface would misattribute the work.
 *
 * The default is `other` rather than a guess: a tool this table has never heard
 * of is far more likely to be an MCP tool or a plugin's than a new built-in,
 * and picking `command` for it would put a shell icon on something that never
 * touched a shell.
 */
export function claudeActivityKind(toolName: string): ExternalActivityKind {
  switch (toolName) {
    case 'Bash':
    case 'BashOutput':
    case 'KillShell':
      return 'command';
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return 'file-change';
    case 'Task':
      return 'subagent';
    case 'WebSearch':
    case 'WebFetch':
      return 'web-search';
    case 'TodoWrite':
    case 'ExitPlanMode':
      return 'plan';
    default:
      // MCP tools are namespaced `mcp__<server>__<tool>` by the CLI, which is
      // the one shape worth recognizing here: it is a protocol convention
      // rather than a tool name, so it cannot collide with a built-in.
      return toolName.startsWith('mcp__') ? 'mcp' : 'other';
  }
}

/** A completed block's renderable content, and the delta event it belongs in. */
interface RenderableBlock {
  readonly type: 'text_delta' | 'reasoning_delta';
  readonly text: string;
}

/** The renderable content of a `text` or `thinking` block, or `undefined` for neither. */
function renderableBlock(block: ClaudeContentBlock): RenderableBlock | undefined {
  if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
    return { type: 'text_delta', text: block.text };
  }
  if (
    block.type === 'thinking' &&
    typeof block.thinking === 'string' &&
    block.thinking.length > 0
  ) {
    return { type: 'reasoning_delta', text: block.thinking };
  }
  return undefined;
}

/** Whether an opening content block is a reasoning phase, redacted or not. */
function isReasoningBlock(blockType: unknown): boolean {
  return blockType === 'thinking' || blockType === 'redacted_thinking';
}

/** Which delivery channel an opening content block will stream on, if either. */
function openingBlockKind(blockType: unknown): RenderableBlock['type'] | undefined {
  if (blockType === 'text') return 'text_delta';
  // `redacted_thinking` streams no deltas at all — its text is encrypted — but
  // it is still a reasoning-kind block for the purpose of not colliding with a
  // `text` buffer, so it is included here rather than only `isReasoningBlock`'s
  // narrower announcement use.
  return isReasoningBlock(blockType) ? 'reasoning_delta' : undefined;
}

/** A block index the stream stated, or undefined for one it did not. */
function blockIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** A one-line summary of a tool call's input, for the pill's title. */
function summarizeToolInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const record = input as Record<string, unknown>;
  // The fields Claude's own built-ins use for "what is this call about". Order
  // matters: a Bash call has both `command` and `description`, and the command
  // is what the user is looking for.
  for (const key of ['command', 'file_path', 'pattern', 'url', 'path', 'prompt', 'description']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

/** Flattens a `tool_result` content payload, which may be text or blocks. */
function readToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (typeof block !== 'object' || block === null) return '';
      const text = (block as { readonly text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .filter((text) => text.length > 0)
    .join('\n');
}

/** What discovery and the open result learn from the first record of a run. */
export interface ClaudeRunInit {
  readonly sessionId?: string;
  readonly capabilities?: readonly string[];
  readonly permissionMode?: string;
  readonly model?: string;
  /** Names this run will expand as `/name`. Absent when the CLI announced none. */
  readonly slashCommands?: readonly string[];
}

export function readClaudeInit(record: ClaudeInitRecord): ClaudeRunInit {
  const capabilities = initCapabilities(record);
  const slashCommands = initSlashCommands(record);
  return {
    ...(typeof record.session_id === 'string' && record.session_id.length > 0
      ? { sessionId: record.session_id }
      : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(typeof record.permissionMode === 'string' ? { permissionMode: record.permissionMode } : {}),
    ...(typeof record.model === 'string' ? { model: record.model } : {}),
    ...(slashCommands ? { slashCommands } : {}),
  };
}

export interface ClaudeTurnReducerOptions {
  /** Whether this run was started with a resume reference. */
  readonly resumed: boolean;
  /** Called once, when the run's `system/init` record arrives. */
  readonly onInit?: (init: ClaudeRunInit) => void;
}

export class ClaudeTurnReducer {
  readonly #resumed: boolean;
  readonly #onInit: ((init: ClaudeRunInit) => void) | undefined;
  /** Tool calls this run has opened, so a result can be matched to a name. */
  readonly #openActivities = new Map<string, string>();
  /** Forwarded subagent text per parent call, so updates accumulate rather than replace. */
  readonly #nestedText = new Map<string, string>();
  /**
   * What the deltas have actually delivered for each block of the message now
   * streaming, keyed by the block index the stream itself supplies.
   *
   * This is the whole of what `#reduceAssistant` needs to tell an already-seen
   * block from one that reached nobody — see `#undeliveredRemainder`. Cleared
   * at every message boundary: block indices restart at 0 for each message, so
   * a buffer that outlived its own would be matched against the next one's
   * blocks.
   *
   * Delivery kind travels with the text because `#undeliveredRemainder` cannot
   * trust the index the completed record arrives at (see there): a `thinking`
   * buffer and a `text` buffer that happen to share a prefix — Claude often
   * restates the same sentence in both — would otherwise let the wrong block
   * claim the other's delivery.
   */
  readonly #deliveredByBlock = new Map<number, { kind: RenderableBlock['type']; text: string }>();
  /**
   * Indices of the reasoning blocks this message opened and has not closed.
   *
   * `content_block_stop` states an index and nothing else — not the type of
   * the block it closes — so the type has to be remembered from the
   * `content_block_start` that opened it. Scoped to one message for the same
   * reason `#deliveredByBlock` is.
   */
  readonly #openReasoningBlocks = new Set<number>();
  /** A held `system/permission_denied` reason, keyed by the call it refused, until its `tool_result` closes it. */
  readonly #deniedActivities = new Map<string, string>();
  #sessionStarted = false;
  #finished = false;

  constructor(options: ClaudeTurnReducerOptions) {
    this.#resumed = options.resumed;
    this.#onInit = options.onInit;
  }

  /** Whether a `result` record has already ended this run. */
  get finished(): boolean {
    return this.#finished;
  }

  reduce(record: ClaudeStreamRecord): ClaudeReduction {
    if (this.#finished) return NOTHING;
    switch (recordType(record)) {
      case 'system':
        return this.#reduceSystem(record);
      case 'stream_event':
        return this.#reduceStreamEvent(record as ClaudeStreamEventRecord);
      case 'assistant':
        return this.#reduceAssistant(record as ClaudeMessageRecord);
      case 'user':
        return this.#reduceUser(record as ClaudeMessageRecord);
      case 'result':
        return this.#reduceResult(record as ClaudeResultRecord);
      default:
        // `rate_limit_event`, and whatever the vendor adds next.
        return NOTHING;
    }
  }

  #reduceSystem(record: ClaudeStreamRecord): ClaudeReduction {
    const subtype = recordSubtype(record);
    // Held rather than forwarded: it names the call it refuses, but the
    // activity it belongs to closes through the `tool_result` that always
    // follows, and that is the one rendering the user should see.
    if (subtype === 'permission_denied') {
      this.#recordDenial(record as ClaudePermissionDeniedRecord);
      return NOTHING;
    }
    // `status`, `thinking_tokens` and `api_retry` are progress reporting with no
    // neutral event behind them. They are read and dropped rather than
    // forwarded: the contract has no member that means "still working", and
    // inventing one out of a vendor's telemetry would put counts in a
    // transcript that no other adapter can produce.
    if (subtype !== 'init') return NOTHING;
    const init = readClaudeInit(record as ClaudeInitRecord);
    this.#onInit?.(init);

    const events: ExternalAgentEvent[] = [];
    if (!this.#sessionStarted && init.sessionId) {
      this.#sessionStarted = true;
      events.push({ type: 'session_started', sessionId: init.sessionId, resumed: this.#resumed });
    }
    // Announced per run rather than per session, because the CLI is spawned
    // again for every turn and re-reads its command directories each time. That
    // makes the catalog self-healing here in a way it is not for a long-lived
    // ACP session: a command file written between two turns is in the next
    // list. Emitted even when the session id was missing — the catalog is
    // useful on its own, and tying it to a handle it does not need would drop
    // it for a run that only failed to name itself.
    if (init.slashCommands) {
      events.push({
        type: 'commands_available',
        commands: init.slashCommands.map((name) => ({ name })),
      });
    }
    return events.length > 0 ? { events, finished: false } : NOTHING;
  }

  #recordDenial(record: ClaudePermissionDeniedRecord): void {
    const callId = typeof record.tool_use_id === 'string' ? record.tool_use_id : '';
    const message = typeof record.message === 'string' ? record.message : '';
    if (callId.length > 0 && message.length > 0) this.#deniedActivities.set(callId, message);
  }

  /**
   * Token-level output. The only source of `text_delta` and `reasoning_delta`.
   *
   * `signature_delta` and `input_json_delta` are deliberately dropped:
   * the first is a thinking-block signature with nothing to render, and the
   * second is partial JSON for a tool call whose completed form arrives as an
   * `assistant` record.
   */
  #reduceStreamEvent(record: ClaudeStreamEventRecord): ClaudeReduction {
    // A subagent's own token stream, if one ever arrives, is nested through the
    // `assistant` path rather than promoted into the main transcript.
    if (parentToolUseId(record) !== undefined) return NOTHING;
    const event = record.event;
    // Both ends of a message. Block indices are scoped to the message that
    // opened them, so they mean nothing once it is over — but a reasoning
    // phase still open here was closed by the message ending, whether or not
    // its own `content_block_stop` arrived, and has to say so before the
    // index it is keyed by is discarded.
    if (event?.type === 'message_start' || event?.type === 'message_stop') {
      const closing = this.#closeReasoningBlocks();
      this.#deliveredByBlock.clear();
      return closing;
    }
    const index = blockIndex(event?.index);
    if (event?.type === 'content_block_start') {
      // Opened with nothing delivered yet. Recorded even so: an `omitted`
      // reasoning phase streams only empty `thinking_delta`s, and this is what
      // says those deltas were still this block's delivery channel. A block
      // whose kind will never be renderable — `tool_use` chief among them —
      // gets no entry at all, since one would never be eligible to match
      // anything in `#undeliveredRemainder`.
      const kind = openingBlockKind(event.content_block?.type);
      if (index !== undefined && kind) this.#deliveredByBlock.set(index, { kind, text: '' });
      // Fires once per block, by protocol — this is the only signal a reasoning
      // phase produces on an account whose `thinking_delta` text is withheld.
      // `redacted_thinking` qualifies for the same reason and then some: its
      // text is encrypted, so no renderable delta can ever follow and the
      // announcement is the whole of what that phase will show.
      if (!isReasoningBlock(event.content_block?.type)) return NOTHING;
      // Remembered by index, because `content_block_stop` states only that —
      // it does not repeat the type of the block it closes.
      if (index !== undefined) this.#openReasoningBlocks.add(index);
      return { events: [{ type: 'reasoning_started' }], finished: false };
    }
    if (event?.type === 'content_block_stop') {
      if (index === undefined || !this.#openReasoningBlocks.delete(index)) return NOTHING;
      return { events: [{ type: 'reasoning_ended' }], finished: false };
    }
    const delta = event?.delta;
    if (event?.type !== 'content_block_delta' || !delta) return NOTHING;
    if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
      this.#recordDelivered(index, 'text_delta', delta.text);
      return { events: [{ type: 'text_delta', text: delta.text }], finished: false };
    }
    if (
      delta.type === 'thinking_delta' &&
      typeof delta.thinking === 'string' &&
      delta.thinking.length > 0
    ) {
      this.#recordDelivered(index, 'reasoning_delta', delta.thinking);
      return { events: [{ type: 'reasoning_delta', text: delta.thinking }], finished: false };
    }
    return NOTHING;
  }

  /**
   * Closes every reasoning phase still open, one `reasoning_ended` each.
   *
   * The safety net for a message that ended without a `content_block_stop` for
   * its reasoning block: the phase is over either way, and a projection left
   * holding an open one would go on treating a finished turn as stopped inside
   * it. A no-op on every recorded run — the stops do arrive.
   */
  #closeReasoningBlocks(): ClaudeReduction {
    if (this.#openReasoningBlocks.size === 0) return NOTHING;
    const events = [...this.#openReasoningBlocks].map(
      () => ({ type: 'reasoning_ended' }) as const satisfies ExternalAgentEvent
    );
    this.#openReasoningBlocks.clear();
    return { events, finished: false };
  }

  /** Appends what one delta just delivered to its own block's running copy. */
  #recordDelivered(index: number | undefined, kind: RenderableBlock['type'], text: string): void {
    if (index === undefined) return;
    const previous = this.#deliveredByBlock.get(index);
    this.#deliveredByBlock.set(index, { kind, text: (previous?.text ?? '') + text });
  }

  /**
   * The part of a completed block that reached nobody.
   *
   * Blocks are matched by what streamed for them rather than by index: the
   * `assistant` record arrives interleaved with its own `content_block_stop`,
   * so whichever index is open at that moment is not reliably the record's.
   * The longest delivered buffer of the same kind that this text extends is
   * that block's own copy, and the empty string is a prefix of everything —
   * so a block nothing streamed for matches nothing, and its whole content is
   * the remainder.
   *
   * Restricted to buffers of the matching kind, and the match is consumed once
   * found: a `thinking` buffer and a `text` buffer often carry the same
   * sentence (Claude restates the plan it just reasoned through), and without
   * that restriction the shorter, wrong-kind buffer could be picked as the
   * text block's own delivery — leaving only the tail past where the thinking
   * text stopped matching as the "remainder", silently dropping the rest of a
   * reply that never actually streamed as text.
   *
   * Usage: `#undeliveredRemainder('text_delta', 'mango')` is `''` after the
   * deltas already carried `mango` as text, and `' juice'` when they stopped
   * after `mango`.
   */
  #undeliveredRemainder(kind: RenderableBlock['type'], text: string): string {
    let matchedIndex: number | undefined;
    let delivered = '';
    for (const [index, entry] of this.#deliveredByBlock) {
      if (entry.kind !== kind) continue;
      if (entry.text.length > delivered.length && text.startsWith(entry.text)) {
        delivered = entry.text;
        matchedIndex = index;
      }
    }
    if (matchedIndex !== undefined) this.#deliveredByBlock.delete(matchedIndex);
    return text.slice(delivered.length);
  }

  /**
   * Completed assistant blocks.
   *
   * Main-conversation `text` and `thinking` are emitted here for exactly the
   * part of themselves the deltas never carried. Usually that is nothing —
   * the deltas delivered the block in full, and replaying it would double
   * every reply. When `--include-partial-messages` produced no deltas for the
   * block at all, which is the whole run for an account like the denied-write
   * fixture's, the remainder is the block entire and this completed record is
   * the only copy of it that will ever exist. A stream cut off mid-block lands
   * between the two and contributes its tail, which is the case neither
   * all-or-nothing reading of "already delivered" could express. The
   * `tool_use` block and anything a subagent produced are handled
   * unconditionally either way.
   */
  #reduceAssistant(record: ClaudeMessageRecord): ClaudeReduction {
    const parent = parentToolUseId(record);
    const events: ExternalAgentEvent[] = [];
    for (const block of contentBlocks(record)) {
      if (block.type === 'tool_use') {
        const started = this.#startActivity(block);
        if (started) events.push(started);
        continue;
      }
      if (parent === undefined) {
        const replay = this.#undeliveredEventFor(block);
        if (replay) events.push(replay);
        continue;
      }
      // Only under a call that is still open. A completed activity has been
      // removed from the map, and both consumers *replace* an activity's detail
      // on update — so a late message would reopen a closed pill, and one for a
      // parent that never existed would address a pill that is not there.
      if (!this.#openActivities.has(parent)) continue;
      // A subagent's text, nested under the `Task` call that spawned it. The
      // parent activity is the unit the user sees; promoting this would render
      // a second agent's narration as MangoStudio's own.
      const text = block.type === 'text' ? block.text : undefined;
      if (typeof text === 'string' && text.length > 0) {
        // Accumulated, not replaced. `update.detail` overwrites downstream, so
        // emitting each block on its own would leave only the last one — a
        // subagent that reported three findings would render as having found
        // the third.
        const merged = appendNested(this.#nestedText.get(parent), text);
        this.#nestedText.set(parent, merged);
        events.push({
          type: 'activity_updated',
          callId: parent,
          update: boundedDetail(merged),
        });
      }
    }
    return events.length > 0 ? { events, finished: false } : NOTHING;
  }

  /**
   * The delta event carrying whatever of a completed main-conversation block
   * the stream never delivered, or `undefined` when it delivered all of it.
   */
  #undeliveredEventFor(block: ClaudeContentBlock): ExternalAgentEvent | undefined {
    const renderable = renderableBlock(block);
    if (!renderable) return undefined;
    const remainder = this.#undeliveredRemainder(renderable.type, renderable.text);
    return remainder.length > 0 ? { type: renderable.type, text: remainder } : undefined;
  }

  #startActivity(block: ClaudeContentBlock): ExternalAgentEvent | undefined {
    const callId = typeof block.id === 'string' ? block.id : '';
    const name = typeof block.name === 'string' ? block.name : '';
    if (callId.length === 0 || name.length === 0) return undefined;
    if (this.#openActivities.has(callId)) return undefined;
    this.#openActivities.set(callId, name);
    return {
      type: 'activity_started',
      callId,
      activity: {
        // Verbatim. `Read` is `Read`, and an MCP tool keeps its namespaced name.
        name,
        kind: claudeActivityKind(name),
        title: summarizeToolInput(block.input),
      },
    };
  }

  /**
   * Tool results, which Claude reports as a `user` message.
   *
   * A denied tool lands here too, as a `tool_result` with `is_error: true` —
   * closing the pill needs no special case for that. Its `detail` does: a
   * held `system/permission_denied` is the vendor's own statement of why, and
   * takes priority over whatever `tool_result.content` happens to carry,
   * which is not guaranteed to say anything past "denied". One rendering
   * either way — nothing else ever reports the same refusal.
   */
  #reduceUser(record: ClaudeMessageRecord): ClaudeReduction {
    const events: ExternalAgentEvent[] = [];
    for (const block of contentBlocks(record)) {
      if (block.type !== 'tool_result') continue;
      const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
      if (callId.length === 0 || !this.#openActivities.has(callId)) continue;
      this.#openActivities.delete(callId);
      this.#nestedText.delete(callId);
      const denial = this.#deniedActivities.get(callId);
      this.#deniedActivities.delete(callId);
      const detail = denial ?? readToolResultText(block.content);
      events.push({
        type: 'activity_completed',
        callId,
        result: {
          status: block.is_error === true ? 'failed' : 'completed',
          ...boundedDetail(detail),
        },
      });
    }
    return events.length > 0 ? { events, finished: false } : NOTHING;
  }

  /**
   * The terminal record.
   *
   * A run that ends with tool calls still open closes them as `cancelled`: the
   * process is gone, so nothing will ever report their outcome, and a pill left
   * spinning in a reloaded transcript is a control that will never resolve.
   */
  #reduceResult(record: ClaudeResultRecord): ClaudeReduction {
    this.#finished = true;
    const events: ExternalAgentEvent[] = this.#closeOpenActivities();

    const usage = readUsage(record);
    if (usage) events.push({ type: 'usage', usage });

    const error = readResultError(record);
    if (error) {
      events.push({ type: 'error', error });
      return { events, finished: true };
    }
    events.push({ type: 'completed' });
    return { events, finished: true };
  }

  /**
   * Closes a run whose process ended without a `result` record.
   *
   * A crash, a killed process tree or an exhausted budget all land here. The
   * turn has to reach a terminal state either way, and an open activity has to
   * stop claiming it is still running.
   */
  abort(error: ExternalAgentError): readonly ExternalAgentEvent[] {
    if (this.#finished) return [];
    this.#finished = true;
    const events: ExternalAgentEvent[] = this.#closeOpenActivities();
    events.push({ type: 'error', error });
    return events;
  }

  /**
   * Closes every call the run ended without reporting, as `cancelled`.
   *
   * A call the vendor already refused carries that refusal into its close. The
   * `tool_result` that normally delivers the reason never arrived, so the held
   * `system/permission_denied` is the only statement anyone made about why
   * that call did not happen — a pill reading "Cancelled." with nothing else
   * throws it away.
   */
  #closeOpenActivities(): ExternalAgentEvent[] {
    const events: ExternalAgentEvent[] = [];
    for (const [callId] of this.#openActivities) {
      const denial = this.#deniedActivities.get(callId);
      events.push({
        type: 'activity_completed',
        callId,
        result: { status: 'cancelled', ...boundedDetail(denial ?? '') },
      });
    }
    this.#openActivities.clear();
    this.#deniedActivities.clear();
    return events;
  }
}

/** A `detail` field bounded to what one activity update carries, or nothing for empty text. */
function boundedDetail(detail: string): { detail?: string; truncated?: boolean } {
  if (detail.length === 0) return {};
  return {
    detail: detail.slice(0, NESTED_TEXT_MAX_CHARS),
    ...(detail.length > NESTED_TEXT_MAX_CHARS ? { truncated: true } : {}),
  };
}

/**
 * Bounded concatenation of a subagent's forwarded blocks.
 *
 * Capped at twice the render limit so a long-running subagent cannot grow an
 * unbounded string in memory for a field that is sliced to `NESTED_TEXT_MAX_CHARS`
 * on the way out. Keeping the head rather than the tail matches what the reader
 * is following.
 */
function appendNested(previous: string | undefined, text: string): string {
  const merged = previous === undefined ? text : `${previous}\n${text}`;
  return merged.length > NESTED_TEXT_MAX_CHARS * 2
    ? merged.slice(0, NESTED_TEXT_MAX_CHARS * 2)
    : merged;
}

function readUsage(record: ClaudeResultRecord): ExternalUsage | undefined {
  const usage = record.usage;
  if (!usage) return undefined;
  const input = countOf(usage.input_tokens);
  const output = countOf(usage.output_tokens);
  const cacheRead = countOf(usage.cache_read_input_tokens);
  const cacheWrite = countOf(usage.cache_creation_input_tokens);
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined
  ) {
    return undefined;
  }
  return {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
  };
}

function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * The error arm's own text, joined.
 *
 * `error_max_turns`, `error_during_execution`, `error_max_budget_usd` and
 * `error_max_structured_output_retries` carry their explanation in `errors`
 * and have no `result` field at all — reading only `result` left every one of
 * these showing the generic fallback message instead of what actually
 * happened.
 */
function readResultErrorText(record: ClaudeResultRecord): string | undefined {
  const errors = record.errors;
  if (!Array.isArray(errors)) return undefined;
  const joined = errors.filter((value): value is string => typeof value === 'string').join('\n');
  return joined.length > 0 ? joined : undefined;
}

/**
 * Whether a `result` record is a failure, and what to call it.
 *
 * A run whose only problem was a refused tool is **not** an error.
 * `permission_denials` is populated, `is_error` is false and the process exits
 * 0 — the agent asked, MangoStudio's configuration said no, and the vendor
 * reported that faithfully. Reporting it as a failed turn would blame the user's
 * own permission choice on the vendor.
 */
function readResultError(record: ClaudeResultRecord): ExternalAgentError | undefined {
  if (record.is_error !== true) return undefined;
  const subtype = recordSubtype(record) ?? 'error';
  const terminalReason =
    typeof record.terminal_reason === 'string' ? record.terminal_reason : undefined;
  const resultText =
    typeof record.result === 'string' && record.result.length > 0 ? record.result : undefined;
  const message =
    readResultErrorText(record) ??
    resultText ??
    (terminalReason
      ? `Claude Code ended the turn: ${terminalReason}.`
      : `Claude Code ended the turn with "${subtype}".`);
  const status = record.api_error_status;
  const vendorCode = typeof status === 'number' ? String(status) : terminalReason;
  return {
    code: `claude-${subtype}`,
    message,
    ...(vendorCode ? { vendorCode } : {}),
  };
}
