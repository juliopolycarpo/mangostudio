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
  type ClaudeResultRecord,
  type ClaudeStreamEventRecord,
  type ClaudeStreamRecord,
  contentBlocks,
  initCapabilities,
  parentToolUseId,
  permissionDenials,
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
}

export function readClaudeInit(record: ClaudeInitRecord): ClaudeRunInit {
  return {
    ...(typeof record.session_id === 'string' && record.session_id.length > 0
      ? { sessionId: record.session_id }
      : {}),
    ...(initCapabilities(record) ? { capabilities: initCapabilities(record) } : {}),
    ...(typeof record.permissionMode === 'string' ? { permissionMode: record.permissionMode } : {}),
    ...(typeof record.model === 'string' ? { model: record.model } : {}),
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
        return this.#reduceSystem(record as ClaudeInitRecord);
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

  #reduceSystem(record: ClaudeInitRecord): ClaudeReduction {
    // `status`, `thinking_tokens` and `api_retry` are progress reporting with no
    // neutral event behind them. They are read and dropped rather than
    // forwarded: the contract has no member that means "still working", and
    // inventing one out of a vendor's telemetry would put counts in a
    // transcript that no other adapter can produce.
    if (recordSubtype(record) !== 'init') return NOTHING;
    const init = readClaudeInit(record);
    this.#onInit?.(init);
    if (this.#sessionStarted || !init.sessionId) return NOTHING;
    this.#sessionStarted = true;
    return {
      events: [{ type: 'session_started', sessionId: init.sessionId, resumed: this.#resumed }],
      finished: false,
    };
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
    const delta = record.event?.delta;
    if (record.event?.type !== 'content_block_delta' || !delta) return NOTHING;
    if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
      return { events: [{ type: 'text_delta', text: delta.text }], finished: false };
    }
    if (
      delta.type === 'thinking_delta' &&
      typeof delta.thinking === 'string' &&
      delta.thinking.length > 0
    ) {
      return { events: [{ type: 'reasoning_delta', text: delta.thinking }], finished: false };
    }
    return NOTHING;
  }

  /**
   * Completed assistant blocks.
   *
   * Main-conversation `text` and `thinking` are skipped — they already arrived
   * as deltas — so what survives is the `tool_use` block and anything a
   * subagent produced.
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
      if (parent === undefined) continue;
      // A subagent's text, nested under the `Task` call that spawned it. The
      // parent activity is the unit the user sees; promoting this would render
      // a second agent's narration as MangoStudio's own.
      const text = block.type === 'text' ? block.text : undefined;
      if (typeof text === 'string' && text.length > 0) {
        events.push({
          type: 'activity_updated',
          callId: parent,
          update: {
            detail: text.slice(0, NESTED_TEXT_MAX_CHARS),
            ...(text.length > NESTED_TEXT_MAX_CHARS ? { truncated: true } : {}),
          },
        });
      }
    }
    return events.length > 0 ? { events, finished: false } : NOTHING;
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
   * which is why a denial needs no special case to close its pill. What the
   * result record adds is the authoritative list of *which* failures were
   * permission refusals rather than tool errors.
   */
  #reduceUser(record: ClaudeMessageRecord): ClaudeReduction {
    const events: ExternalAgentEvent[] = [];
    for (const block of contentBlocks(record)) {
      if (block.type !== 'tool_result') continue;
      const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
      if (callId.length === 0 || !this.#openActivities.has(callId)) continue;
      this.#openActivities.delete(callId);
      const detail = readToolResultText(block.content);
      events.push({
        type: 'activity_completed',
        callId,
        result: {
          status: block.is_error === true ? 'failed' : 'completed',
          ...(detail.length > 0
            ? {
                detail: detail.slice(0, NESTED_TEXT_MAX_CHARS),
                ...(detail.length > NESTED_TEXT_MAX_CHARS ? { truncated: true } : {}),
              }
            : {}),
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
    const events: ExternalAgentEvent[] = [];

    for (const [callId] of this.#openActivities) {
      events.push({ type: 'activity_completed', callId, result: { status: 'cancelled' } });
    }
    this.#openActivities.clear();

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
    const events: ExternalAgentEvent[] = [];
    for (const [callId] of this.#openActivities) {
      events.push({ type: 'activity_completed', callId, result: { status: 'cancelled' } });
    }
    this.#openActivities.clear();
    events.push({ type: 'error', error });
    return events;
  }
}

/** Denials, as the result record lists them. Used for the diagnostic, not the pill. */
export function claudeDeniedToolNames(record: ClaudeResultRecord): readonly string[] {
  return permissionDenials(record)
    .map((denial) => (typeof denial.tool_name === 'string' ? denial.tool_name : ''))
    .filter((name) => name.length > 0);
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
  const message =
    typeof record.result === 'string' && record.result.length > 0
      ? record.result
      : `Claude Code ended the turn with "${subtype}".`;
  const status = record.api_error_status;
  return {
    code: `claude-${subtype}`,
    message,
    ...(typeof status === 'number' ? { vendorCode: String(status) } : {}),
  };
}
