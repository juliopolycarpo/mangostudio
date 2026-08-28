/**
 * The `stream-json` record shapes this adapter reads, hand-written.
 *
 * Not generated, because Claude Code publishes no machine-readable schema for
 * this stream the way Codex publishes one for `app-server`. Every shape below
 * was observed on a live 2.1.226 run and is deliberately **partial**: each
 * interface names only the fields the reducer consumes, and every one of them
 * is optional or `unknown`. That is the point. The vocabulary is wider than any
 * plan enumerated and will keep growing, so a record type this file has never
 * heard of has to be ignorable rather than fatal, and a field that changed
 * shape has to narrow to "absent" rather than throw.
 *
 * `type` is the only discriminator that is trusted, and even it is read as a
 * plain string so that an unknown value falls through to the ignore path.
 */

/**
 * Anything on the wire, before it has been recognized.
 *
 * The index signature is the point, not laxity: the record vocabulary is open
 * and additive, so a build that adds a field must remain assignable here. A
 * closed shape would make every new vendor field a compile error in whatever
 * code constructs or forwards one.
 */
export interface ClaudeStreamRecord {
  readonly [key: string]: unknown;
  readonly type?: unknown;
  readonly subtype?: unknown;
  readonly session_id?: unknown;
  readonly uuid?: unknown;
  /**
   * Which tool call this record belongs to, or `null` for the main
   * conversation. `--forward-subagent-text` sets it on every message a subagent
   * produced, which is what lets those be nested rather than promoted.
   */
  readonly parent_tool_use_id?: unknown;
}

/** `system/init` — the first record of every run. */
export interface ClaudeInitRecord extends ClaudeStreamRecord {
  readonly capabilities?: unknown;
  readonly permissionMode?: unknown;
  readonly model?: unknown;
  readonly mcp_servers?: unknown;
  readonly mcp_server_errors?: unknown;
  readonly plugins?: unknown;
  readonly plugin_errors?: unknown;
  /**
   * Every name this run will expand as `/name`, without descriptions.
   *
   * One flat list: user commands from disk, plugin and MCP commands, the CLI's
   * own builtins, and the skills that `skills` repeats. Claude Code sends no
   * help text with them, which is why the neutral catalog's `description` is
   * optional rather than the vendors being normalized to a common shape.
   */
  readonly slash_commands?: unknown;
  /**
   * The subset of `slash_commands` that only does something in the interactive
   * terminal. Observed as `["doctor", "color"]` on 2.1.250.
   */
  readonly terminal_slash_commands?: unknown;
  /**
   * Skills, which are also listed in `slash_commands`.
   *
   * Read for nothing today: a skill is invoked as `/name` like anything else,
   * and offering it twice under two headings would suggest a distinction the
   * prompt does not have. Declared because it is part of the record and the
   * next person to look will otherwise wonder where it went.
   */
  readonly skills?: unknown;
}

/** One block inside an `assistant` or `user` message. */
export interface ClaudeContentBlock {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly name?: unknown;
  readonly id?: unknown;
  readonly input?: unknown;
  readonly tool_use_id?: unknown;
  readonly is_error?: unknown;
  readonly content?: unknown;
}

export interface ClaudeMessageRecord extends ClaudeStreamRecord {
  readonly message?: {
    readonly role?: unknown;
    readonly content?: unknown;
  };
}

/** `stream_event` — a raw Anthropic streaming event, forwarded verbatim. */
export interface ClaudeStreamEventRecord extends ClaudeStreamRecord {
  readonly event?: {
    readonly type?: unknown;
    readonly index?: unknown;
    readonly content_block?: { readonly type?: unknown };
    readonly delta?: {
      readonly type?: unknown;
      readonly text?: unknown;
      readonly thinking?: unknown;
      readonly stop_reason?: unknown;
    };
  };
}

/** `result` — the last record of a completed run. */
export interface ClaudeResultRecord extends ClaudeStreamRecord {
  readonly is_error?: unknown;
  readonly result?: unknown;
  readonly stop_reason?: unknown;
  readonly terminal_reason?: unknown;
  /**
   * The refusals this run accumulated.
   *
   * Read by nothing: a denied call already arrives as a `tool_result` with
   * `is_error: true` and closes its own activity, so projecting this list too
   * would render one refusal twice. Declared because it is part of the record
   * shape and the next person to look will otherwise wonder where it went.
   */
  readonly permission_denials?: unknown;
  readonly api_error_status?: unknown;
  readonly usage?: {
    readonly input_tokens?: unknown;
    readonly output_tokens?: unknown;
    readonly cache_read_input_tokens?: unknown;
    readonly cache_creation_input_tokens?: unknown;
  };
}

/** Narrowing helpers. Every one answers "is this usable", never "is this valid". */

export function recordType(record: ClaudeStreamRecord): string | undefined {
  return typeof record.type === 'string' ? record.type : undefined;
}

export function recordSubtype(record: ClaudeStreamRecord): string | undefined {
  return typeof record.subtype === 'string' ? record.subtype : undefined;
}

export function parentToolUseId(record: ClaudeStreamRecord): string | undefined {
  // `null` is the documented value for the main conversation, so only a
  // non-empty string means "this belongs to a subagent".
  return typeof record.parent_tool_use_id === 'string' && record.parent_tool_use_id.length > 0
    ? record.parent_tool_use_id
    : undefined;
}

export function contentBlocks(record: ClaudeMessageRecord): readonly ClaudeContentBlock[] {
  const content = record.message?.content;
  return Array.isArray(content) ? (content as readonly ClaudeContentBlock[]) : [];
}

export function initCapabilities(record: ClaudeInitRecord): readonly string[] | undefined {
  const capabilities = record.capabilities;
  if (!Array.isArray(capabilities)) return undefined;
  return capabilities.filter((value): value is string => typeof value === 'string');
}

/**
 * Names a run announced but cannot act on outside an interactive terminal, or
 * `undefined` when the run stated that list in a shape this cannot read.
 *
 * Absent is not the same as unreadable: a run that names no terminal-only
 * command withholds nothing, while one that answers with a scalar or an object
 * has told us something we failed to understand.
 */
function terminalOnlyCommands(record: ClaudeInitRecord): ReadonlySet<string> | undefined {
  const names = record.terminal_slash_commands;
  if (names === undefined) return new Set();
  if (!Array.isArray(names)) return undefined;
  return new Set(names.filter((value): value is string => typeof value === 'string'));
}

/**
 * The commands this run can expand, in the order the CLI announced them.
 *
 * Two kinds are withheld, and only two. `terminal_slash_commands` is the
 * vendor's own statement that a name needs the interactive terminal this
 * adapter does not give it. A `__`-prefixed name is the CLI's private
 * plumbing — `__remote-workflow` is not something a user types.
 *
 * Everything else is passed through, builtins included. Whether `/compact`
 * behaves the same in `--print` as it does in the REPL is the vendor's answer
 * to give, and a hand-maintained blocklist of "commands we think are
 * interactive" would go stale the first time that list changes.
 */
export function initSlashCommands(record: ClaudeInitRecord): readonly string[] | undefined {
  const names = record.slash_commands;
  if (!Array.isArray(names)) return undefined;
  const terminalOnly = terminalOnlyCommands(record);
  // Withholding is the promise this catalog makes, so a run whose exclusion
  // list could not be read gets no catalog rather than one that quietly
  // includes names the vendor said need a terminal. The composer still has the
  // library's scan of the same directories to fall back on.
  if (!terminalOnly) return undefined;
  return names.filter(
    (value): value is string =>
      typeof value === 'string' &&
      value.length > 0 &&
      !value.startsWith('__') &&
      !terminalOnly.has(value)
  );
}

/**
 * Parses one stdout line.
 *
 * A line that is not JSON is dropped rather than failing the turn. The CLI
 * writes diagnostics to stderr, but a stray non-JSON line on stdout — a
 * deprecation notice from a wrapper script, say — must not be able to end a
 * conversation the user is in the middle of.
 */
export function parseClaudeStreamLine(line: string): ClaudeStreamRecord | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0 || !trimmed.startsWith('{')) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as ClaudeStreamRecord)
      : undefined;
  } catch {
    return undefined;
  }
}
