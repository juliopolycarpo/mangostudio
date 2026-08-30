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
   * Skills, which are also listed in `slash_commands` rather than under a
   * heading of their own — a skill is invoked as `/name` like anything else.
   * Read by `initSlashCommands` only on a build that never named its own
   * `terminal_slash_commands` exclusion list, as one of the three provenance
   * statements that make a subset of `slash_commands` safe to publish
   * without one.
   */
  readonly skills?: unknown;
  /**
   * Marketplace plugins this run loaded, each carrying at least its own
   * `name` — never observed non-empty in a recorded fixture. Read the same
   * way `initSlashCommands` reads everything else: a plugin's own commands
   * are namespaced `plugin:command`, and matching that prefix here is what
   * tells a plugin's command apart from a CLI builtin that happens to
   * contain a colon.
   */
  readonly plugins?: unknown;
}

/**
 * `system/permission_denied` — the vendor's own statement of why a call was
 * refused, reported before the `tool_result` that closes the call arrives.
 */
export interface ClaudePermissionDeniedRecord extends ClaudeStreamRecord {
  readonly tool_use_id?: unknown;
  readonly tool_name?: unknown;
  readonly message?: unknown;
}

/** One block inside an `assistant` or `user` message. */
export interface ClaudeContentBlock {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly thinking?: unknown;
  readonly name?: unknown;
  readonly id?: unknown;
  readonly input?: unknown;
  readonly tool_use_id?: unknown;
  readonly is_error?: unknown;
  readonly content?: unknown;
}

export interface ClaudeMessageRecord extends ClaudeStreamRecord {
  readonly message?: {
    /** Shared by every block of this message, streamed or not — see `parentToolUseId`'s sibling use in the reducer. */
    readonly id?: unknown;
    readonly role?: unknown;
    readonly content?: unknown;
  };
}

/** `stream_event` — a raw Anthropic streaming event, forwarded verbatim. */
export interface ClaudeStreamEventRecord extends ClaudeStreamRecord {
  readonly event?: {
    readonly type?: unknown;
    readonly index?: unknown;
    /** Present on `message_start`; correlates the deltas that follow to the completed record they will duplicate. */
    readonly message?: { readonly id?: unknown };
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
  /**
   * The vendor's own explanation for why the run ended — `max_turns`,
   * `aborted_streaming`, `hook_stopped`, `prompt_too_long`, `budget_exhausted`,
   * among others. Read as a fallback: `errors` and `result` are prose written
   * for a human, this is a stable code written for a caller.
   */
  readonly terminal_reason?: unknown;
  /**
   * The error arm's own explanation. `error_max_turns`, `error_during_execution`,
   * `error_max_budget_usd` and `error_max_structured_output_retries` carry their
   * text here and have no `result` field at all — reading only `result`, which
   * is where the success arm puts its text, left every one of these showing the
   * generic fallback message instead of what actually happened.
   */
  readonly errors?: unknown;
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
 * `undefined` when the run did not state that list in a shape this can read.
 *
 * Absent counts as unreadable, and that is the whole point. `2.1.226` — a build
 * inside this adapter's supported range, and the one every fixture here was
 * recorded from — announces `doctor`, `color`, `clear` and `heapdump` in
 * `slash_commands` and carries no `terminal_slash_commands` at all. Reading
 * absence as "this run excluded nothing" would publish exactly those names as
 * usable on every build that predates the field.
 */
function terminalOnlyCommands(record: ClaudeInitRecord): ReadonlySet<string> | undefined {
  const names = record.terminal_slash_commands;
  if (!Array.isArray(names)) return undefined;
  return new Set(names.filter((value): value is string => typeof value === 'string'));
}

/**
 * Every plugin's own name, off `init.plugins` — never observed non-empty in a
 * recorded fixture, so this reads it exactly as defensively as every other
 * field here: an array of objects, each read for a `name` string and nothing
 * assumed about the rest of its shape.
 */
function pluginNames(record: ClaudeInitRecord): ReadonlySet<string> {
  const plugins = record.plugins;
  if (!Array.isArray(plugins)) return new Set();
  return new Set(
    plugins
      .map((plugin) =>
        typeof plugin === 'object' && plugin !== null
          ? (plugin as { readonly name?: unknown }).name
          : undefined
      )
      .filter((name): name is string => typeof name === 'string')
  );
}

/**
 * Whether `name`'s own origin is stated by this record, rather than guessed.
 *
 * Three shapes, each a statement about where the CLI read the name from
 * rather than a guess about whether it happens to work outside a terminal: a
 * user skill (`skills` repeats every skill name also present in
 * `slash_commands`), a plugin's own command (`plugin:command`, namespaced
 * with the `:` Claude Code — and only Claude Code — uses, matched against the
 * plugin names above), or an MCP server's (`mcp__*`, the same prefix
 * `claudeActivityKind` recognizes for tool names). All three are user content
 * the vendor read off disk or a server; none of them is a CLI terminal
 * builtin, which is what makes them safe to publish without the exclusion
 * list that would normally vouch for that.
 */
function originIsKnown(
  name: string,
  skills: ReadonlySet<string>,
  plugins: ReadonlySet<string>
): boolean {
  if (skills.has(name)) return true;
  if (name.startsWith('mcp__')) return true;
  const separator = name.indexOf(':');
  return separator > 0 && plugins.has(name.slice(0, separator));
}

/**
 * The commands this run can expand, in the order the CLI announced them.
 *
 * A `__`-prefixed name is always withheld — the CLI's private plumbing,
 * `__remote-workflow` being not something a user types — and so is one
 * `terminal_slash_commands` names, when the run stated that list: the
 * vendor's own statement that a name needs the interactive terminal this
 * adapter does not give it.
 *
 * A run that did not state that list at all — a build older than the field,
 * or one that answered with something this cannot read — gets a narrower
 * catalog rather than none: only the names whose *origin* this same record
 * states, per {@link originIsKnown}. That is a statement about provenance,
 * not a guess about interactivity — a user skill named the same as a
 * terminal-only builtin (this machine has a `doctor` skill) still publishes,
 * because the record says it is a skill, regardless of what the *builtin*
 * `/doctor` would have been on a build new enough to say so.
 */
export function initSlashCommands(record: ClaudeInitRecord): readonly string[] | undefined {
  const names = record.slash_commands;
  if (!Array.isArray(names)) return undefined;
  const usable = names.filter(
    (value): value is string =>
      typeof value === 'string' && value.length > 0 && !value.startsWith('__')
  );
  const terminalOnly = terminalOnlyCommands(record);
  if (terminalOnly) return usable.filter((name) => !terminalOnly.has(name));

  const skills = new Set(
    Array.isArray(record.skills)
      ? record.skills.filter((value): value is string => typeof value === 'string')
      : []
  );
  const plugins = pluginNames(record);
  return usable.filter((name) => originIsKnown(name, skills, plugins));
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
